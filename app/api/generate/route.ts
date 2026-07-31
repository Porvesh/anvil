import { type NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { analyzeJd, difficultyFor } from "@/lib/anthropic/jd";
import { anthropic } from "@/lib/anthropic/client";
import { generateBodySchema } from "@/lib/validation";
import { clientKey, dailyLimit, rateLimit } from "@/lib/ratelimit";
import { isGenerationAdmin } from "@/lib/adminAuth";

export const runtime = "nodejs";

/**
 * POST /api/generate — enqueue a tailored problem. Returns a jobId immediately.
 *
 * This used to generate inline, which meant a request handler holding a
 * connection open for ~100s while a model wrote a project twice and python3
 * executed it. That can't run on serverless (no python3, no such timeout) and
 * the only way to make it fit would be to drop the execution oracle — putting
 * unverified problems in front of a live user, which is the worst possible
 * place to drop a gate (INV-10).
 *
 * This operator-authenticated route only enqueues. A worker with python3 drains
 * the queue and progress remains available at /api/generate/[id]/stream.
 * Public browser traffic cannot spend the platform generation key.
 */
export async function POST(req: NextRequest) {
  if (!isGenerationAdmin(req)) {
    return NextResponse.json(
      { error: "Problem generation is operator-only." },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
    );
  }
  if (!rateLimit(clientKey(req)).ok) {
    return NextResponse.json({ error: "Rate limit exceeded — try again shortly." }, { status: 429 });
  }

  const parsed = generateBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
  }
  const { type, difficulty, jd, sessionId } = parsed.data;

  // Generation is the only endpoint that can run up a real bill, so it's the
  // only one with a real budget rather than a burst limit.
  const budget = dailyLimit(`gen:${sessionId}`);
  if (!budget.ok) {
    return NextResponse.json(
      { error: `You've generated ${budget.limit} problems today — the bank has plenty more.` },
      { status: 429 },
    );
  }

  // Tagging here rather than in the worker means a job carries its tags even if
  // generation later fails, and it's ~1s on the cheapest model.
  let tags: string[] = [];
  let resolvedDifficulty = difficulty;
  if (jd) {
    try {
      const analysis = await analyzeJd(anthropic, jd, req.signal);
      tags = analysis.tags;
      resolvedDifficulty = difficulty ?? difficultyFor(analysis.seniority);
    } catch {
      // Tagging is an optimization; a failure must not cost the user their job.
    }
  }

  const job = await prisma.generationJob.create({
    data: {
      sessionId,
      jd: jd ?? null,
      tags,
      type: type ?? (jd && /review|pull request|\bpr\b/i.test(jd) ? "review" : "debug"),
      difficulty: resolvedDifficulty ?? "medium",
    },
    select: { id: true, type: true, difficulty: true },
  });

  return NextResponse.json({ jobId: job.id, type: job.type, difficulty: job.difficulty });
}
