import { type NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { toProblem } from "@/lib/problem";
import { streamSocraticSSE } from "@/lib/anthropic/socratic";
import { socraticBodySchema } from "@/lib/validation";
import { clientKey, rateLimit } from "@/lib/ratelimit";
import type { ChatMessage, Grade } from "@/lib/types";
import { byokRequiredResponse, userAnthropicFromRequest } from "@/lib/anthropic/byok";

export const runtime = "nodejs";

/**
 * POST /api/socratic — stream the interviewer's next turn as SSE. Loads the
 * grade + problem (with answer key) from the persisted attempt so ground truth
 * is never trusted from the client. Persists the running transcript as it goes.
 */
export async function POST(req: NextRequest) {
  const limit = rateLimit(clientKey(req));
  if (!limit.ok) {
    return NextResponse.json({ error: "Rate limit exceeded — try again shortly." }, { status: 429 });
  }
  const client = userAnthropicFromRequest(req);
  if (!client) return byokRequiredResponse();

  const parsed = socraticBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
  }
  const { attemptId, history, userMessage } = parsed.data;

  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId } });
  if (!attempt || !attempt.grade) {
    return NextResponse.json({ error: "Attempt not found" }, { status: 404 });
  }
  const problemRow = await prisma.problem.findUnique({ where: { id: attempt.problemId } });
  if (!problemRow) return NextResponse.json({ error: "Problem not found" }, { status: 404 });

  const problem = toProblem(problemRow);
  const grade = attempt.grade as unknown as Grade;

  const stream = streamSocraticSSE(client, problem, grade, history, userMessage, async (reply) => {
    const transcript: ChatMessage[] = [
      ...history,
      ...(userMessage ? [{ role: "user" as const, content: userMessage }] : []),
      { role: "interviewer", content: reply },
    ];
    await prisma.attempt.update({
      where: { id: attemptId },
      data: { transcript: transcript as unknown as object },
    });
  }, req.signal);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
