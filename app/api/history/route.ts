import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import type { Grade, ProblemType, Difficulty } from "@/lib/types";

export const runtime = "nodejs";

/** Attempts are cheap to render and a session accumulates slowly; cap anyway. */
const MAX_ATTEMPTS = 100;

/**
 * GET /api/history?sessionId= — this browser's own attempt history.
 *
 * Attempts have always been written with a sessionId (lib/session.ts) but had no
 * read path, so the History nav entry had nowhere to go. Scoped strictly to the
 * caller's session id: attempts carry submitted code and a graded transcript, so
 * this must never become a way to read someone else's work. The id is an
 * unguessable client-generated uuid, which is the same bar as the rest of the
 * anonymous-session design (spec §14) — there is no login to check it against.
 */
export async function GET(req: Request) {
  const sessionId = new URL(req.url).searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  const rows = await prisma.attempt.findMany({
    where: { sessionId },
    orderBy: { createdAt: "desc" },
    take: MAX_ATTEMPTS,
    select: {
      id: true,
      createdAt: true,
      grade: true,
      problem: { select: { id: true, title: true, type: true, difficulty: true } },
    },
  });

  // Only the headline numbers travel: the full grade carries the answer key's
  // explanations, which would spoil a re-attempt of a problem still in the bank.
  const attempts = rows.map((row) => {
    const grade = (row.grade ?? null) as Grade | null;
    const outcomes = grade?.outcomes ?? [];
    return {
      id: row.id,
      at: row.createdAt.toISOString(),
      problemId: row.problem.id,
      title: row.problem.title,
      type: row.problem.type as ProblemType,
      difficulty: row.problem.difficulty as Difficulty,
      score: grade?.score ?? null,
      caught: outcomes.filter((o) => o.status === "caught").length,
      // Total seeded issues, so "2 of 3" reads correctly on a partial catch.
      total: outcomes.length,
      falsePositives: grade?.falsePositives?.length ?? 0,
      // A graded attempt that found nothing differs from one never graded.
      graded: grade !== null,
    };
  });

  return NextResponse.json({ attempts });
}
