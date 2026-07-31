/**
 * Socratic follow-up (spec §5, §12) — the teaching moment. After grading, the
 * interviewer probes the *missed* issues with one question at a time, Socratic
 * style: it doesn't lecture the answer, it leads the user to it.
 *
 * Streaming mechanics live in ./stream; this module builds the cached system
 * prefix (problem + answer key) and maps the transcript to message turns.
 */
import { ensureUserFirst, sseFromMessages, type ChatTurn } from "./stream";
import type { ChatMessage, Grade, Problem } from "../types";

const OPENING_KICKOFF =
  "Begin the follow-up — open with your first probing question about the most important issue I missed.";

const SYSTEM_ROLE = [
  "You are a senior engineer running a post-review follow-up, in the style of a sharp but supportive interviewer.",
  "Your job is to deepen the candidate's understanding of the issues they MISSED, one question at a time.",
  "Rules:",
  "- Ask ONE focused question per turn. Never dump the answer; lead them to it Socratically.",
  "- Anchor questions to the specific missed issue and the real failure it causes.",
  "- Acknowledge what they got right briefly, then probe the gap.",
  "- Keep each message to 1-3 sentences. Use backticks for code identifiers.",
].join("\n");

function buildSystem(problem: Problem, grade: Grade) {
  const missed = grade.outcomes.filter((o) => o.status === "missed");
  const caught = grade.outcomes.filter((o) => o.status === "caught");

  const text = [
    SYSTEM_ROLE,
    "",
    `PROBLEM: ${problem.title}`,
    `PROMPT: ${problem.prompt}`,
    "",
    "ISSUES THE USER MISSED (focus here):",
    missed.length
      ? missed.map((m) => `- ${m.failure} — ${m.explanation}`).join("\n")
      : "(none — they caught everything; probe the reasoning behind their strongest catch instead)",
    "",
    "ISSUES THEY CAUGHT (acknowledge, don't re-teach):",
    caught.map((c) => `- ${c.failure}`).join("\n") || "(none)",
  ].join("\n");

  return [{ type: "text" as const, text, cache_control: { type: "ephemeral" as const } }];
}

function toTurns(history: ChatMessage[]): ChatTurn[] {
  return history.map((m) => ({
    role: m.role === "interviewer" ? "assistant" : "user",
    content: m.content,
  }));
}

/**
 * Stream the interviewer's next turn as SSE. Call with empty `history` (and no
 * `userMessage`) to generate the opening probe, or with the prior transcript +
 * the user's latest reply to continue.
 */
export function streamSocraticSSE(
  problem: Problem,
  grade: Grade,
  history: ChatMessage[],
  userMessage?: string,
  onFinal?: (interviewerReply: string) => void | Promise<void>,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const turns: ChatTurn[] = toTurns(history);
  if (userMessage) turns.push({ role: "user", content: userMessage });
  const messages = ensureUserFirst(turns, OPENING_KICKOFF);
  return sseFromMessages("socratic", buildSystem(problem, grade), messages, onFinal, signal);
}
