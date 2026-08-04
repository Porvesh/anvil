/**
 * Solve-time hints (spec §5 — "hint-on-demand while solving"). The interviewer
 * gives a nudge, never the answer. Critically, the hint model is given the
 * PUBLIC problem only (no answer key) — so it reasons from the code like a
 * colleague and physically can't leak ground truth.
 */
import { ensureUserFirst, sseFromMessages, type ChatTurn } from "./stream";
import { CUE_INSTRUCTIONS } from "../interview";
import type { ModelClient } from "../ai/client";
import type { ChatMessage, PublicProblem, SolutionFile } from "../types";

const KICKOFF = "I'm working on this — give me a nudge toward the problem, not the answer.";

const SYSTEM_ROLE = [
  "You are a supportive interviewer giving a HINT while the candidate works — not the solution.",
  "You do NOT have an answer key; reason from the code like a colleague looking over their shoulder.",
  "Rules:",
  "- Give a nudge: ask a guiding question, or suggest what to trace/print/re-read.",
  "- NEVER state the exact bug outright and NEVER provide corrected code.",
  "- 1-3 sentences. Use backticks for code identifiers.",
].join("\n");

/** Interview mode: the interviewer speaks without being asked. */
export type InterviewCueKind = keyof typeof CUE_INSTRUCTIONS;

export interface HintContext {
  /** debug: the user's current multi-file project. */
  files?: SolutionFile[];
  /** debug: legacy single-file client context. */
  code?: string;
  /** debug: latest test/console output. */
  output?: string;
  /** review: the diff text under review. */
  diffText?: string;
  /** design: the user's in-progress design doc. */
  doc?: string;
}

export function formatHintFiles(files: SolutionFile[]): string {
  return files
    .map((file) => `--- ${file.path}${file.readOnly ? " (read-only)" : ""} ---\n${file.content}`)
    .join("\n\n");
}

function buildSystem(problem: PublicProblem, ctx: HintContext) {
  const text = [
    SYSTEM_ROLE,
    "",
    `PROBLEM (${problem.type}): ${problem.title}`,
    `SYMPTOM / PROMPT: ${problem.prompt}`,
    ctx.files?.length ? `\nCURRENT FILES:\n${formatHintFiles(ctx.files)}` : "",
    !ctx.files?.length && ctx.code ? `\nCURRENT CODE:\n${ctx.code}` : "",
    ctx.output ? `\nLATEST OUTPUT:\n${ctx.output}` : "",
    ctx.diffText ? `\nDIFF UNDER REVIEW:\n${ctx.diffText}` : "",
    ctx.doc ? `\nCURRENT DESIGN DOC (work in progress):\n${ctx.doc}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return [{ type: "text" as const, text, cache_control: { type: "ephemeral" as const } }];
}

function toTurns(history: ChatMessage[]): ChatTurn[] {
  return history.map((m) => ({ role: m.role === "interviewer" ? "assistant" : "user", content: m.content }));
}

export function streamHintSSE(
  client: ModelClient,
  problem: PublicProblem,
  ctx: HintContext,
  history: ChatMessage[],
  userMessage?: string,
  signal?: AbortSignal,
  cue?: InterviewCueKind,
): ReadableStream<Uint8Array> {
  const turns: ChatTurn[] = toTurns(history);
  if (userMessage) turns.push({ role: "user", content: userMessage });
  // A cue is the interviewer prompting themselves, so it enters as the final
  // user turn rather than as system text: the model has to answer it, and the
  // instruction must not outrank the standing no-spoilers rules above it.
  if (cue) turns.push({ role: "user", content: CUE_INSTRUCTIONS[cue] });
  const messages = ensureUserFirst(turns, KICKOFF);
  return sseFromMessages(client, "hint", buildSystem(problem, ctx), messages, undefined, signal);
}
