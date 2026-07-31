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
import type { ModelClient } from "../ai/client";
import { structuredModelOutput } from "../ai/client";
import { callParams, isRefusal } from "../anthropic/models";
import { modelRequestOptions } from "../anthropic/reliability";
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
  client: ModelClient,
  schema: T,
  system: string,
  user: string,
  model?: string,
  site: "generation" | "generationDesign" | "generationReview" = "generation",
  signal?: AbortSignal,
): Promise<z.infer<T>> {
  // OpenAI's Responses API adapter already owns its model routing, structured
  // output format, no-storage flag, timeout, and abort handling. The Anthropic
  // branch stays streamed because the SDK requires streaming for the 32-64K
  // output budgets used by multi-file generation.
  if (client.provider === "openai") {
    const parsed = await structuredModelOutput(
      client,
      site,
      schema,
      `generated_${site}`,
      system,
      user,
      null,
      signal,
    );
    if (!parsed) throw new Error("generation produced no structured output — retrying");
    return parsed as z.infer<T>;
  }

  const { output_config, ...params } = callParams(site, { model });
  const stream = client.sdk.messages.stream({
    ...params,
    output_config: { ...output_config, format: zodOutputFormat(schema) },
    system,
    messages: [{ role: "user", content: user }],
  }, modelRequestOptions(site, signal));
  let msg: Awaited<ReturnType<typeof stream.finalMessage>>;
  try {
    msg = await stream.finalMessage();
  } catch (err) {
    // The SDK validates structured output inside finalMessage, so a response
    // truncated by max_tokens surfaces here as "unterminated string" rather
    // than as a length problem. Relabel that one case; everything else
    // rethrows unchanged so typed SDK errors (rate limit, connection) keep
    // their class and stack.
    const detail = err instanceof Error ? err.message : String(err);
    if (!/json|parse|unterminated/i.test(detail)) throw err;
    throw new Error(`generation output was truncated or malformed (likely max_tokens) — retrying: ${detail}`, { cause: err });
  }
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
      anchors: z
        .array(z.number())
        .describe(
          "Other line numbers where a strong reviewer might legitimately raise THIS flaw — the enclosing function's signature, the `with`/`try` header, the top of the handler. For flaws that are about something ABSENT (no idempotency key, no lock, no retry bound) this matters most, because there is no single line containing the bug. Empty array if the flaw really is confined to its own lines.",
        ),
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

export async function generateDebug(
  client: ModelClient,
  difficulty: Difficulty,
  topic?: string,
  jd?: string,
  model?: string,
  signal?: AbortSignal,
): Promise<GeneratedDebug> {
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
  return streamStructured(client, GeneratedDebugSchema, system, user, model, "generation", signal);
}

// --- Design ---

const GeneratedDesignSchema = z.object({
  title: z.string(),
  prompt: z.string().describe("the design ask, as a realistic brief: the system, the scale, the constraints that matter"),
  rubric: z
    .array(
      z.object({
        id: z.string().describe("stable kebab-case id"),
        severity: z.enum(["critical", "major", "minor"]).describe("how central this dimension is to a competent answer"),
        failure: z.string().describe("the dimension, phrased as what goes wrong if the design ignores it"),
        explanation: z.string().describe("what a strong answer actually engages with here — mechanisms and numbers, not vocabulary"),
        keywords: z.array(z.string()).describe("lowercased signal words"),
      }),
    )
    .describe("3-5 scoring dimensions covering what separates a senior answer from a junior one"),
  tags: tagsField,

  // The design-mode oracle (spec B7). Debug and review prove a flaw is real by
  // executing it; design has nothing to execute, so instead it proves the
  // *rubric discriminates* — score a strong and a deliberately weak answer and
  // require them to land far apart. A rubric that rates both alike can't grade.
  strongAnswer: z
    .string()
    .describe("a genuinely senior design doc for this brief, 350-550 words: capacity math, named trade-offs argued both ways, failure modes reasoned through. Concise — it exists to test the rubric, not to be published"),
  weakAnswer: z
    .string()
    .describe("a plausible but shallow answer, 350-550 words: correct-sounding vocabulary, no numbers, trade-offs named but never argued, no failure analysis. NOT obviously bad — it should read fine to a non-expert"),
});
export type GeneratedDesign = z.infer<typeof GeneratedDesignSchema>;

export async function generateDesign(
  client: ModelClient,
  difficulty: Difficulty,
  topic?: string,
  jd?: string,
  model?: string,
  signal?: AbortSignal,
): Promise<GeneratedDesign> {
  const system = [
    "You author system-design interview problems and the rubric used to grade them.",
    "The brief should be concrete and scoped — a real system with real constraints, not 'design Twitter'.",
    "The rubric is the product: each dimension must be gradeable from a written answer, and must distinguish",
    "an engineer who has operated such a system from one who has read about it. Reward mechanisms, capacity",
    "math, and trade-offs argued in both directions; never reward naming a technology.",
    "",
    "Also write two sample answers — a strong one and a shallow one that sounds plausible. They are used to",
    "verify the rubric can actually tell them apart; a rubric that scores both alike is rejected.",
  ].join("\n");
  const user = [
    `Difficulty: ${difficulty}.`,
    topic ? `Topic: ${topic}.` : "",
    jd ? `Tailor the domain and seniority to this job description:\n${jd}` : "",
    "Produce one system-design problem with its rubric and the two sample answers.",
  ]
    .filter(Boolean)
    .join("\n");
  return streamStructured(client, GeneratedDesignSchema, system, user, model, "generationDesign", signal);
}

// --- Review ---

const GeneratedReviewSchema = z.object({
  title: z.string().describe("the PR title, as an engineer in a hurry would write it"),
  prompt: z
    .string()
    .describe(
      [
        "The PR description, 180-320 words, as written by an AI coding agent that is pleased with itself.",
        "Markdown: a '## Summary' paragraph, a '## Changes' bullet list walking file by file, and a",
        "'## Testing' section. Confident and thorough-sounding, and subtly misleading — it should claim",
        "the risky parts are handled ('added retry with backoff', 'defensive validation throughout',",
        "'verified locally against the staging queue'), name a concern it did NOT actually address, and",
        "never hint at where the real defects are. This is the thing that makes the exercise hard: the",
        "reviewer has to distrust a description that reads perfectly.",
      ].join(" "),
    ),
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
    .describe(
      "One entry per changed file, 3-5 files, in the order a reviewer would read them. Each file carries 40-90 diff lines: generous context around every change, not just the changed lines. Answer-key lines reference the new-file lineNo. Total across files should read like a real feature PR (roughly 150-320 added lines), because a reviewer's job is finding the defect in volume — a 6-line diff tests nothing.",
    ),
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

export async function generateReview(
  client: ModelClient,
  difficulty: Difficulty,
  topic?: string,
  jd?: string,
  model?: string,
  signal?: AbortSignal,
): Promise<GeneratedReview> {
  const system = [
    "You author code-review exercises: a large, plausible AI-generated PR (git diff) hiding planted flaws.",
    "The PR description should sound reasonable — the skill being trained is catching bugs in convincing AI slop.",
    "",
    "DOMAIN — pick something specific, and not the obvious one. Unless a topic or job description below says",
    "otherwise, do NOT write another payments/webhook/idempotency PR: that is where these problems drift by",
    "default and a bank full of them teaches one pattern. Reach for a different corner of a backend instead —",
    "job scheduling and cron drift, search indexing, CSV/bulk import, notification fan-out, feature-flag",
    "rollout, cache invalidation, pagination over a changing dataset, quota accounting, audit logging, file",
    "processing, seat/licence assignment, data export. Let the title read like that domain's PR, not a",
    "generic one.",
    "",
    "SIZE AND SHAPE — this is a feature PR, not a patch:",
    "- Touch 3-5 files the way a real change does: the module doing the work, a caller or route wired up to it,",
    "  a small helper or config, and a test file the author added. Order them as a reviewer would read them.",
    "- Every file gets generous context lines around its changes, so the reviewer is reading code in situ",
    "  rather than a keyhole view. Aim for 150-320 added lines across the PR.",
    "- Spread the changes: a reviewer who only reads the first hunk should miss something.",
    "",
    "AI SLOP — the noise the defects hide in. This is what makes the exercise real, so be generous with it:",
    "- Ceremony that does nothing: a class wrapping a single function, a config dict read once, an abstraction",
    "  with exactly one implementation, a helper that re-implements something stdlib already does.",
    "- Over-defensive code in the wrong places: None-checks on values that cannot be None, try/except around",
    "  code that cannot raise, re-validating an argument the caller already validated — while the input that",
    "  actually needs checking goes unchecked.",
    "- Comments and docstrings that narrate the obvious ('# increment the counter'), restate the signature,",
    "  or confidently describe behaviour the code does not have.",
    "- Plausible-but-pointless robustness: a retry around a pure function, a lock around a local variable,",
    "  a cache with no invalidation, logging so chatty it would bury a real signal in production.",
    "- Small inconsistencies a tired human wouldn't produce: two naming conventions in one file, a helper",
    "  defined twice under different names, an unused import or parameter left behind.",
    "",
    "CRITICAL — slop is NOT the graded flaws. The answer key contains only the 1-3 real defects: things that",
    "produce wrong behaviour, and that the test suite proves by failing. The slop is unreviewed noise that a",
    "sharp reviewer may well comment on (that is judged separately as a valid extra observation, not a miss).",
    "Never put a style nit or a redundant None-check in the answer key.",
    "",
    "Constraints: pure Python only (it is executed to verify the flaws — stdlib only, no network, no filesystem).",
    `Plant 1-3 realistic flaws, buried in the middle of the churn rather than in the first hunk: ${FLAW_MENU}.`,
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
  return streamStructured(client, GeneratedReviewSchema, system, user, model, "generationReview", signal);
}
