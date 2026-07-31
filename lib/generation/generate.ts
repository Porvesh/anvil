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
import { callParams, isRefusal } from "../anthropic/models";
import { TagSchema } from "../tags";
import type { Difficulty } from "../types";

const FLAW_MENU =
  "off-by-one under a condition, unbounded retry/loop, race on shared state, silent exception swallow, subtle type coercion, a plausible-but-wrong fix, or a missing idempotency guard";

/**
 * Raised when the safety classifiers decline a generation request rather than
 * failing it. Distinct from a generic error because the correct response is
 * different: retrying the same prompt on the same model will be declined again,
 * so the caller re-runs it on the fallback model instead (spec §15).
 */
export class GenerationRefusedError extends Error {
  constructor(readonly category: string | null) {
    super(`generation refused by safety classifiers${category ? ` (${category})` : ""}`);
    this.name = "GenerationRefusedError";
  }
}

/**
 * Stream a structured-output generation and return the validated object.
 * Streaming is required for the large multi-file outputs (SDK refuses
 * non-streaming above ~16K max_tokens); we collect the final message and
 * validate its JSON against the schema.
 *
 * `model` overrides the configured generation model — used to re-run a refused
 * request on the fallback (see GenerationRefusedError).
 */
async function streamStructured<T extends z.ZodTypeAny>(
  schema: T,
  system: string,
  user: string,
  model?: string,
): Promise<z.infer<T>> {
  const { output_config, ...params } = callParams("generation", { model });
  const stream = anthropic.messages.stream({
    ...params,
    output_config: { ...output_config, format: zodOutputFormat(schema) },
    system,
    messages: [{ role: "user", content: user }],
  });
  const msg = await stream.finalMessage();
  // This product asks the model to write deliberately vulnerable code, so a
  // refusal is an expected outcome on a strong model, not an exceptional one.
  // It arrives as a normal 200 with empty content — reading content[0] without
  // this check would surface as a confusing "no text output" error.
  if (isRefusal(msg)) {
    throw new GenerationRefusedError(msg.stop_details?.category ?? null);
  }
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

/**
 * Topic tags, constrained to the closed vocabulary (lib/tags.ts) by a zod enum.
 * Emitted at generation time rather than by a later tagging pass so every
 * problem is born matchable — an untagged problem is invisible to JD
 * match-first, which is the mechanism that turns one user's tailored
 * generation into a shared asset.
 */
const tagsField = z
  .array(TagSchema)
  .describe("2-5 topic tags from the allowed set that best describe what this problem teaches");

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
  tags: tagsField,
});
export type GeneratedDebug = z.infer<typeof GeneratedDebugSchema>;

export async function generateDebug(difficulty: Difficulty, topic?: string, jd?: string, model?: string): Promise<GeneratedDebug> {
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
  return streamStructured(GeneratedDebugSchema, system, user, model);
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
  tags: tagsField,

  // A review problem is a correct/buggy pair like debug, so it can run through
  // the same execution oracle instead of being banked on the model's say-so
  // (spec B7). These are generation-time artifacts only — never persisted,
  // because `correctFiles` IS the answer and `cases` names would spoil the flaw.
  buggyFiles: z
    .array(fileSchema)
    .describe("the project AS IT IS AFTER this PR merges — the diff's add/context lines must reproduce these files exactly, at the same line numbers"),
  correctFiles: z
    .array(fileSchema)
    .describe("SAME paths as buggyFiles, but with the planted flaws fixed — the PR done right"),
  setup: z.string().describe("Python run before the tests: imports the package + defines fixtures"),
  cases: z
    .array(z.object({ name: z.string(), body: z.string().describe("Python asserting against the imported project") }))
    .describe("tests that PASS on correctFiles and FAIL on buggyFiles — proves the planted flaws are real"),
});
export type GeneratedReview = z.infer<typeof GeneratedReviewSchema>;

export async function generateReview(difficulty: Difficulty, topic?: string, jd?: string, model?: string): Promise<GeneratedReview> {
  const system = [
    "You author code-review exercises: a plausible AI-generated PR (git diff) hiding planted flaws.",
    "The PR description should sound reasonable — the skill being trained is catching bugs in convincing AI slop.",
    "Make it realistic: the PR should touch 1-2 files (a real change often spans more than one), with proper context lines.",
    "Constraints: pure Python only (it is executed to verify the flaws — stdlib only, no network, no filesystem).",
    `Plant 1-3 realistic flaws: ${FLAW_MENU}.`,
    "Use context/add/del diff lines. Every add/context line has a new-file lineNo; del lines have lineNo null.",
    "In the answer key, set `file` to the diff file path and lineStart/lineEnd to the new-file lineNo where the flaw lives.",
    "",
    "LINE NUMBERS ARE GRADED, so they must be exact:",
    "- buggyFiles is the post-merge state of the project. The diff's add/context lines for a file MUST be that file's",
    "  actual lines, at the actual line numbers — line 42 of the diff is line 42 of buggyFiles.",
    "- Every answer-key lineStart/lineEnd MUST point at a line that appears in the diff and contains the flaw itself,",
    "  not the line above or a blank line. A user who comments on the right line but a wrong number scores zero.",
    "- correctFiles has the same paths with the flaws fixed; the tests must pass there and fail on buggyFiles.",
  ].join("\n");
  const user = [
    `Difficulty: ${difficulty}.`,
    topic ? `Topic: ${topic}.` : "",
    jd ? `Tailor the domain to this job description:\n${jd}` : "",
    "Produce one realistic code-review problem.",
  ]
    .filter(Boolean)
    .join("\n");
  return streamStructured(GeneratedReviewSchema, system, user, model);
}
