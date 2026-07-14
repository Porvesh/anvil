/**
 * Model-judgment layer for grading (spec §12). The deterministic matcher
 * (lib/grading/matcher.ts) decides caught/missed by line anchor; the model only
 * adds the judgment that code can't do on its own:
 *   - Review: are the user's *unmatched* comments real issues or false positives?
 *   - Debug: was the root cause fixed (vs. symptom-masked), and how was the approach?
 *   - Both: a human-readable headline + summary for the results screen.
 *
 * The stable problem context (code/diff + answer key) goes in a cached system
 * prefix; only the user's submission varies per request (spec §13 prompt caching).
 */
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { anthropic } from "./client";
import { MODELS, MAX_TOKENS } from "./models";
import type { AnswerKeyIssue, Problem, ReviewComment, RunRecord } from "../types";

// --- structured output schemas ---

const ReviewJudgmentSchema = z.object({
  headline: z.string().describe("One-line verdict for the results header, e.g. 'Solid instinct, one gap that matters'."),
  summary: z.string().describe("2-3 sentences summarizing how the review went."),
  assessments: z
    .array(
      z.object({
        index: z.number().describe("Index into the provided unmatched-comments list."),
        isRealIssue: z.boolean().describe("True if this comment identifies a genuine problem NOT in the answer key (a valid extra catch); false if it's a false positive / nitpick."),
        note: z.string().describe("Short reason for the verdict."),
      }),
    )
    .describe("One assessment per unmatched comment."),
});
export type ReviewJudgment = z.infer<typeof ReviewJudgmentSchema>;

const DebugJudgmentSchema = z.object({
  headline: z.string(),
  summary: z.string(),
  rootCauseFixed: z.boolean().describe("True if the edit fixes the underlying cause; false if it only masks the symptom."),
  approachScore: z.number().describe("0-100 rating of approach quality: root-cause fix, minimal iterations, no symptom-masking."),
  issues: z
    .array(
      z.object({
        issueId: z.string(),
        addressed: z.boolean().describe("Whether the user's edit actually resolves this seeded issue."),
        note: z.string(),
      }),
    )
    .describe("One entry per answer-key issue."),
});
export type DebugJudgment = z.infer<typeof DebugJudgmentSchema>;

/** Wrap the stable problem+answer-key text in a cached system prefix. */
function problemContext(body: string): { type: "text"; text: string; cache_control: { type: "ephemeral" } }[] {
  return [{ type: "text", text: body, cache_control: { type: "ephemeral" } }];
}

/** Render the answer key for the grader (server-side only — never sent to the browser). */
function renderAnswerKey(answerKey: AnswerKeyIssue[]): string {
  return answerKey
    .map(
      (i) =>
        `- [${i.id}] lines ${i.lineStart}-${i.lineEnd} (${i.severity}): ${i.failure}\n  Why it matters: ${i.explanation}`,
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// Review judgment
// ---------------------------------------------------------------------------

export async function judgeReview(
  problem: Problem,
  unmatched: ReviewComment[],
  /** Ids of seeded issues the matcher scored as caught / missed — the headline
   *  and summary MUST reflect this outcome, not just the unmatched comments. */
  outcome: { caughtIds: string[]; missedIds: string[] },
): Promise<ReviewJudgment> {
  const diffText = (problem.diff ?? [])
    .flatMap((h) => h.lines.map((l) => `${l.lineNo ?? ""}\t${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.content}`))
    .join("\n");

  const system = problemContext(
    [
      "You are grading a code-review exercise. The AI planted the flaws, so the answer key below is ground truth.",
      "",
      `PR: ${problem.title}`,
      `Description: ${problem.prompt}`,
      "",
      "DIFF (line numbers are the new-file coordinate system):",
      diffText,
      "",
      "ANSWER KEY (the seeded issues — the user never sees this):",
      renderAnswerKey(problem.answerKey),
    ].join("\n"),
  );

  const unmatchedText = unmatched.length
    ? unmatched.map((c, idx) => `[${idx}] line ${c.line}: ${c.body}`).join("\n")
    : "(none)";

  const byId = new Map(problem.answerKey.map((i) => [i.id, i]));
  const describe = (ids: string[]) =>
    ids.length ? ids.map((id) => `- ${byId.get(id)?.failure ?? id}`).join("\n") : "(none)";

  const result = await anthropic.messages.parse({
    model: MODELS.grading,
    max_tokens: MAX_TOKENS.grade,
    system,
    messages: [
      {
        role: "user",
        content: [
          "The deterministic matcher already scored this review. THE OUTCOME BELOW IS GROUND TRUTH —",
          "your headline and summary must accurately reflect it (what was caught vs. missed). Do not",
          "claim issues were caught if they appear under MISSED.",
          "",
          `SEEDED ISSUES CAUGHT (${outcome.caughtIds.length}/${problem.answerKey.length}):`,
          describe(outcome.caughtIds),
          "",
          `SEEDED ISSUES MISSED (${outcome.missedIds.length}/${problem.answerKey.length}):`,
          describe(outcome.missedIds),
          "",
          "Separately, the user's line comments that did NOT anchor to any seeded issue are below.",
          "For each, decide whether it's a genuine issue we didn't seed (a valid extra catch) or a false positive / nitpick.",
          "",
          "UNMATCHED COMMENTS:",
          unmatchedText,
          "",
          "Write a headline + summary for the results screen that reflects the true outcome — encouraging but honest.",
        ].join("\n"),
      },
    ],
    output_config: { format: zodOutputFormat(ReviewJudgmentSchema) },
  });

  return result.parsed_output ?? { headline: "Review graded", summary: "", assessments: [] };
}

// ---------------------------------------------------------------------------
// Debug judgment
// ---------------------------------------------------------------------------

export async function judgeDebug(
  problem: Problem,
  finalCode: string,
  runHistory: RunRecord[],
  testsPassed: boolean,
): Promise<DebugJudgment> {
  const system = problemContext(
    [
      "You are grading a debugging exercise. The answer key below is ground truth — the AI planted the flaws.",
      "",
      `Problem: ${problem.title}`,
      `Symptom: ${problem.prompt}`,
      "",
      "ORIGINAL (buggy) CODE:",
      problem.starterCode ?? "",
      "",
      "ANSWER KEY (the seeded flaws):",
      renderAnswerKey(problem.answerKey),
    ].join("\n"),
  );

  const runSummary = runHistory.length
    ? runHistory.map((r, i) => `Run ${i + 1}: ${r.passed} passed / ${r.failed} failed`).join("\n")
    : "(no runs recorded)";

  const result = await anthropic.messages.parse({
    model: MODELS.grading,
    max_tokens: MAX_TOKENS.grade,
    system,
    messages: [
      {
        role: "user",
        content: [
          `Objective result: the test suite ${testsPassed ? "PASSES" : "does NOT pass"} on the final submission.`,
          "",
          "FINAL SUBMITTED CODE:",
          finalCode,
          "",
          "RUN HISTORY (iteration count is a quality signal):",
          runSummary,
          "",
          "For each answer-key issue, say whether the edit actually resolves it. Judge whether the fix targets the",
          "root cause or merely masks the symptom, and rate the approach 0-100. Then write a headline + summary.",
        ].join("\n"),
      },
    ],
    output_config: { format: zodOutputFormat(DebugJudgmentSchema) },
  });

  return (
    result.parsed_output ?? {
      headline: "Debug graded",
      summary: "",
      rootCauseFixed: testsPassed,
      approachScore: testsPassed ? 70 : 30,
      issues: problem.answerKey.map((i) => ({ issueId: i.id, addressed: testsPassed, note: "" })),
    }
  );
}
