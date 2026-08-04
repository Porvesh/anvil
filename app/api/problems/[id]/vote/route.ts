import { type NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { resolveOwner } from "@/lib/auth/identity";
import { clientKey, rateLimit } from "@/lib/ratelimit";
import { voteDeltas } from "@/lib/curation";
import { recountProblemTallies } from "@/lib/voting";

export const runtime = "nodejs";

const bodySchema = z.object({
  sessionId: z.string().min(1),
  value: z.union([z.literal(1), z.literal(-1)]),
});

/**
 * POST /api/problems/[id]/vote — rate a problem 👍/👎 (spec §16 v2 curation).
 *
 * Idempotent and one-vote-per-voter: re-clicking the same direction toggles the
 * vote off, switching direction flips it. "Voter" means the account when signed
 * in — so a second device cannot double-vote — and the browser session when not,
 * which is what the two unique constraints on `Vote` encode.
 *
 * Everything runs in one interactive transaction and the tallies are recounted
 * from the `Vote` rows rather than incremented, so they cannot drift under
 * concurrent votes. When a problem crosses the retirement bar it is flagged (not
 * deleted) so the bank stops serving it.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const limit = rateLimit(clientKey(req));
  if (!limit.ok) return NextResponse.json({ error: "Rate limit exceeded — try again shortly." }, { status: 429 });

  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { value } = parsed.data;
  const owner = resolveOwner(req, parsed.data.sessionId);

  const problem = await prisma.problem.findUnique({ where: { id }, select: { id: true } });
  if (!problem) return NextResponse.json({ error: "Problem not found" }, { status: 404 });

  // Two ways to name "this voter's vote on this problem": by account when signed
  // in, by browser otherwise. `where` addresses the row through the matching
  // unique index; `mine` is the same predicate as a filter, for the delete paths.
  const where = owner.userId
    ? { problemId_userId: { problemId: id, userId: owner.userId } }
    : { problemId_sessionId: { problemId: id, sessionId: owner.sessionId } };
  const mine: Prisma.VoteWhereInput = owner.userId
    ? { problemId: id, userId: owner.userId }
    : { problemId: id, sessionId: owner.sessionId, userId: null };

  const result = await prisma.$transaction(async (tx) => {
    if (owner.userId) {
      // A signed-in vote supersedes any anonymous vote this same browser left on
      // the problem. Normally the sign-in merge already adopted it, but not when
      // the account was created in a different browser — and leaving it would
      // collide with the (problemId, sessionId) constraint on the write below.
      await tx.vote.deleteMany({ where: { problemId: id, sessionId: owner.sessionId, userId: null } });
    }

    const existing = await tx.vote.findUnique({ where });
    const previous = (existing?.value ?? 0) as 1 | -1 | 0;
    const { resulting } = voteDeltas(previous, value);

    if (resulting === 0) {
      // deleteMany (not delete) so a concurrent toggle-off that already removed
      // the row is a no-op rather than a P2025 that aborts the transaction.
      await tx.vote.deleteMany({ where: mine });
    } else {
      await tx.vote.upsert({
        where,
        create: { problemId: id, sessionId: owner.sessionId, userId: owner.userId, value: resulting },
        update: { value: resulting },
      });
    }

    const tallies = await recountProblemTallies(tx, id);
    return { ...tallies, your: resulting };
  });

  return NextResponse.json(result);
}

/** GET — the caller's current vote on this problem (for restoring UI state). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sessionId = new URL(req.url).searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ your: 0 });
  const owner = resolveOwner(req, sessionId);
  const vote = await prisma.vote.findFirst({
    where: { problemId: id, ...(owner.userId ? { userId: owner.userId } : { sessionId, userId: null }) },
    select: { value: true },
  });
  return NextResponse.json({ your: vote?.value ?? 0 });
}
