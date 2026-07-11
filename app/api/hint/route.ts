import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { toPublicProblem } from "@/lib/problem";
import { streamHintSSE } from "@/lib/anthropic/hint";
import { SSE_HEADERS } from "@/lib/anthropic/stream";
import { clientKey, rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

const bodySchema = z.object({
  problemId: z.string().min(1),
  code: z.string().optional(),
  output: z.string().optional(),
  diffText: z.string().optional(),
  history: z
    .array(z.object({ role: z.enum(["interviewer", "user"]), content: z.string() }))
    .default([]),
  userMessage: z.string().optional(),
});

/** POST /api/hint — stream a solve-time nudge (no answer key) over SSE. */
export async function POST(req: Request) {
  const limit = rateLimit(clientKey(req));
  if (!limit.ok) return NextResponse.json({ error: "Rate limit exceeded — try again shortly." }, { status: 429 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { problemId, code, output, diffText, history, userMessage } = parsed.data;

  const row = await prisma.problem.findUnique({ where: { id: problemId } });
  if (!row) return NextResponse.json({ error: "Problem not found" }, { status: 404 });

  const stream = streamHintSSE(toPublicProblem(row), { code, output, diffText }, history, userMessage);
  return new Response(stream, { headers: SSE_HEADERS });
}
