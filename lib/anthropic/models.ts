/**
 * Per-call-site model routing (spec §15).
 *
 * The one thing to understand before changing anything here: **the judge is not
 * a cosmetic layer.** The score is assembled in code (INV-3), but every mode
 * feeds that arithmetic model-supplied inputs —
 *
 *   review → false-positive verdicts, at −12 points each
 *   debug  → `approachScore`, weighted 45% of the final number
 *   design → the entire number
 *
 * so a cheap judge is not a cheap judge, it is a wrong score. That is why the
 * grading calls sit on Sonnet 5 with thinking rather than the cheapest model
 * available, and why design (the one mode where the model owns the whole
 * number) runs an Opus ensemble.
 *
 * Each entry is a complete call config, not just an id, so no call site
 * hand-assembles parameters and drifts. Use `callParams()` to spread one into
 * an SDK request; it enforces the per-model thinking rules below.
 *
 * Model-specific rules this file encodes (verified against the current API):
 *  - Haiku 4.5 rejects `thinking` AND `effort` outright (400). It is therefore
 *    only used where neither helps: constrained tag extraction.
 *  - Sonnet 5 and Opus 5 run adaptive thinking *by default* — the historical
 *    workaround of omitting the parameter no longer disables anything, so
 *    "turn thinking on" is expressed here by simply not disabling it.
 *  - Opus 5 accepts `{type:"disabled"}` only at effort `high` or below; pairing
 *    it with `xhigh`/`max` is a 400.
 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface CallConfig {
  /** Exact current alias — never append a date suffix. */
  model: string;
  maxTokens: number;
  /**
   * Omitted means adaptive (the default on Sonnet 5 / Opus 5). Set explicitly
   * to "disabled" only where reasoning actively hurts the product.
   */
  thinking?: "adaptive" | "disabled";
  effort?: Effort;
  /** Why this routing — kept next to the decision so it survives a refactor. */
  why: string;
}

/** Models that 400 on `thinking` / `effort`, so those params must be omitted. */
const NO_THINKING_MODELS = new Set(["claude-haiku-4-5"]);

export const CALLS = {
  /**
   * Problem generation. The execution oracle proves the code runs and the bug
   * bites; it cannot tell you the bug is *interesting*. "Boring flaw", "typo
   * dressed as a design flaw", "findable with ctrl-F" all pass every gate and
   * then sit in the bank permanently. That unverifiable half is why generation
   * gets the strongest model.
   *
   * Effort is `medium`, not `high`: generation emits the whole project twice
   * plus tests plus the key, so thinking depth compounds against a 32k output
   * budget. Raise it if banked problems feel shallow — this is the first dial
   * to try, and the reject rate from the oracle is how you'll know.
   */
  generation: {
    model: "claude-opus-5",
    maxTokens: 32000,
    effort: "medium",
    why: "the oracle can't grade whether a bug is interesting; that failure is permanent",
  },

  /**
   * Design generation gets a bigger budget than debug: `max_tokens` bounds
   * thinking *and* output together, and a design problem emits a rubric plus
   * two complete sample answers.
   *
   * KNOWN ISSUE — the budget was raised on the theory that 32k was truncating
   * the JSON, but design generation still fails validation at ~4k characters,
   * so the real cause is elsewhere (the SDK's parse throws inside the stream's
   * message_stop handling, before stop_reason is inspectable). Diagnosis open;
   * debug and review generation are unaffected.
   */
  generationDesign: {
    model: "claude-opus-5",
    maxTokens: 64000,
    effort: "medium",
    why: "rubric + two sample answers + thinking; NB: design generation currently failing, see comment",
  },

  /**
   * Review generation needs the largest budget of the three modes.
   *
   * A convincing PR is not a 6-line patch: it spans several files, carries real
   * context lines, and buries its defects in plausible AI slop. On top of that
   * diff, the oracle needs the whole project twice (pre- and post-fix) plus a
   * test suite — so the output is roughly the diff plus two copies of every file
   * it touches. At 32k that ceiling was what forced one-file, +6/−1 PRs.
   */
  generationReview: {
    model: "claude-opus-5",
    maxTokens: 64000,
    effort: "medium",
    why: "a realistic PR is a multi-file diff plus both project states plus tests",
  },

  /**
   * Fallback when generation is refused. Opus 5 ships elevated cybersecurity
   * safeguards and this product deliberately authors security-flawed code
   * (SQL injection, auth bypass, unsafe deserialization are all on the flaw
   * menu), so benign generation requests can come back `stop_reason:
   * "refusal"`. See `isRefusal()` and the retry in lib/generation/index.ts.
   */
  generationFallback: {
    model: "claude-sonnet-5",
    maxTokens: 32000,
    effort: "medium",
    why: "Opus safety classifiers can decline deliberately-vulnerable code generation",
  },

  /**
   * Generation-side verification: is a claimed flaw genuinely present and
   * correctly located? A skeptic checking someone else's work, so it must not
   * be the same model that produced the work — self-verification here mostly
   * reproduces the generator's own blind spots.
   */
  verifyGenerated: {
    model: "claude-sonnet-5",
    maxTokens: 2048,
    effort: "high",
    why: "a gate on what enters the bank permanently; deliberately a different model than the generator",
  },

  /** Review judge: decides which unmatched comments are false positives, −12 each. */
  judgeReview: {
    model: "claude-sonnet-5",
    maxTokens: 2048,
    why: "each verdict moves the score 12 points; thinking is on by default here",
  },

  /** Debug judge: root-cause vs symptom-mask, and the 45%-weighted approachScore. */
  judgeDebug: {
    model: "claude-sonnet-5",
    maxTokens: 2048,
    why: "emits 45% of the debug score; root-cause discrimination improves markedly with thinking",
  },

  /**
   * Design judge. The only mode with no deterministic layer at all — the model
   * emits the whole number — so it gets the strongest model AND is run twice
   * with a divergence flag (see lib/grading/index.ts).
   */
  judgeDesign: {
    model: "claude-opus-5",
    maxTokens: 2048,
    effort: "high",
    why: "no deterministic floor under this score; run as an ensemble",
  },

  /** The post-grade teaching moment. This is the actual product. */
  socratic: {
    model: "claude-opus-5",
    maxTokens: 1024,
    effort: "medium",
    why: "the Socratic pass is the product; question quality is the whole value",
  },

  /**
   * Hints, deliberately capped below the judges.
   *
   * INV-5 stops a hint from *seeing* the answer key — that is structural and
   * holds at any model strength. What it does not stop is a strong model
   * independently solving the problem and handing over the answer, which
   * defeats the exercise just as thoroughly. Thinking is disabled for the same
   * reason: a hint should name the region or the class of concern, never the
   * defect. Fix the prompt (escalating levels) before raising this.
   */
  hint: {
    model: "claude-sonnet-5",
    maxTokens: 1024,
    thinking: "disabled",
    effort: "low",
    why: "a stronger hint model just solves the problem for the user — de-spoiling is the constraint",
  },

  /**
   * JD → tag extraction. Haiku is *correct* here, not merely cheap: the output
   * is a zod enum over a closed vocabulary, and a stronger model produces
   * richer, more varied tags — which makes set-overlap matching worse, not
   * better. Consistency beats quality for this one call.
   */
  jdMatch: {
    model: "claude-haiku-4-5",
    maxTokens: 512,
    why: "constrained extraction over a fixed vocabulary; consistency > richness",
  },
} as const satisfies Record<string, CallConfig>;

export type CallSite = keyof typeof CALLS;

/**
 * Spread one call config into an SDK request:
 *
 *   anthropic.messages.parse({ ...callParams("judgeReview"), system, messages })
 *
 * Silently drops `thinking`/`effort` for models that reject them, so adding a
 * Haiku-backed call site can't 400 at runtime.
 */
export function callParams(site: CallSite, overrides: { model?: string } = {}) {
  const cfg: CallConfig = CALLS[site];
  const model = overrides.model ?? cfg.model;

  const params: {
    model: string;
    max_tokens: number;
    thinking?: { type: "adaptive" } | { type: "disabled" };
    output_config?: { effort: Effort };
  } = { model, max_tokens: cfg.maxTokens };

  if (NO_THINKING_MODELS.has(model)) return params;

  // Omitting `thinking` on Sonnet 5 / Opus 5 already means adaptive; state it
  // anyway so the intent survives a future default change.
  params.thinking = { type: cfg.thinking === "disabled" ? "disabled" : "adaptive" };
  if (cfg.effort) params.output_config = { effort: cfg.effort };
  return params;
}

/**
 * True when a response was declined by the safety classifiers rather than
 * completed. Returns HTTP 200 with an empty (or partial) content array, so code
 * that reads `content[0]` without checking this crashes on a refusal instead of
 * retrying. Relevant wherever we ask a model to write insecure code on purpose.
 */
export function isRefusal(msg: { stop_reason?: string | null }): boolean {
  return msg.stop_reason === "refusal";
}
