/**
 * Zod schemas for API request bodies. Validating at the route boundary keeps
 * untyped JSON from flowing into the grading engine and gives clean 400s.
 */
import { z } from "zod";

const reviewCommentSchema = z.object({
  file: z.string().max(300).optional(),
  line: z.number().int(),
  body: z.string().min(1).max(4_000),
});

const runRecordSchema = z.object({
  passed: z.number().int(),
  failed: z.number().int(),
  output: z.string().max(50_000),
  at: z.number().nonnegative(),
});

export const solutionFileSchema = z.object({
  path: z.string().min(1).max(300),
  content: z.string().max(100_000),
  readOnly: z.boolean().optional(),
});

export const submissionSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("debug"),
    files: z.array(solutionFileSchema).min(1).max(20),
    runHistory: z.array(runRecordSchema).max(100),
  }),
  z.object({
    mode: z.literal("review"),
    comments: z.array(reviewCommentSchema).max(100),
  }),
  z.object({
    mode: z.literal("design"),
    doc: z.string().min(1).max(100_000),
  }),
]);

export const gradeBodySchema = z.object({
  problemId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  submission: submissionSchema,
});
export type GradeBody = z.infer<typeof gradeBodySchema>;

const chatMessageSchema = z.object({
  role: z.enum(["interviewer", "user"]),
  content: z.string().max(10_000),
});

export const socraticBodySchema = z.object({
  attemptId: z.string().min(1).max(128),
  history: z.array(chatMessageSchema).max(40).default([]),
  userMessage: z.string().max(4_000).optional(),
});
export type SocraticBody = z.infer<typeof socraticBodySchema>;

/** POST /api/hint — bounded in-progress work sent to the hint model. */
export const hintBodySchema = z.object({
  problemId: z.string().min(1).max(128),
  files: z.array(solutionFileSchema).max(20).optional(),
  // Kept for old single-file clients; the solve UI now sends `files`.
  code: z.string().max(100_000).optional(),
  output: z.string().max(50_000).optional(),
  diffText: z.string().max(200_000).optional(),
  doc: z.string().max(100_000).optional(),
  history: z.array(chatMessageSchema).max(40).default([]),
  userMessage: z.string().max(4_000).optional(),
});
export type HintBody = z.infer<typeof hintBodySchema>;

/** POST /api/jd/match — a pasted job description, matched against the bank. */
export const jdMatchBodySchema = z.object({
  // Bounded so a pasted novel can't run up the extraction bill; 12k characters
  // is far more than any real posting.
  jd: z.string().min(40, "Paste a bit more of the job description").max(12_000),
  sessionId: z.string().min(1),
  type: z.enum(["debug", "review", "design"]).optional(),
  difficulty: z.enum(["easy", "medium", "hard"]).optional(),
});
export type JdMatchBody = z.infer<typeof jdMatchBodySchema>;

/** POST /api/generate — enqueue a tailored problem (the worker does the work). */
export const generateBodySchema = z.object({
  sessionId: z.string().min(1),
  jd: z.string().max(12_000).optional(),
  type: z.enum(["debug", "review", "design"]).optional(),
  difficulty: z.enum(["easy", "medium", "hard"]).optional(),
});
export type GenerateBody = z.infer<typeof generateBodySchema>;

/** Public BYOK generation after JD matching proves the bank has no close fit. */
export const tailoredGenerateBodySchema = z.object({
  sessionId: z.string().min(1).max(128),
  jd: z.string().min(40, "Paste a bit more of the job description").max(12_000),
  type: z.enum(["debug", "review", "design"]).optional(),
  difficulty: z.enum(["easy", "medium", "hard"]),
});
export type TailoredGenerateBody = z.infer<typeof tailoredGenerateBodySchema>;
