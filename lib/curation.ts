/**
 * Community curation policy (spec §16 v2: "public/shareable bank, upvoting good
 * problems"). Pure functions — no DB, no I/O — so the ranking and retirement
 * rules are testable in isolation and live in exactly one place.
 *
 * The idea: generation is a one-time cost, but not every generated problem is
 * good. Votes let the crowd surface the strong ones and bury the weak ones, so
 * over time the bank self-curates and we lean on the model less, not more.
 */

/** Minimum total votes before retirement can trigger — protects fresh problems
 *  from a couple of early downvotes killing them. */
export const RETIRE_MIN_VOTES = 5;

/** A problem retires when it has real signal AND is clearly net-negative. */
export function shouldRetire(upvotes: number, downvotes: number): boolean {
  const total = upvotes + downvotes;
  if (total < RETIRE_MIN_VOTES) return false;
  // Net-negative with a losing ratio: downvotes are a clear majority.
  return downvotes >= upvotes * 2 && downvotes > upvotes;
}

/**
 * Wilson lower bound of the positive-rating fraction (95% confidence). Ranks the
 * bank so a 9/10 problem beats a 50/60 one, and a single 1/0 can't top the list
 * on one vote — the standard "best-rated with few votes" ordering. Returns 0
 * for no votes so unrated problems sort below rated ones but above retired.
 */
export function wilsonScore(upvotes: number, downvotes: number): number {
  const n = upvotes + downvotes;
  if (n === 0) return 0;
  const z = 1.96;
  const phat = upvotes / n;
  const z2 = z * z;
  return (phat + z2 / (2 * n) - z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

/** Human-facing quality label for the bank UI. */
export function qualityLabel(upvotes: number, downvotes: number): { label: string; tone: "good" | "mixed" | "new" } {
  const n = upvotes + downvotes;
  if (n < 3) return { label: "new", tone: "new" };
  const score = wilsonScore(upvotes, downvotes);
  if (score >= 0.6) return { label: "community pick", tone: "good" };
  if (score >= 0.4) return { label: "mixed reviews", tone: "mixed" };
  return { label: "low rated", tone: "mixed" };
}

/**
 * Given a session's previous vote and the new one, return the deltas to apply to
 * the denormalized upvote/downvote tallies. Encapsulates the up→down switch, the
 * toggle-off (re-clicking the same vote clears it), and the first-vote cases —
 * all as atomic increments the caller applies with a single DB update.
 */
export function voteDeltas(
  previous: 1 | -1 | 0,
  next: 1 | -1,
): { up: number; down: number; resulting: 1 | -1 | 0 } {
  // Re-clicking the same direction toggles the vote off.
  if (previous === next) {
    return next === 1 ? { up: -1, down: 0, resulting: 0 } : { up: 0, down: -1, resulting: 0 };
  }
  const up = (next === 1 ? 1 : 0) - (previous === 1 ? 1 : 0);
  const down = (next === -1 ? 1 : 0) - (previous === -1 ? 1 : 0);
  return { up, down, resulting: next };
}
