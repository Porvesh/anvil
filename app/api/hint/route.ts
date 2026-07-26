import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { toPublicProblem } from "@/lib/problem";
import { streamHintSSE } from "@/lib/anthropic/hint";
import { SSE_HEADERS } from "@/lib/anthropic/stream";
import { clientKey, rateLimit } from "@/lib/ratelimit";
import { hintBodySchema } from "@/lib/validation";

export const runtime = "nodejs";

/** POST /api/hint — stream a solve-time nudge (no answer key) over SSE. */
export async function POST(req: Request) {
  const limit = rateLimit(clientKey(req));
  if (!limit.ok) return NextResponse.json({ error: "Rate limit exceeded — try again shortly." }, { status: 429 });

  const parsed = hintBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
  }
  const { problemId, files, code, output, diffText, doc, history, userMessage } = parsed.data;

  const row = await prisma.problem.findUnique({ where: { id: problemId } });
  if (!row) return NextResponse.json({ error: "Problem not found" }, { status: 404 });

  const stream = streamHintSSE(toPublicProblem(row), { files, code, output, diffText, doc }, history, userMessage);
  return new Response(stream, { headers: SSE_HEADERS });
}
