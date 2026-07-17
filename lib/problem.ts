/**
 * Mappers between raw Prisma rows (untyped `Json` columns) and the typed domain
 * views in lib/types.ts. Centralizing the casts here keeps the `as` assertions
 * in one audited place instead of scattered across API routes.
 */
import type { Problem as PrismaProblem } from "@prisma/client";
import type {
  AnswerKeyIssue,
  DiffHunk,
  Problem,
  PrMeta,
  ProblemSummary,
  ProblemType,
  PublicProblem,
  Difficulty,
  RubricDimension,
  TestSuite,
} from "./types";
import { qualityLabel } from "./curation";

/** Cast a stored Json column to a typed value (or null). */
function json<T>(value: unknown): T | null {
  return (value ?? null) as T | null;
}

/** Full internal view, including the answer key (server-side only). */
export function toProblem(row: PrismaProblem): Problem {
  return {
    id: row.id,
    type: row.type as ProblemType,
    language: row.language,
    difficulty: row.difficulty as Difficulty,
    title: row.title,
    prompt: row.prompt,
    jdContext: row.jdContext,
    starterCode: row.starterCode,
    diff: json<DiffHunk[]>(row.diff),
    prMeta: json<PrMeta>(row.prMeta),
    testSuite: json<TestSuite>(row.testSuite),
    rubric: json<RubricDimension[]>(row.rubric),
    answerKey: (json<AnswerKeyIssue[]>(row.answerKey) ?? []),
    qualityScore: row.qualityScore,
    source: row.source as "authored" | "generated",
    upvotes: row.upvotes,
    downvotes: row.downvotes,
    timesAttempted: row.timesAttempted,
    retired: row.retired,
  };
}

/**
 * Public view sent to the browser while solving. The answer key is stripped so
 * ground truth never leaves the server — grading happens server-side against it.
 */
export function toPublicProblem(row: PrismaProblem): PublicProblem {
  const { answerKey, ...rest } = toProblem(row);
  return { ...rest, answerKeyCount: answerKey.length };
}

/** Compact bank-list row, including the curation signals the bank UI renders. */
export function toSummary(row: PrismaProblem): ProblemSummary {
  return {
    id: row.id,
    type: row.type as ProblemType,
    title: row.title,
    difficulty: row.difficulty as Difficulty,
    upvotes: row.upvotes,
    downvotes: row.downvotes,
    timesAttempted: row.timesAttempted,
    quality: qualityLabel(row.upvotes, row.downvotes).tone,
  };
}
