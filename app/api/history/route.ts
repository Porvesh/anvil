import { type NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ownerFilter, resolveOwner } from "@/lib/auth/identity";
import type { Grade, ProblemType, Difficulty } from "@/lib/types";

export const runtime = "nodejs";

/** Attempts are cheap to render and one owner accumulates slowly; cap anyway. */
const MAX_ATTEMPTS = 100;

/**
 * GET /api/history?sessionId= — the caller's own attempt history.
 *
 * Scoped strictly to the caller: attempts carry submitted code and a graded
 * transcript, so this must never become a way to read someone else's work. Who
 * "the caller" is depends on the account cookie — signed in, it is every attempt
 * the account owns across devices; anonymous, only this browser's unclaimed ones
 * (see lib/auth/identity.ts). The anonymous id is an unguessable client-generated
 * uuid, which is the bar the rest of the anonymous design sets (spec §14).
 */
export async function GET(req: NextRequest) {
  const sessionId = new URL(req.url).searchParams.get("sessionId");
  const owner = resolveOwner(req, sessionId ?? "");
  if (!owner.userId && !sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  const rows = await prisma.attempt.findMany({
    where: ownerFilter(owner),
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

  return NextResponse.json(
    { attempts, signedIn: Boolean(owner.userId), email: owner.email },
    { headers: { "Cache-Control": "no-store" } },
  );
}
