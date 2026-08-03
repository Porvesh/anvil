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
  SolutionFile,
  TestSuite,
} from "./types";
import { qualityLabel } from "./curation";
import { parseTags } from "./tags";

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
    // Prefer multi-file; fall back to wrapping legacy single-file starterCode so
    // old rows keep working through the multi-file editor.
    files:
      json<SolutionFile[]>(row.files) ??
      (row.starterCode ? [{ path: "solution.py", content: row.starterCode }] : null),
    diff: json<DiffHunk[]>(row.diff),
    prMeta: json<PrMeta>(row.prMeta),
    testSuite: json<TestSuite>(row.testSuite),
    rubric: json<RubricDimension[]>(row.rubric),
    answerKey: (json<AnswerKeyIssue[]>(row.answerKey) ?? []),
    qualityScore: row.qualityScore,
    source: row.source as Problem["source"],
    generatorModel: row.generatorModel,
    sourceJobId: row.sourceJobId,
    tags: parseTags(row.tags),
    upvotes: row.upvotes,
    downvotes: row.downvotes,
    timesAttempted: row.timesAttempted,
    retired: row.retired,
  };
}

/**
 * Public view sent to the browser while solving — the single chokepoint where a
 * DB row becomes client-facing, which is why it is also the single place ground
 * truth gets withheld. One chokepoint is auditable; three aren't.
 *
 * Withholds the answer key (INV-1), its length (INV-9 — a flaw count is itself
 * a spoiler), and the pasted JD (INV-12 — it can carry a real company's
 * internal details into a shared bank). See PublicProblem in lib/types.ts.
 */
export function toPublicProblem(row: PrismaProblem): PublicProblem {
  const { answerKey, jdContext, ...rest } = toProblem(row);
  void answerKey;
  void jdContext;
  return rest;
}

/** Compact bank-list row, including the curation signals the bank UI renders. */
/**
 * Size of the code the user will face, by mode.
 *
 * Review is measured in added diff lines because that is what a reviewer reads;
 * debug in total project lines, since the whole package is on screen. Design has
 * no code, so it has no scale rather than a misleading zero.
 */
function scaleOf(row: PrismaProblem): ProblemSummary["scale"] {
  if (row.type === "review") {
    const diff = json<DiffHunk[]>(row.diff) ?? [];
    const added = diff.reduce((n, hunk) => n + hunk.lines.filter((l) => l.kind === "add").length, 0);
    return diff.length ? { files: diff.length, lines: added } : null;
  }
  if (row.type === "debug") {
    const files = json<SolutionFile[]>(row.files) ?? [];
    const lines = files.reduce((n, f) => n + f.content.split("\n").length, 0);
    return files.length ? { files: files.length, lines } : null;
  }
  return null;
}

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
    tags: parseTags(row.tags),
    scale: scaleOf(row),
  };
}
