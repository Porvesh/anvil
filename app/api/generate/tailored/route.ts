import { type NextRequest, NextResponse } from "next/server";
import { userModelFromRequest, byokRequiredResponse, isSameOrigin } from "@/lib/anthropic/byok";
import { prisma } from "@/lib/db";
import { generateAndPersist } from "@/lib/generation";
import { selectTailoredType } from "@/lib/generation/selectType";
import { classifyModelError, isAbortError } from "@/lib/anthropic/reliability";
import { SSE_HEADERS } from "@/lib/anthropic/stream";
import { clientKey, dailyLimit, rateLimit } from "@/lib/ratelimit";
import { tailoredGenerateBodySchema } from "@/lib/validation";

export const runtime = "nodejs";
// Generation includes structured output plus deterministic/model quality gates.
// Hosts may impose a lower ceiling; the container deployment should allow this.
export const maxDuration = 800;

const NO_STORE = { "Cache-Control": "no-store" };

/** Generate one verified problem on the connected user's provider after a bank miss. */
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403, headers: NO_STORE });
  }
  if (!rateLimit(`tailored:${clientKey(req)}`).ok) {
    return NextResponse.json({ error: "Too many generation requests. Try again shortly." }, { status: 429, headers: NO_STORE });
  }

  const client = userModelFromRequest(req);
  if (!client) return byokRequiredResponse();

  const parsed = tailoredGenerateBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400, headers: NO_STORE });
  }

  const budget = dailyLimit(`tailored:${parsed.data.sessionId}`);
  if (!budget.ok) {
    return NextResponse.json(
      { error: `You've generated ${budget.limit} tailored problems today. Try the shared bank for another exercise.` },
      { status: 429, headers: NO_STORE },
    );
  }

  const type = selectTailoredType(parsed.data.type, parsed.data.jd);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      try {
        send({ type: "phase", phase: "writing", note: `Writing a tailored ${type} problem` });
        const result = await generateAndPersist(prisma, {
          client,
          type,
          difficulty: parsed.data.difficulty,
          jd: parsed.data.jd,
          maxAttempts: 2,
          signal: req.signal,
          onProgress: (note) => send({ type: "phase", phase: "verifying", note }),
        });

        if (!result) {
          send({
            type: "error",
            message: "The generated exercise did not pass Anvil's quality checks. Try again; you will get a fresh problem.",
          });
          return;
        }
        send({ type: "done", problemId: result.id, problemType: type, title: result.title });
      } catch (error) {
        if (req.signal.aborted || isAbortError(error)) return;
        const failure = classifyModelError(error, "generation");
        send({ type: "error", message: failure.message, code: failure.code });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: { ...SSE_HEADERS, ...NO_STORE } });
}
