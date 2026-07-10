/**
 * Shared domain types — the single source of truth for the shapes that flow
 * between the DB (Prisma `Json` columns), the API routes, the Pyodide worker,
 * and the React UI. Keeping them here prevents drift across those boundaries.
 *
 * The DB stores these as untyped `Json`; helpers in `lib/problem.ts` cast the
 * raw Prisma rows into these typed views.
 */

// ---------------------------------------------------------------------------
// Enumerations (stored as strings so the schema stays SQLite/Postgres portable)
// ---------------------------------------------------------------------------

export type ProblemType = "debug" | "review" | "design";
export type Difficulty = "easy" | "medium" | "hard";
export type Severity = "critical" | "major" | "minor";

export const PROBLEM_TYPES: ProblemType[] = ["debug", "review", "design"];
export const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

// ---------------------------------------------------------------------------
// Answer key — the ground truth the generator seeds (spec §2, §11).
// Grading matches a user's fixes/comments against these known issues.
// ---------------------------------------------------------------------------

export interface AnswerKeyIssue {
  /** Stable id, referenced by the grade breakdown. */
  id: string;
  /** 1-based inclusive line range in the starter code / diff the issue lives on. */
  lineStart: number;
  lineEnd: number;
  severity: Severity;
  /** The concrete failure this flaw causes (what breaks, for whom). */
  failure: string;
  /** The reasoning a strong reviewer would give — shown in results + used for grading. */
  explanation: string;
  /** Lowercased keywords/synonyms that signal the user identified this issue. */
  keywords: string[];
}

// ---------------------------------------------------------------------------
// Debug mode — Pyodide-executed test suite (spec §9, §11.4)
// ---------------------------------------------------------------------------

export interface TestCase {
  /** Test function name, e.g. "test_partial_last_batch". */
  name: string;
  /** Python source for this test; asserts against the user's solution. */
  body: string;
}

export interface TestSuite {
  /** Optional Python run before the user code + tests (imports, fixtures, data files). */
  setup?: string;
  cases: TestCase[];
}

// ---------------------------------------------------------------------------
// Review mode — structured unified diff (spec §10)
// ---------------------------------------------------------------------------

export type DiffLineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: DiffLineKind;
  /** Line number in the *new* file (null for deleted lines). This is the
   *  coordinate system the answer key + user comments anchor to. */
  lineNo: number | null;
  content: string;
}

export interface DiffHunk {
  /** File path shown in the diff header. */
  file: string;
  lines: DiffLine[];
}

export interface PrMeta {
  number: number;
  branch: string;
  additions: number;
  deletions: number;
  files: number;
  /** Whether the PR is flagged as AI-generated (it always is, in v1). */
  aiGenerated: boolean;
}

// ---------------------------------------------------------------------------
// Problem — the client-facing, typed view of a bank row
// ---------------------------------------------------------------------------

export interface Problem {
  id: string;
  type: ProblemType;
  language: string;
  difficulty: Difficulty;
  title: string;
  prompt: string;
  jdContext: string | null;
  starterCode: string | null;
  diff: DiffHunk[] | null;
  prMeta: PrMeta | null;
  testSuite: TestSuite | null;
  rubric: RubricDimension[] | null;
  answerKey: AnswerKeyIssue[];
  qualityScore: number | null;
  source: "authored" | "generated";
}

/** The problem as sent to the browser while solving — the answer key is stripped
 *  so it never leaves the server (grading happens server-side). */
export type PublicProblem = Omit<Problem, "answerKey"> & { answerKeyCount: number };

/** Compact row for the bank list. */
export interface ProblemSummary {
  id: string;
  type: ProblemType;
  title: string;
  difficulty: Difficulty;
}

// ---------------------------------------------------------------------------
// Design mode (phase 2) — rubric
// ---------------------------------------------------------------------------

export interface RubricDimension {
  id: string;
  name: string;
  description: string;
  weight: number;
}

// ---------------------------------------------------------------------------
// Execution — the Pyodide worker protocol (spec §9)
// ---------------------------------------------------------------------------

/** Sent from the main thread to the worker. */
export interface RunRequest {
  userCode: string;
  /** Python harness that imports the user's solution and runs the test cases,
   *  emitting a JSON result via a sentinel (see lib/pyodide/harness.ts). */
  testCode: string;
}

/** Result of a single test case after execution. */
export interface TestResult {
  name: string;
  passed: boolean;
  /** Assertion / error detail shown when the case fails. */
  message?: string;
}

/** Sent from the worker back to the main thread. */
export interface RunResult {
  ok: boolean;
  /** Combined stdout + stderr captured during the run. */
  output: string;
  /** Structured per-test outcomes (empty if the code crashed before tests ran). */
  tests: TestResult[];
  /** Top-level error message (syntax error, timeout, uncaught exception). */
  error?: string;
  /** True when the run was killed by the watchdog timeout. */
  timedOut?: boolean;
}

/** One recorded run, persisted to Attempt.runHistory for approach grading. */
export interface RunRecord {
  passed: number;
  failed: number;
  output: string;
  at: number;
}

// ---------------------------------------------------------------------------
// Submissions & grading (spec §12, §15)
// ---------------------------------------------------------------------------

/** A line comment the user leaves during review. */
export interface ReviewComment {
  /** Line number in the new file (matches DiffLine.lineNo). */
  line: number;
  body: string;
}

export type Submission =
  | { mode: "debug"; code: string; runHistory: RunRecord[] }
  | { mode: "review"; comments: ReviewComment[] };

/** How a single seeded issue fared against the user's submission. */
export interface IssueOutcome {
  issueId: string;
  status: "caught" | "missed";
  /** Short label of the issue (severity + failure). */
  failure: string;
  explanation: string;
  /** For caught issues: what the user said that matched. */
  matchedOn?: string;
}

/** A user comment/claim that didn't correspond to any seeded issue. */
export interface FalsePositive {
  line?: number;
  body: string;
  /** Model's short note on why it isn't a real issue (review mode). */
  note?: string;
}

export interface Grade {
  /** 0–100 overall score. */
  score: number;
  /** One-line verdict headline shown on the results screen. */
  headline: string;
  summary: string;
  outcomes: IssueOutcome[];
  falsePositives: FalsePositive[];
  /** Debug only: did the objective test suite pass on the final submission. */
  testsPassed?: boolean;
  /** Design only (phase 2): per-dimension scores. */
  dimensionScores?: { name: string; score: number; justification: string }[];
}

// ---------------------------------------------------------------------------
// Socratic follow-up chat (spec §5, §12)
// ---------------------------------------------------------------------------

export type ChatRole = "interviewer" | "user";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}
