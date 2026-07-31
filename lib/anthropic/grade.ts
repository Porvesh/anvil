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
import { callParams } from "./models";
import type { AnswerKeyIssue, Problem, ReviewComment, RunRecord, SolutionFile } from "../types";

// --- structured output schemas ---

const ReviewJudgmentSchema = z.object({
  headline: z.string().describe("One-line verdict for the results header, e.g. 'Solid instinct, one gap that matters'."),
  summary: z.string().describe("2-3 sentences summarizing how the review went."),
  assessments: z
    .array(
      z.object({
        index: z.number().describe("Index into the provided unmatched-comments list."),
        isRealIssue: z.boolean().describe("True if this comment identifies a genuine problem NOT in the answer key (a valid extra catch); false if it's a false positive / nitpick."),
        matchedIssueId: z
          .string()
          .nullable()
          .describe(
            "If this comment is actually describing one of the MISSED seeded issues (the reviewer identified the flaw but commented at the function signature, the block header, or another conceptual site rather than the exact line), give that issue's id. Otherwise null. Only ever cite an id from the MISSED list.",
          ),
        note: z.string().describe("Short reason for the verdict."),
      }),
    )
    .describe("One assessment per unmatched comment."),
});
export type ReviewJudgment = z.infer<typeof ReviewJudgmentSchema>;

const DesignJudgmentSchema = z.object({
  headline: z.string(),
  summary: z.string(),
  depthScore: z
    .number()
    .describe("0-100 rating of design depth: capacity math shown, trade-offs argued (not just named), failure modes reasoned through."),
  aspects: z
    .array(
      z.object({
        issueId: z.string(),
        addressed: z.boolean().describe("True only if the doc substantively addresses this rubric aspect — naming the buzzword alone does not count."),
        note: z.string().describe("Short quote or reason supporting the verdict."),
      }),
    )
    .describe("One entry per rubric aspect in the answer key."),
});
export type DesignJudgment = z.infer<typeof DesignJudgmentSchema>;

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

  // The file matters on a multi-file PR: two comments can both be "line 42", and
  // without the path the judge can't tell which code either one is about.
  const unmatchedText = unmatched.length
    ? unmatched.map((c, idx) => `[${idx}] ${c.file ? `${c.file} ` : ""}line ${c.line}: ${c.body}`).join("\n")
    : "(none)";

  const byId = new Map(problem.answerKey.map((i) => [i.id, i]));
  // Missed issues are listed WITH their ids so the judge can cite one back as a
  // matchedIssueId; caught issues deliberately aren't, since nothing may be
  // re-credited to an issue the matcher already scored.
  const describe = (ids: string[], withIds = false) =>
    ids.length
      ? ids.map((id) => `- ${withIds ? `[${id}] ` : ""}${byId.get(id)?.failure ?? id}`).join("\n")
      : "(none)";

  const result = await anthropic.messages.parse({
    ...callParams("judgeReview"),
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
          describe(outcome.missedIds, true),
          "",
          "Below are the user's line comments that did NOT anchor to any seeded issue. For each, decide two things:",
          "",
          "1. Is it a genuine issue we didn't seed (a valid extra catch), or a false positive / nitpick?",
          "2. Does it actually describe one of the MISSED issues above? The matcher works on line numbers, so a",
          "   reviewer who correctly identified a flaw but commented at the function signature or the top of the",
          "   block — rather than the exact line — shows up here as unmatched. If so, set matchedIssueId to that",
          "   issue's id and it will be re-credited as caught. Require that the comment demonstrates the SAME",
          "   insight, not merely that it sits near the same code; a vague remark on an adjacent line is not a catch.",
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
// Design judgment
// ---------------------------------------------------------------------------

/** Render the design rubric (answer key) without line coordinates — design
 *  aspects aren't line-anchored. */
function renderRubric(answerKey: AnswerKeyIssue[]): string {
  return answerKey
    .map((i) => `- [${i.id}] (${i.severity}) ${i.failure}\n  A strong answer covers: ${i.explanation}`)
    .join("\n");
}

export async function judgeDesign(problem: Problem, doc: string): Promise<DesignJudgment> {
  const system = problemContext(
    [
      "You are grading a system-design exercise against a seeded rubric. The rubric below is ground truth.",
      "Judge substance, not vocabulary: an aspect counts as addressed only if the doc engages with the actual problem",
      "(numbers, mechanisms, trade-offs), not because it name-drops the term.",
      "",
      `PROBLEM: ${problem.title}`,
      `DESIGN ASK: ${problem.prompt}`,
      "",
      "RUBRIC (the seeded aspects — the user never sees this):",
      renderRubric(problem.answerKey),
    ].join("\n"),
  );

  const result = await anthropic.messages.parse({
    ...callParams("judgeDesign"),
    system,
    messages: [
      {
        role: "user",
        content: [
          "THE CANDIDATE'S DESIGN DOC:",
          doc,
          "",
          "For each rubric aspect, decide whether the doc substantively addresses it (quote the evidence in your note).",
          "Rate overall depth 0-100. Then write a headline + summary for the results screen — encouraging but honest.",
        ].join("\n"),
      },
    ],
    output_config: { format: zodOutputFormat(DesignJudgmentSchema) },
  });

  return (
    result.parsed_output ?? {
      headline: "Design graded",
      summary: "",
      depthScore: 50,
      aspects: problem.answerKey.map((i) => ({ issueId: i.id, addressed: false, note: "" })),
    }
  );
}

// ---------------------------------------------------------------------------
// Debug judgment
// ---------------------------------------------------------------------------

/** Render a multi-file project as a single annotated blob for the model. */
function renderFiles(files: { path: string; content: string }[]): string {
  return files.map((f) => `----- ${f.path} -----\n${f.content}`).join("\n\n");
}

export async function judgeDebug(
  problem: Problem,
  finalFiles: SolutionFile[],
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
      "ORIGINAL (buggy) PROJECT:",
      renderFiles(problem.files ?? []),
      "",
      "ANSWER KEY (the seeded flaws):",
      renderAnswerKey(problem.answerKey),
    ].join("\n"),
  );

  const runSummary = runHistory.length
    ? runHistory.map((r, i) => `Run ${i + 1}: ${r.passed} passed / ${r.failed} failed`).join("\n")
    : "(no runs recorded)";

  const result = await anthropic.messages.parse({
    ...callParams("judgeDebug"),
    system,
    messages: [
      {
        role: "user",
        content: [
          `Objective result: the test suite ${testsPassed ? "PASSES" : "does NOT pass"} on the final submission.`,
          "",
          "FINAL SUBMITTED PROJECT:",
          renderFiles(finalFiles),
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
