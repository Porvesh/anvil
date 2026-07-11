/**
 * Model layer configuration (spec §8, §13).
 *
 * Generation is the offline, one-time cost (richer model); grading + the
 * Socratic follow-up run in the request path on the cheap, fast model. IDs are
 * the exact current aliases — do not append date suffixes.
 *
 * Note: Haiku 4.5 does NOT support the `thinking`/`effort` parameters (they
 * 400), so grading/Socratic calls omit them. Sonnet 5 supports adaptive
 * thinking for the harder generation + self-check work.
 */
export const MODELS = {
  /** Offline problem generation + self-check. */
  generation: "claude-sonnet-5",
  /** In-request grading and Socratic follow-up — pennies per session. */
  grading: "claude-haiku-4-5",
} as const;

/** Max output tokens per call type (kept modest — these are cheap, quick calls). */
export const MAX_TOKENS = {
  grade: 2048,
  socratic: 1024,
  generation: 16000,
} as const;
