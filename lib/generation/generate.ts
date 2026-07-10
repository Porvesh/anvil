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

/**
 * Stream a structured-output generation and return the validated object.
 * Streaming is required for the large multi-file outputs (SDK refuses
 * non-streaming above ~16K max_tokens); we collect the final message and
 * validate its JSON against the schema.
 */
async function streamStructured<T extends z.ZodTypeAny>(schema: T, system: string, user: string): Promise<z.infer<T>> {
  const stream = anthropic.messages.stream({
    model: MODELS.generation,
    max_tokens: MAX_TOKENS.generation,
    thinking: { type: "adaptive" },
    // Low effort keeps latency sane (unbounded thinking made this 2-6 min); the
    // execute-to-verify self-check is what guarantees quality, not deep thinking.
    output_config: { format: zodOutputFormat(schema), effort: "low" },
    system,
    messages: [{ role: "user", content: user }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "max_tokens") {
    throw new Error("generation truncated (hit max_tokens) — retrying");
  }
  const text = msg.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new Error("generation produced no text output — retrying");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("generation produced invalid JSON — retrying");
  }
  return schema.parse(json);
}

const fileSchema = z.object({
  path: z.string().describe("relative path within the project, e.g. 'billing/invoice.py'"),
  content: z.string(),
  readOnly: z.boolean().describe("true for fixture/neighbour files the user should NOT edit (models, configs, the module the bug is NOT in)"),
});

const answerKeyField = z
  .array(
    z.object({
      id: z.string().describe("stable kebab-case id"),
      file: z.string().describe("path of the file the flaw lives in (debug: the buggy module; review: the diff file)"),
      lineStart: z.number().describe("1-based line within `file` (debug) / diff new-file numbering (review)"),
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
  prompt: z.string().describe("the symptom the user sees, as an incident/bug report — no spoilers about the cause"),
  setup: z.string().describe("Python run before the tests: imports the project package + defines fixtures (e.g. `from billing.invoice import invoice_total`)"),
  correctFiles: z.array(fileSchema).describe("the correct multi-file project (a Python package: __init__.py + 2-4 modules) that passes all tests"),
  buggyFiles: z.array(fileSchema).describe("SAME file paths as correctFiles, but with 1-3 realistic flaws injected into ONE module — this is what the user edits"),
  cases: z
    .array(z.object({ name: z.string(), body: z.string().describe("Python asserting against the imported project; fails on the bug") }))
    .describe("tests that PASS on correctFiles and FAIL on buggyFiles"),
  answerKey: answerKeyField,
});
export type GeneratedDebug = z.infer<typeof GeneratedDebugSchema>;

export async function generateDebug(difficulty: Difficulty, topic?: string, jd?: string): Promise<GeneratedDebug> {
  const system = [
    "You author debugging exercises that feel like real production code, for an interview-practice tool.",
    "Constraints: pure Python only (runs in Pyodide — no network, no filesystem, no third-party packages beyond stdlib).",
    "Structure the code as a REAL multi-file package, not one script: an __init__.py plus 2-4 modules that import each other",
    "(e.g. models/types in one module, the core logic in another, a small helper). Mark files the user shouldn't edit as readOnly",
    "(the neighbouring modules, fixtures) and leave the module containing the bug editable. The `setup` imports the package.",
    `Inject 1-3 realistic flaws of the kind that pass a casual read: ${FLAW_MENU}.`,
    "correctFiles and buggyFiles MUST share identical paths. Tests MUST pass on correctFiles and FAIL on buggyFiles.",
    "In the answer key, set `file` to the buggy module's path and lineStart/lineEnd to the 1-based lines within that file.",
  ].join("\n");
  const user = [
    `Difficulty: ${difficulty}.`,
    topic ? `Topic: ${topic}.` : "",
    jd ? `Tailor the domain, stack, and seniority to this job description:\n${jd}` : "",
    "Produce one realistic multi-file debug problem.",
  ]
    .filter(Boolean)
    .join("\n");
  return streamStructured(GeneratedDebugSchema, system, user);
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
  const system = [
    "You author code-review exercises: a plausible AI-generated PR (git diff) hiding planted flaws.",
    "The PR description should sound reasonable — the skill being trained is catching bugs in convincing AI slop.",
    "Make it realistic: the PR should touch 1-2 files (a real change often spans more than one), with proper context lines.",
    `Plant 1-3 realistic flaws: ${FLAW_MENU}.`,
    "Use context/add/del diff lines. Every add/context line has a new-file lineNo; del lines have lineNo null.",
    "In the answer key, set `file` to the diff file path and lineStart/lineEnd to the new-file lineNo where the flaw lives.",
  ].join("\n");
  const user = [
    `Difficulty: ${difficulty}.`,
    topic ? `Topic: ${topic}.` : "",
    jd ? `Tailor the domain to this job description:\n${jd}` : "",
    "Produce one realistic code-review problem.",
  ]
    .filter(Boolean)
    .join("\n");
  return streamStructured(GeneratedReviewSchema, system, user);
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
