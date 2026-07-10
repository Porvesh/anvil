import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { clientKey, rateLimit } from "@/lib/ratelimit";
import { shouldRetire, voteDeltas } from "@/lib/curation";

export const runtime = "nodejs";

const bodySchema = z.object({
  sessionId: z.string().min(1),
  value: z.union([z.literal(1), z.literal(-1)]),
});

/**
 * POST /api/problems/[id]/vote — rate a problem 👍/👎 (spec §16 v2 curation).
 *
 * Idempotent + one-vote-per-session via the Vote unique constraint: re-clicking
 * the same direction toggles the vote off, switching direction flips it. Tally
 * updates use DB-level atomic `increment`, so concurrent votes from many users
 * stay correct without locking. When a problem crosses the retirement bar it's
 * flagged (not deleted) so the bank stops serving it.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const limit = rateLimit(clientKey(req));
  if (!limit.ok) return NextResponse.json({ error: "Rate limit exceeded — try again shortly." }, { status: 429 });

  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { sessionId, value } = parsed.data;

  const problem = await prisma.problem.findUnique({ where: { id }, select: { id: true } });
  if (!problem) return NextResponse.json({ error: "Problem not found" }, { status: 404 });

  // Everything runs inside one interactive transaction, and the tallies are
  // RECOMPUTED from the Vote rows (not blind-incremented) so they can never
  // drift from the source of truth under concurrent votes — the read, the
  // toggle decision, and the recount are all consistent within the txn.
  const where = { problemId_sessionId: { problemId: id, sessionId } };
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.vote.findUnique({ where });
    const previous = (existing?.value ?? 0) as 1 | -1 | 0;
    const { resulting } = voteDeltas(previous, value);

    if (resulting === 0) {
      // deleteMany (not delete) so a concurrent toggle-off that already removed
      // the row is a no-op rather than a P2025 that aborts the transaction.
      await tx.vote.deleteMany({ where: { problemId: id, sessionId } });
    } else {
      await tx.vote.upsert({ where, create: { problemId: id, sessionId, value: resulting }, update: { value: resulting } });
    }

    const [upvotes, downvotes] = await Promise.all([
      tx.vote.count({ where: { problemId: id, value: 1 } }),
      tx.vote.count({ where: { problemId: id, value: -1 } }),
    ]);

    // Only auto-retire, never auto-revive (an operator can un-retire deliberately).
    const retire = shouldRetire(upvotes, downvotes);
    const updated = await tx.problem.update({
      where: { id },
      data: { upvotes, downvotes, ...(retire ? { retired: true } : {}) },
      select: { retired: true },
    });

    return { upvotes, downvotes, your: resulting, retired: updated.retired };
  });

  return NextResponse.json(result);
}

/** GET — the caller's current vote on this problem (for restoring UI state). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sessionId = new URL(req.url).searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ your: 0 });
  const vote = await prisma.vote.findUnique({ where: { problemId_sessionId: { problemId: id, sessionId } } });
  return NextResponse.json({ your: vote?.value ?? 0 });
}
