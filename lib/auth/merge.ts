/**
 * Adopting a browser's anonymous work into an account.
 *
 * This is the reason accounts exist at all. Anvil is usable with no sign-up, so
 * by the time someone decides to create an account they already have attempts,
 * votes, and maybe a contribution receipt sitting under a localStorage uuid.
 * Signing in has to carry that history across, or the account costs the user
 * their record instead of protecting it.
 *
 * The merge only ever claims rows that are still unowned (`userId: null`), so it
 * is safe to run repeatedly and can never move another account's work.
 *
 * Votes are the one case with a genuine conflict: the account may already have
 * voted on a problem this browser also voted on. The account's own vote wins —
 * it is the deliberate, cross-device identity — and the anonymous duplicate is
 * deleted rather than adopted, which is also what the `(problemId, userId)`
 * unique index requires. Deleting a vote changes a tally, so every affected
 * problem is recounted inside the same transaction.
 */
import type { PrismaClient } from "@prisma/client";
import { recountProblemTallies } from "../voting";

export interface MergeSummary {
  attempts: number;
  votes: number;
  contributions: number;
  /** Anonymous votes dropped because the account had already voted. */
  discardedVotes: number;
}

export const EMPTY_MERGE: MergeSummary = { attempts: 0, votes: 0, contributions: 0, discardedVotes: 0 };

export async function mergeAnonymousWork(
  prisma: PrismaClient,
  { userId, sessionId }: { userId: string; sessionId: string | null | undefined },
): Promise<MergeSummary> {
  if (!sessionId) return { ...EMPTY_MERGE };

  return prisma.$transaction(async (tx) => {
    const [attempts, contributions] = await Promise.all([
      tx.attempt.updateMany({ where: { sessionId, userId: null }, data: { userId } }),
      tx.contribution.updateMany({ where: { sessionId, userId: null }, data: { userId } }),
    ]);

    const anonymousVotes = await tx.vote.findMany({
      where: { sessionId, userId: null },
      select: { id: true, problemId: true },
    });

    let adopted = 0;
    const discarded: string[] = [];

    if (anonymousVotes.length > 0) {
      const problemIds = anonymousVotes.map((vote) => vote.problemId);
      const owned = new Set(
        (
          await tx.vote.findMany({
            where: { userId, problemId: { in: problemIds } },
            select: { problemId: true },
          })
        ).map((vote) => vote.problemId),
      );

      for (const vote of anonymousVotes) {
        if (owned.has(vote.problemId)) {
          await tx.vote.delete({ where: { id: vote.id } });
          discarded.push(vote.problemId);
        } else {
          await tx.vote.update({ where: { id: vote.id }, data: { userId } });
          // Guard the pathological case of two anonymous rows for one problem
          // (possible only if the same browser voted before and after a prior
          // merge): the first adoption now owns it, so the next is a duplicate.
          owned.add(vote.problemId);
          adopted += 1;
        }
      }

      // Only deletions move a tally; adoption just relabels an existing row.
      for (const problemId of new Set(discarded)) {
        await recountProblemTallies(tx, problemId);
      }
    }

    return {
      attempts: attempts.count,
      contributions: contributions.count,
      votes: adopted,
      discardedVotes: discarded.length,
    };
  });
}
