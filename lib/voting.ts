/**
 * Persistence for votes. `lib/curation.ts` holds the pure policy (what a vote
 * means, when a problem retires); this holds the one database operation that
 * applies it.
 *
 * It exists because two call sites change vote rows — casting a vote, and
 * adopting a browser's votes into an account at sign-in — and both have to
 * leave the denormalized tallies on `Problem` consistent. Recounting from the
 * `Vote` rows rather than incrementing means neither path can drift, however
 * many rows it touched.
 */
import type { Prisma } from "@prisma/client";
import { shouldRetire } from "./curation";

export interface Tallies {
  upvotes: number;
  downvotes: number;
  retired: boolean;
}

/**
 * Recount a problem's votes from source and write the tallies back.
 *
 * Must run inside the same transaction as the vote mutation, so the count sees
 * that mutation and no other. Retirement is one-way here: crossing the bar sets
 * the flag, but recovering votes never clears it — un-retiring stays a
 * deliberate operator action.
 */
export async function recountProblemTallies(
  tx: Prisma.TransactionClient,
  problemId: string,
): Promise<Tallies> {
  const [upvotes, downvotes] = await Promise.all([
    tx.vote.count({ where: { problemId, value: 1 } }),
    tx.vote.count({ where: { problemId, value: -1 } }),
  ]);

  const retire = shouldRetire(upvotes, downvotes);
  const updated = await tx.problem.update({
    where: { id: problemId },
    data: { upvotes, downvotes, ...(retire ? { retired: true } : {}) },
    select: { retired: true },
  });

  return { upvotes, downvotes, retired: updated.retired };
}
