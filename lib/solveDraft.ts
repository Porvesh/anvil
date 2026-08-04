import type { ChatMessage, ProblemType, ReviewComment, RunRecord, RunResult, SolutionFile } from "./types";

const VERSION = 1;
const PREFIX = `anvil:solve-draft:v${VERSION}:`;
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface DraftBase {
  version: typeof VERSION;
  problemId: string;
  updatedAt: number;
  chat: ChatMessage[];
  /**
   * Interview mode's wall clock, as an absolute deadline.
   *
   * Stored so a refresh or an accidental navigation does not hand the candidate
   * a fresh 45 minutes — the clock is the constraint, and one that resets on
   * F5 is not one. Absent for ordinary practice drafts, which is also what
   * every draft written before interview mode existed looks like, so v1 drafts
   * stay readable.
   */
  interviewDeadline?: number;
}

export type SolveDraft =
  | (DraftBase & {
      mode: "debug";
      files: SolutionFile[];
      activePath: string;
      runs: RunRecord[];
      runResult: RunResult | null;
    })
  | (DraftBase & { mode: "review"; comments: ReviewComment[] })
  | (DraftBase & { mode: "design"; code: string });

type WritableSolveDraft = SolveDraft extends infer Draft
  ? Draft extends SolveDraft
    ? Omit<Draft, "version" | "updatedAt">
    : never
  : never;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function chatMessage(value: unknown): value is ChatMessage {
  return object(value) && (value.role === "interviewer" || value.role === "user") && typeof value.content === "string";
}

function solutionFile(value: unknown): value is SolutionFile {
  return (
    object(value) &&
    typeof value.path === "string" &&
    typeof value.content === "string" &&
    (value.readOnly === undefined || typeof value.readOnly === "boolean")
  );
}

function reviewComment(value: unknown): value is ReviewComment {
  return (
    object(value) &&
    typeof value.line === "number" &&
    typeof value.body === "string" &&
    (value.file === undefined || typeof value.file === "string")
  );
}

function runRecord(value: unknown): value is RunRecord {
  return (
    object(value) &&
    typeof value.passed === "number" &&
    typeof value.failed === "number" &&
    typeof value.output === "string" &&
    typeof value.at === "number"
  );
}

function runResult(value: unknown): value is RunResult {
  return (
    object(value) &&
    typeof value.ok === "boolean" &&
    typeof value.output === "string" &&
    Array.isArray(value.tests) &&
    value.tests.every(
      (test) =>
        object(test) &&
        typeof test.name === "string" &&
        typeof test.passed === "boolean" &&
        (test.message === undefined || typeof test.message === "string"),
    ) &&
    (value.error === undefined || typeof value.error === "string") &&
    (value.timedOut === undefined || typeof value.timedOut === "boolean")
  );
}

export function parseSolveDraft(
  raw: unknown,
  problemId: string,
  mode: ProblemType,
  now = Date.now(),
): SolveDraft | null {
  if (
    !object(raw) ||
    raw.version !== VERSION ||
    raw.problemId !== problemId ||
    raw.mode !== mode ||
    typeof raw.updatedAt !== "number" ||
    now - raw.updatedAt > DRAFT_MAX_AGE_MS ||
    raw.updatedAt > now + 60_000 ||
    !Array.isArray(raw.chat) ||
    !raw.chat.every(chatMessage) ||
    !(raw.interviewDeadline === undefined || typeof raw.interviewDeadline === "number")
  ) {
    return null;
  }

  const base = {
    version: VERSION,
    problemId,
    updatedAt: raw.updatedAt,
    chat: raw.chat,
    interviewDeadline: raw.interviewDeadline,
  } as const;

  if (mode === "debug") {
    if (
      !Array.isArray(raw.files) ||
      !raw.files.every(solutionFile) ||
      typeof raw.activePath !== "string" ||
      !Array.isArray(raw.runs) ||
      !raw.runs.every(runRecord) ||
      !(raw.runResult === null || runResult(raw.runResult))
    ) {
      return null;
    }
    return { ...base, mode, files: raw.files, activePath: raw.activePath, runs: raw.runs, runResult: raw.runResult };
  }

  if (mode === "review") {
    if (!Array.isArray(raw.comments) || !raw.comments.every(reviewComment)) return null;
    return { ...base, mode, comments: raw.comments };
  }

  if (typeof raw.code !== "string") return null;
  return { ...base, mode, code: raw.code };
}

function storageOrNull(storage?: Storage): Storage | null {
  if (storage) return storage;
  return typeof window === "undefined" ? null : window.localStorage;
}

export function readSolveDraft(problemId: string, mode: ProblemType, storage?: Storage): SolveDraft | null {
  const target = storageOrNull(storage);
  if (!target) return null;
  const key = `${PREFIX}${problemId}`;
  try {
    const text = target.getItem(key);
    if (!text) return null;
    const draft = parseSolveDraft(JSON.parse(text), problemId, mode);
    if (!draft) target.removeItem(key);
    return draft;
  } catch {
    target.removeItem(key);
    return null;
  }
}

export function writeSolveDraft(draft: WritableSolveDraft, storage?: Storage): boolean {
  const target = storageOrNull(storage);
  if (!target) return false;
  try {
    target.setItem(
      `${PREFIX}${draft.problemId}`,
      JSON.stringify({ ...draft, version: VERSION, updatedAt: Date.now() }),
    );
    return true;
  } catch {
    // Storage may be disabled or full. Solving must continue even without recovery.
    return false;
  }
}

export function clearSolveDraft(problemId: string, storage?: Storage): void {
  try {
    storageOrNull(storage)?.removeItem(`${PREFIX}${problemId}`);
  } catch {
    // Clearing a best-effort browser cache must never block a successful grade.
  }
}
