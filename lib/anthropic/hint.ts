/**
 * Solve-time hints (spec §5 — "hint-on-demand while solving"). The interviewer
 * gives a nudge, never the answer. Critically, the hint model is given the
 * PUBLIC problem only (no answer key) — so it reasons from the code like a
 * colleague and physically can't leak ground truth.
 */
import { MAX_TOKENS } from "./models";
import { ensureUserFirst, sseFromMessages, type ChatTurn } from "./stream";
import type { ChatMessage, PublicProblem } from "../types";

const KICKOFF = "I'm working on this — give me a nudge toward the problem, not the answer.";

const SYSTEM_ROLE = [
  "You are a supportive interviewer giving a HINT while the candidate works — not the solution.",
  "You do NOT have an answer key; reason from the code like a colleague looking over their shoulder.",
  "Rules:",
  "- Give a nudge: ask a guiding question, or suggest what to trace/print/re-read.",
  "- NEVER state the exact bug outright and NEVER provide corrected code.",
  "- 1-3 sentences. Use backticks for code identifiers.",
].join("\n");

export interface HintContext {
  /** debug: the user's current code. */
  code?: string;
  /** debug: latest test/console output. */
  output?: string;
  /** review: the diff text under review. */
  diffText?: string;
  /** design: the user's in-progress design doc. */
  doc?: string;
}

function buildSystem(problem: PublicProblem, ctx: HintContext) {
  const text = [
    SYSTEM_ROLE,
    "",
    `PROBLEM (${problem.type}): ${problem.title}`,
    `SYMPTOM / PROMPT: ${problem.prompt}`,
    ctx.code ? `\nCURRENT CODE:\n${ctx.code}` : "",
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
  problem: PublicProblem,
  ctx: HintContext,
  history: ChatMessage[],
  userMessage?: string,
): ReadableStream<Uint8Array> {
  const turns: ChatTurn[] = toTurns(history);
  if (userMessage) turns.push({ role: "user", content: userMessage });
  const messages = ensureUserFirst(turns, KICKOFF);
  return sseFromMessages(buildSystem(problem, ctx), messages, MAX_TOKENS.socratic);
}
