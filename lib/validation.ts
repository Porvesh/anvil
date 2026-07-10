/**
 * Zod schemas for API request bodies. Validating at the route boundary keeps
 * untyped JSON from flowing into the grading engine and gives clean 400s.
 */
import { z } from "zod";

const reviewCommentSchema = z.object({
  file: z.string().optional(),
  line: z.number().int(),
  body: z.string().min(1),
});

const runRecordSchema = z.object({
  passed: z.number().int(),
  failed: z.number().int(),
  output: z.string(),
  at: z.number(),
});

const solutionFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  readOnly: z.boolean().optional(),
});

export const submissionSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("debug"),
    files: z.array(solutionFileSchema).min(1),
    runHistory: z.array(runRecordSchema),
  }),
  z.object({
    mode: z.literal("review"),
    comments: z.array(reviewCommentSchema),
  }),
  z.object({
    mode: z.literal("design"),
    doc: z.string().min(1),
  }),
]);

export const gradeBodySchema = z.object({
  problemId: z.string().min(1),
  sessionId: z.string().min(1),
  submission: submissionSchema,
});
export type GradeBody = z.infer<typeof gradeBodySchema>;

const chatMessageSchema = z.object({
  role: z.enum(["interviewer", "user"]),
  content: z.string(),
});

export const socraticBodySchema = z.object({
  attemptId: z.string().min(1),
  history: z.array(chatMessageSchema).default([]),
  userMessage: z.string().optional(),
});
export type SocraticBody = z.infer<typeof socraticBodySchema>;
