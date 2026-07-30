import { notifyByokRequired } from "./byokClient";

/**
 * Browser helper to POST JSON and consume an SSE response from our streaming
 * routes (/api/socratic, /api/hint). Parses `data: {json}\n\n` frames and
 * dispatches `delta` / `error` payloads; resolves when the stream ends.
 */
export interface StreamHandlers {
  onDelta: (text: string) => void;
  onError?: (message: string) => void;
}

export interface StreamOptions {
  signal?: AbortSignal;
}

export async function streamSSE(
  url: string,
  body: unknown,
  handlers: StreamHandlers,
  options: StreamOptions = {},
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.json().catch(() => null);
    notifyByokRequired(detail?.code);
    throw new Error(detail?.error ?? `Request failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        try {
          const payload = JSON.parse(dataLine.slice(5).trim());
          if (payload.type === "delta") handlers.onDelta(payload.text);
          else if (payload.type === "error") {
            notifyByokRequired(payload.code);
            handlers.onError?.(payload.message);
          }
        } catch {
          // Ignore a malformed frame and keep consuming later valid events.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
