import type { ProblemType } from "../types";

/**
 * Pick a sensible exercise mode when the user leaves the track on "Any".
 * An explicit UI choice always wins. The fallback is intentionally small and
 * deterministic: review-shaped roles get a PR, architecture/performance roles
 * get a design brief, and implementation-heavy roles get a runnable bug.
 */
export function selectTailoredType(requested: ProblemType | undefined, jd: string): ProblemType {
  if (requested) return requested;
  if (/\b(code review|pull request|reviewing code|reviewers?|\bpr\b)\b/i.test(jd)) return "review";
  if (
    /\b(system design|architect(?:ure|ing)?|distributed|real[ -]?time|latency|streaming|throughput|scal(?:e|ing)|reliability)\b/i.test(
      jd,
    )
  ) {
    return "design";
  }
  return "debug";
}
