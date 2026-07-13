/**
 * Shared SSE streaming helper for the chat-style model calls (Socratic
 * follow-up and solve-time hints). Both stream Haiku token-by-token to the
 * browser in the same wire format, so the streaming mechanics live here and the
 * callers only build the system prefix + messages.
 *
 * SSE payloads: `data: {"type":"delta","text":"..."}` … `data: {"type":"done"}`.
 */
import { anthropic } from "./client";
import { MODELS, MAX_TOKENS } from "./models";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * The Messages API requires `messages[0]` to be a user turn. Our transcripts
 * often start with an interviewer (assistant) greeting/probe, so prepend a
 * synthetic user kickoff when the first turn isn't already a user turn. This
 * preserves the assistant history (for continuity) while satisfying the API.
 */
export function ensureUserFirst(turns: ChatTurn[], kickoff: string): ChatTurn[] {
  if (turns.length === 0 || turns[0].role !== "user") {
    return [{ role: "user", content: kickoff }, ...turns];
  }
  return turns;
}

type SystemPrefix = { type: "text"; text: string; cache_control: { type: "ephemeral" } }[];

export function sseFromMessages(
  system: SystemPrefix,
  messages: ChatTurn[],
  maxTokens: number = MAX_TOKENS.socratic,
  onFinal?: (reply: string) => void | Promise<void>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        let full = "";
        const stream = anthropic.messages.stream({
          model: MODELS.grading,
          max_tokens: maxTokens,
          system,
          messages,
        });
        stream.on("text", (delta) => {
          full += delta;
          send({ type: "delta", text: delta });
        });
        await stream.finalMessage();
        if (onFinal) await onFinal(full);
        send({ type: "done" });
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });
}

/** Standard SSE response headers. */
export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
} as const;
