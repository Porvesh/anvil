import { prisma } from "@/lib/db";
import { SSE_HEADERS } from "@/lib/anthropic/stream";

export const runtime = "nodejs";

/** How often to re-read the job row. Generation phases last tens of seconds. */
const POLL_MS = 1_000;
/** Stop streaming a job that never terminates, so a connection can't leak. */
const MAX_WAIT_MS = 10 * 60_000;

/**
 * GET /api/generate/[id]/stream — phase updates for a queued generation.
 *
 * Polls the job row rather than using LISTEN/NOTIFY. At this volume a 1s poll
 * against an indexed primary key is free, and it works identically on SQLite
 * and Postgres; NOTIFY is the upgrade if polling ever shows up in a bill, not
 * the place to start.
 *
 * Frames match the interviewer streams (`data: {type:…}`) so the client's SSE
 * reader is the same one:
 *   {"type":"phase","phase":"writing","note":"attempt 2: rejected — …"}
 *   {"type":"done","problemId":"clx…"}
 *   {"type":"error","message":"…"}
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const startedAt = Date.now();
      let lastPhase = "";

      try {
        for (;;) {
          if (req.signal.aborted) return;
          const job = await prisma.generationJob.findUnique({
            where: { id },
            select: { status: true, note: true, problemId: true, error: true },
          });

          if (!job) {
            send({ type: "error", message: "No such generation job." });
            return;
          }

          // Only emit on change, so a client that reconnects doesn't replay a
          // wall of identical frames.
          const phase = `${job.status}:${job.note ?? ""}`;
          if (phase !== lastPhase) {
            lastPhase = phase;
            send({ type: "phase", phase: job.status, note: job.note ?? undefined });
          }

          if (job.status === "done" && job.problemId) {
            send({ type: "done", problemId: job.problemId });
            return;
          }
          if (job.status === "failed") {
            send({ type: "error", message: job.error ?? "Generation failed." });
            return;
          }
          if (Date.now() - startedAt > MAX_WAIT_MS) {
            send({ type: "error", message: "Timed out waiting for generation." });
            return;
          }

          await new Promise<void>((resolve) => {
            let timer: ReturnType<typeof setTimeout>;
            const done = () => {
              clearTimeout(timer);
              req.signal.removeEventListener("abort", done);
              resolve();
            };
            timer = setTimeout(done, POLL_MS);
            req.signal.addEventListener("abort", done, { once: true });
          });
        }
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
