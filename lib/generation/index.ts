/**
 * Shared generate → self-check → persist pipeline (spec §11), used by BOTH the
 * offline CLI (scripts/generate-bank.ts) and the live JD route (/api/generate).
 * One place owns "make a real, verified problem and put it in the bank".
 *
 * Debug problems are executed (python3) so a hallucinated bug can't enter the
 * bank; review problems are model-verified. Only problems that pass persist.
 */
import type { PrismaClient } from "@prisma/client";
import type { Difficulty, ProblemType } from "../types";
import { generateDebug, generateReview, verifyReview } from "./generate";
import { selfCheckDebug } from "./selfcheck";

export interface GenerateOpts {
  type: Extract<ProblemType, "debug" | "review">;
  difficulty: Difficulty;
  topic?: string;
  jd?: string;
  maxAttempts?: number;
}

export interface GenerateResult {
  id: string;
  title: string;
  qualityScore: number;
  attempts: number;
}

/** Generate one verified problem and persist it. Returns null if every attempt
 *  failed self-check (the caller decides how to surface that). */
export async function generateAndPersist(prisma: PrismaClient, opts: GenerateOpts): Promise<GenerateResult | null> {
  const { type, difficulty, topic, jd, maxAttempts = 3 } = opts;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // A throw from generation/parse must retry, not abort the whole loop.
    try {
      if (type === "debug") {
        const p = await generateDebug(difficulty, topic, jd);

        // The file(s) the answer key points at ARE where the user must edit — force
        // them editable so the model can't accidentally ship an unsolvable problem
        // by marking the buggy module readOnly. If the key references no real file,
        // we can't guarantee solvability — reject and retry.
        const buggyPaths = new Set(p.answerKey.map((i) => i.file).filter((f): f is string => !!f));
        const files = p.buggyFiles.map((f) => (buggyPaths.has(f.path) ? { ...f, readOnly: false } : f));
        const bugFileIsEditable = files.some((f) => buggyPaths.has(f.path) && !f.readOnly);
        if (!bugFileIsEditable) continue;

        const suite = { setup: p.setup, cases: p.cases };
        const check = await selfCheckDebug(p.correctFiles, files, suite);
        if (!check.ok) continue;
        const row = await prisma.problem.create({
          data: {
            type: "debug",
            language: "python",
            difficulty,
            title: p.title,
            prompt: p.prompt,
            jdContext: jd ?? null,
            files: files as object,
            testSuite: suite as object,
            answerKey: p.answerKey as unknown as object,
            qualityScore: check.qualityScore,
            source: "generated",
          },
          select: { id: true, title: true },
        });
        return { ...row, qualityScore: check.qualityScore, attempts: attempt };
      }
      const p = await generateReview(difficulty, topic, jd);
      const check = await verifyReview(p);
      if (!check.ok) continue;
      const row = await prisma.problem.create({
        data: {
          type: "review",
          language: "python",
          difficulty,
          title: p.title,
          prompt: p.prompt,
          jdContext: jd ?? null,
          diff: p.diff as object,
          prMeta: p.prMeta as object,
          answerKey: p.answerKey as unknown as object,
          qualityScore: check.qualityScore,
          source: "generated",
        },
        select: { id: true, title: true },
      });
      return { ...row, qualityScore: check.qualityScore, attempts: attempt };
    } catch {
      // A transient generation/parse/streaming failure retries within budget
      // rather than aborting every remaining attempt.
      continue;
    }
  }
  return null;
}
