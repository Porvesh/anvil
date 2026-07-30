import { type NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { toPublicProblem } from "@/lib/problem";
import { analyzeJd, difficultyFor } from "@/lib/anthropic/jd";
import { MATCH_THRESHOLD, parseTags, tagOverlap } from "@/lib/tags";
import { wilsonScore } from "@/lib/curation";
import { jdMatchBodySchema } from "@/lib/validation";
import { clientKey, rateLimit } from "@/lib/ratelimit";
import { byokRequiredResponse, userModelFromRequest } from "@/lib/anthropic/byok";
import { classifyModelError } from "@/lib/anthropic/reliability";

export const runtime = "nodejs";

/** How many candidates to return; the client serves the first and shows the rest. */
const MAX_MATCHES = 3;

/**
 * POST /api/jd/match — turn a pasted job description into bank problems.
 *
 * This is the route that makes the bank compound. Generation is expensive and
 * slow; matching is ~1s and a tenth of a cent. Every tailored problem someone
 * generates gets tagged and becomes an asset the next person with a similar JD
 * is served for free. Without this step every user pays full generation price
 * forever and the bank never becomes anything.
 *
 * It answers only "what does the bank already have". Public matching never
 * invokes the separately authenticated operator generation pipeline.
 */
export async function POST(req: NextRequest) {
  const limit = rateLimit(clientKey(req));
  if (!limit.ok) {
    return NextResponse.json({ error: "Rate limit exceeded — try again shortly." }, { status: 429 });
  }
  const client = userModelFromRequest(req);
  if (!client) return byokRequiredResponse();

  const parsed = jdMatchBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
  }
  const { jd, sessionId, type, difficulty } = parsed.data;

  // A tagging failure degrades to "the bank has nothing for this JD" rather than
  // an error: the client already handles an empty match list by offering the
  // bank and a tailored generation, so a 500 here would break a flow that has a
  // perfectly good fallback.
  let tags, seniority;
  try {
    ({ tags, seniority } = await analyzeJd(client, jd, req.signal));
  } catch (error) {
    if (classifyModelError(error, "matching").code === "configuration") return byokRequiredResponse();
    return NextResponse.json({ tags: [], seniority: "mid", confidence: 0, matches: [] });
  }

  if (tags.length === 0) {
    return NextResponse.json({ tags: [], seniority, confidence: 0, matches: [] });
  }

  // Exclude what this session has already attempted: serving someone the
  // problem they just solved reads as the bank being empty.
  const attempted = await prisma.attempt.findMany({
    where: { sessionId },
    select: { problemId: true },
    distinct: ["problemId"],
  });

  const candidates = await prisma.problem.findMany({
    where: {
      retired: false,
      id: { notIn: attempted.map((a) => a.problemId) },
      ...(type ? { type } : {}),
      ...(difficulty ? { difficulty } : {}),
    },
  });

  const preferred = difficulty ?? difficultyFor(seniority);
  const ranked = candidates
    .map((row) => ({ row, overlap: tagOverlap(tags, parseTags(row.tags)) }))
    .filter((c) => c.overlap >= MATCH_THRESHOLD)
    .sort(
      (a, b) =>
        // Topic fit first — it's the thing the user actually asked for.
        b.overlap - a.overlap ||
        // Then seniority fit, so a staff JD isn't handed an easy problem.
        Number(b.row.difficulty === preferred) - Number(a.row.difficulty === preferred) ||
        // Then crowd quality among equals.
        wilsonScore(b.row.upvotes, b.row.downvotes) - wilsonScore(a.row.upvotes, a.row.downvotes),
    )
    .slice(0, MAX_MATCHES);

  return NextResponse.json({
    tags,
    seniority,
    // The best overlap achieved — the client uses this to decide whether to
    // also kick off a tailored generation in the background.
    confidence: ranked[0]?.overlap ?? 0,
    matches: ranked.map((c) => ({ ...toPublicProblem(c.row), overlap: c.overlap })),
  });
}
