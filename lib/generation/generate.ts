/**
 * Offline problem generation (spec §11). Sonnet starts from clean, correct code
 * and injects realistic flaws, emitting the answer key + (for debug) a test
 * suite alongside. Output is structured so it drops straight into the bank;
 * the self-check (lib/generation/selfcheck.ts) is what guarantees quality.
 *
 * This is the one-time, on-your-key cost — never in the request path.
 */
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { anthropic } from "../anthropic/client";
import { MODELS, MAX_TOKENS } from "../anthropic/models";
import type { Difficulty } from "../types";

const FLAW_MENU =
  "off-by-one under a condition, unbounded retry/loop, race on shared state, silent exception swallow, subtle type coercion, a plausible-but-wrong fix, or a missing idempotency guard";

const answerKeyField = z
  .array(
    z.object({
      id: z.string().describe("stable kebab-case id"),
      lineStart: z.number().describe("1-based line in the buggy code / diff new-file numbering"),
      lineEnd: z.number(),
      severity: z.enum(["critical", "major", "minor"]),
      failure: z.string().describe("the concrete failure this flaw causes"),
      explanation: z.string().describe("reasoning a strong reviewer would give"),
      keywords: z.array(z.string()).describe("lowercased signal words that indicate the user found this issue"),
    }),
  )
  .describe("one entry per seeded flaw (1-3 total)");

// --- Debug ---

const GeneratedDebugSchema = z.object({
  title: z.string(),
  prompt: z.string().describe("the symptom the user sees — no spoilers about the cause"),
  setup: z.string().describe("Python run before the solution: imports/fixtures/helpers, or empty string"),
  correctCode: z.string().describe("idiomatic, correct Python that passes all tests"),
  buggyCode: z.string().describe("the correct code with 1-3 realistic flaws injected — this is what the user edits"),
  cases: z
    .array(z.object({ name: z.string(), body: z.string().describe("Python asserting against the solution; fails on the bug") }))
    .describe("tests that PASS on correctCode and FAIL on buggyCode"),
  answerKey: answerKeyField,
});
export type GeneratedDebug = z.infer<typeof GeneratedDebugSchema>;

export async function generateDebug(difficulty: Difficulty, topic?: string, jd?: string): Promise<GeneratedDebug> {
  const res = await anthropic.messages.parse({
    model: MODELS.generation,
    max_tokens: MAX_TOKENS.generation,
    thinking: { type: "adaptive" },
    system: [
      "You author debugging exercises for an interview-practice tool.",
      "Constraints: pure Python only (runs in Pyodide — no network, no filesystem, no third-party packages beyond stdlib).",
      "The task must be small and self-contained. Setup may define helpers the solution calls.",
      `Inject 1-3 realistic flaws of the kind that pass a casual read: ${FLAW_MENU}.`,
      "Tests MUST pass on correctCode and FAIL on buggyCode. Line numbers in the answer key are 1-based against buggyCode.",
    ].join("\n"),
    messages: [
      {
        role: "user",
        content: [
          `Difficulty: ${difficulty}.`,
          topic ? `Topic: ${topic}.` : "",
          jd ? `Tailor the domain to this job description:\n${jd}` : "",
          "Produce one debug problem.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
    output_config: { format: zodOutputFormat(GeneratedDebugSchema) },
  });
  if (!res.parsed_output) throw new Error("generation returned no structured output");
  return res.parsed_output;
}

// --- Review ---

const GeneratedReviewSchema = z.object({
  title: z.string().describe("the PR title"),
  prompt: z.string().describe("the PR description — plausible, subtly misleading, hides the flaws"),
  prMeta: z.object({
    number: z.number(),
    branch: z.string(),
    additions: z.number(),
    deletions: z.number(),
    files: z.number(),
    aiGenerated: z.boolean(),
  }),
  diff: z
    .array(
      z.object({
        file: z.string(),
        lines: z.array(
          z.object({
            kind: z.enum(["context", "add", "del"]),
            lineNo: z.number().nullable().describe("new-file line number; null for deleted lines"),
            content: z.string(),
          }),
        ),
      }),
    )
    .describe("unified-diff hunks; answer-key lines reference the new-file lineNo"),
  answerKey: answerKeyField,
});
export type GeneratedReview = z.infer<typeof GeneratedReviewSchema>;

export async function generateReview(difficulty: Difficulty, topic?: string, jd?: string): Promise<GeneratedReview> {
  const res = await anthropic.messages.parse({
    model: MODELS.generation,
    max_tokens: MAX_TOKENS.generation,
    thinking: { type: "adaptive" },
    system: [
      "You author code-review exercises: a plausible AI-generated PR (git diff) hiding planted flaws.",
      "The PR description should sound reasonable — the skill being trained is catching bugs in convincing AI slop.",
      `Plant 1-3 realistic flaws: ${FLAW_MENU}.`,
      "Use context/add/del diff lines. Every add/context line has a new-file lineNo; del lines have lineNo null.",
      "Answer-key line numbers reference the new-file lineNo where the flaw lives.",
    ].join("\n"),
    messages: [
      {
        role: "user",
        content: [
          `Difficulty: ${difficulty}.`,
          topic ? `Topic: ${topic}.` : "",
          jd ? `Tailor the domain to this job description:\n${jd}` : "",
          "Produce one code-review problem.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
    output_config: { format: zodOutputFormat(GeneratedReviewSchema) },
  });
  if (!res.parsed_output) throw new Error("generation returned no structured output");
  return res.parsed_output;
}

// --- Review self-check (model-based; no executable oracle for review) ---

const ReviewVerdictSchema = z.object({
  issues: z.array(
    z.object({
      id: z.string(),
      present: z.boolean().describe("is this flaw genuinely present at the cited line in the diff?"),
      lineAccurate: z.boolean().describe("does lineStart/lineEnd point at the actual buggy line?"),
    }),
  ),
});

/** Verify a generated review problem: each seeded flaw is real and correctly located. */
export async function verifyReview(problem: GeneratedReview): Promise<{ ok: boolean; reason: string; qualityScore: number }> {
  const diffText = problem.diff
    .flatMap((h) => h.lines.map((l) => `${l.lineNo ?? ""}\t${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.content}`))
    .join("\n");

  const res = await anthropic.messages.parse({
    model: MODELS.generation,
    max_tokens: MAX_TOKENS.grade,
    system: [{ type: "text", text: "You verify that seeded code-review flaws are real and correctly located. Be skeptical." }],
    messages: [
      {
        role: "user",
        content: `DIFF:\n${diffText}\n\nCLAIMED FLAWS:\n${problem.answerKey
          .map((i) => `- [${i.id}] lines ${i.lineStart}-${i.lineEnd}: ${i.failure}`)
          .join("\n")}\n\nFor each, is it genuinely present and correctly located?`,
      },
    ],
    output_config: { format: zodOutputFormat(ReviewVerdictSchema) },
  });

  const verdicts = res.parsed_output?.issues ?? [];
  const good = verdicts.filter((v) => v.present && v.lineAccurate).length;
  const total = problem.answerKey.length || 1;
  const ratio = good / total;
  return {
    ok: ratio === 1,
    reason: `${good}/${total} flaws verified present + located`,
    qualityScore: ratio,
  };
}
