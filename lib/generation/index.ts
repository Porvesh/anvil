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
    if (type === "debug") {
      const p = await generateDebug(difficulty, topic, jd);
      const suite = { setup: p.setup, cases: p.cases };
      const check = await selfCheckDebug(p.correctFiles, p.buggyFiles, suite);
      if (!check.ok) continue;
      const row = await prisma.problem.create({
        data: {
          type: "debug",
          language: "python",
          difficulty,
          title: p.title,
          prompt: p.prompt,
          jdContext: jd ?? null,
          files: p.buggyFiles as object,
          testSuite: suite as object,
          answerKey: p.answerKey as unknown as object,
          qualityScore: check.qualityScore,
          source: "generated",
        },
        select: { id: true, title: true },
      });
      return { ...row, qualityScore: check.qualityScore, attempts: attempt };
    } else {
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
    }
  }
  return null;
}
