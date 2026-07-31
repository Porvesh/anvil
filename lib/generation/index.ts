/**
 * Shared generate → self-check → persist pipeline (spec §11), used by BOTH the
 * offline CLI (scripts/generate-bank.ts) and the worker tier. One place owns
 * "make a real, verified problem and put it in the bank".
 *
 * Both debug and review problems are executed (python3) so a hallucinated bug
 * can't enter the bank. Only problems that pass persist.
 */
import type { PrismaClient } from "@prisma/client";
import type { AnswerKeyIssue, Difficulty, ProblemType } from "../types";
import type { ModelClient } from "../ai/client";
import { anthropicModelClient, modelFor } from "../ai/client";
import { anthropic } from "../anthropic/client";
import { CALLS } from "../anthropic/models";
import { isAbortError } from "../anthropic/reliability";
import { parseTags } from "../tags";
import { GenerationRefusedError, generateDebug, generateDesign, generateReview } from "./generate";
import { selfCheckDebug, selfCheckDesign, selfCheckReview } from "./selfcheck";

export interface GenerateOpts {
  type: ProblemType;
  difficulty: Difficulty;
  topic?: string;
  jd?: string;
  maxAttempts?: number;
  /** Request-scoped for BYOK; omitted by trusted CLI/worker generation. */
  client?: ModelClient;
  signal?: AbortSignal;
  /** GenerationJob this run belongs to, recorded on the row for provenance. */
  jobId?: string;
  /** Called with a one-line progress note per attempt (CLI logging, SSE phases). */
  onProgress?: (note: string) => void;
}

export interface GenerateResult {
  id: string;
  title: string;
  qualityScore: number;
  attempts: number;
  /** Which model actually produced it — may be the fallback after a refusal. */
  generatorModel: string;
}

/**
 * Generate one verified problem and persist it. Returns null if every attempt
 * failed its gates (the caller decides how to surface that).
 *
 * Two distinct retry reasons are handled differently:
 *  - a *rejection* (failed the oracle, unusable file layout) retries the same
 *    model, since generation is stochastic and the next draw may pass;
 *  - a *refusal* switches to the fallback model, because re-asking the same
 *    model the same question gets declined again. This product deliberately
 *    authors vulnerable code, so refusals are expected, not exceptional.
 */
export async function generateAndPersist(prisma: PrismaClient, opts: GenerateOpts): Promise<GenerateResult | null> {
  const { type, difficulty, topic, jd, maxAttempts = 3, jobId, onProgress, signal } = opts;
  const note = (msg: string) => onProgress?.(msg);
  const client = opts.client ?? anthropicModelClient(anthropic);

  // Explicit model overrides belong only to Anthropic's refusal fallback. The
  // provider adapter owns OpenAI routing, so a BYOK request can never inherit
  // an Anthropic model slug.
  let model: string | undefined = client.provider === "anthropic" ? CALLS.generation.model : undefined;
  const site = type === "design" ? "generationDesign" : type === "review" ? "generationReview" : "generation";
  const generatedBy = () => model ?? modelFor(client, site);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (type === "debug") {
        const p = await generateDebug(client, difficulty, topic, jd, model, signal);

        // The file(s) the answer key points at ARE where the user must edit — force
        // them editable so the model can't accidentally ship an unsolvable problem
        // by marking the buggy module readOnly. If the key references no real file,
        // we can't guarantee solvability — reject and retry.
        const buggyPaths = new Set(p.answerKey.map((i) => i.file).filter((f): f is string => !!f));
        const files = p.buggyFiles.map((f) => (buggyPaths.has(f.path) ? { ...f, readOnly: false } : f));
        const bugFileIsEditable = files.some((f) => buggyPaths.has(f.path) && !f.readOnly);
        if (!bugFileIsEditable) {
          note(`attempt ${attempt}: rejected — answer key points at no editable file`);
          continue;
        }

        const suite = { setup: p.setup, cases: p.cases };
        const check = await selfCheckDebug(p.correctFiles, files, suite);
        if (!check.ok) {
          note(`attempt ${attempt}: rejected — ${check.reason}`);
          continue;
        }
        const row = await prisma.problem.create({
          data: {
            type: "debug",
            language: "python",
            difficulty,
            title: p.title,
            prompt: p.prompt,
            // Deliberately NOT storing the JD: it can carry a company's
            // internal role details, the tags below capture everything the
            // bank actually needs from it, and the job row that did hold it is
            // wiped on completion (INV-12). Persisting it here would quietly
            // undo that.
            files: files as object,
            testSuite: suite as object,
            answerKey: p.answerKey as unknown as object,
            qualityScore: check.qualityScore,
            source: "generated",
            generatorModel: generatedBy(),
            sourceJobId: jobId ?? null,
            tags: parseTags(p.tags),
          },
          select: { id: true, title: true },
        });
        return { ...row, qualityScore: check.qualityScore, attempts: attempt, generatorModel: generatedBy() };
      }

      if (type === "design") {
        const p = await generateDesign(client, difficulty, topic, jd, model, signal);
        const check = await selfCheckDesign(client, { ...p, rubric: p.rubric as AnswerKeyIssue[] }, signal);
        if (!check.ok) {
          note(`attempt ${attempt}: rejected — ${check.reason}`);
          continue;
        }
        const row = await prisma.problem.create({
          data: {
            type: "design",
            language: "python",
            difficulty,
            title: p.title,
            prompt: p.prompt,
            // The rubric doubles as the answer key: design's "seeded issues" are
            // the dimensions a strong answer must engage with. The sample
            // answers are a generation-time gate only — persisting strongAnswer
            // would be persisting the model solution.
            answerKey: p.rubric as unknown as object,
            qualityScore: check.qualityScore,
            source: "generated",
            generatorModel: generatedBy(),
            sourceJobId: jobId ?? null,
            tags: parseTags(p.tags),
          },
          select: { id: true, title: true },
        });
        return { ...row, qualityScore: check.qualityScore, attempts: attempt, generatorModel: generatedBy() };
      }

      const p = await generateReview(client, difficulty, topic, jd, model, signal);
      const check = await selfCheckReview(p);
      if (!check.ok) {
        note(`attempt ${attempt}: rejected — ${check.reason}`);
        continue;
      }
      const row = await prisma.problem.create({
        data: {
          type: "review",
          language: "python",
          difficulty,
          title: p.title,
          prompt: p.prompt,
          diff: p.diff as object,
          prMeta: p.prMeta as object,
          answerKey: p.answerKey as unknown as object,
          qualityScore: check.qualityScore,
          source: "generated",
          generatorModel: generatedBy(),
          sourceJobId: jobId ?? null,
          tags: parseTags(p.tags),
        },
        select: { id: true, title: true },
      });
      return { ...row, qualityScore: check.qualityScore, attempts: attempt, generatorModel: generatedBy() };
    } catch (err) {
      // A disconnected browser owns this request-scoped key. Stop immediately;
      // retrying after cancellation only spends against a result nobody can use.
      if (signal?.aborted || isAbortError(err)) throw err;
      if (client.provider === "anthropic" && err instanceof GenerationRefusedError && model !== CALLS.generationFallback.model) {
        // Don't burn an attempt on a refusal: the request was never really
        // tried, and the fallback deserves its own full budget.
        model = CALLS.generationFallback.model;
        note(`attempt ${attempt}: refused (${err.category ?? "no category"}) — switching to ${model}`);
        attempt -= 1;
        continue;
      }
      // A transient generation/parse/streaming failure retries within budget
      // rather than aborting every remaining attempt.
      note(`attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
  }
  return null;
}
