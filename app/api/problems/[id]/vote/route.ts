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

  const existing = await prisma.vote.findUnique({
    where: { problemId_sessionId: { problemId: id, sessionId } },
  });
  const previous = (existing?.value ?? 0) as 1 | -1 | 0;
  const { up, down, resulting } = voteDeltas(previous, value);

  // Apply the vote row + atomic tally deltas together.
  const [, updated] = await prisma.$transaction([
    resulting === 0
      ? prisma.vote.delete({ where: { problemId_sessionId: { problemId: id, sessionId } } })
      : prisma.vote.upsert({
          where: { problemId_sessionId: { problemId: id, sessionId } },
          create: { problemId: id, sessionId, value: resulting },
          update: { value: resulting },
        }),
    prisma.problem.update({
      where: { id },
      data: { upvotes: { increment: up }, downvotes: { increment: down } },
      select: { upvotes: true, downvotes: true, retired: true },
    }),
  ]);

  // Retirement is monotonic here: only auto-retire, never auto-revive (an
  // operator can un-retire deliberately). Cheap boolean flip, no delete.
  let retired = updated.retired;
  if (!retired && shouldRetire(updated.upvotes, updated.downvotes)) {
    await prisma.problem.update({ where: { id }, data: { retired: true } });
    retired = true;
  }

  return NextResponse.json({
    upvotes: updated.upvotes,
    downvotes: updated.downvotes,
    your: resulting,
    retired,
  });
}

/** GET — the caller's current vote on this problem (for restoring UI state). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sessionId = new URL(req.url).searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ your: 0 });
  const vote = await prisma.vote.findUnique({ where: { problemId_sessionId: { problemId: id, sessionId } } });
  return NextResponse.json({ your: vote?.value ?? 0 });
}
