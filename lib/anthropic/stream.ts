/**
 * Shared SSE streaming helper for the chat-style model calls (Socratic
 * follow-up and solve-time hints). Both stream token-by-token to the browser in
 * the same wire format, so the streaming mechanics live here and the callers
 * only build the system prefix + messages.
 *
 * The two callers route to different models on purpose (Socratic gets the
 * strongest model, hints are deliberately capped — see lib/anthropic/models.ts),
 * so the call site is a parameter rather than a constant.
 *
 * SSE payloads: `data: {"type":"delta","text":"..."}` … `data: {"type":"done"}`.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { callParams, type CallSite } from "./models";
import { classifyModelError, isAbortError, modelRequestOptions } from "./reliability";

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
  client: Anthropic,
  site: CallSite,
  system: SystemPrefix,
  messages: ChatTurn[],
  onFinal?: (reply: string) => void | Promise<void>,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let abortUpstream: (() => void) | undefined;
  let open = true;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          open = false;
        }
      };
      try {
        let full = "";
        const stream = client.messages.stream({
          ...callParams(site),
          system,
          messages,
        }, modelRequestOptions(site, signal));
        abortUpstream = () => stream.abort();
        stream.on("text", (delta) => {
          full += delta;
          send({ type: "delta", text: delta });
        });
        await stream.finalMessage();
        if (onFinal) await onFinal(full);
        send({ type: "done" });
      } catch (err) {
        if (!isAbortError(err) && !signal?.aborted) {
          const info = classifyModelError(err, "interviewer");
          send({ type: "error", code: info.code, message: info.message, retryable: info.retryable });
        }
      } finally {
        abortUpstream = undefined;
        if (open) controller.close();
        open = false;
      }
    },
    cancel() {
      open = false;
      abortUpstream?.();
    },
  });
}

/** Standard SSE response headers. */
export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
} as const;
