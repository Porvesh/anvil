import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { toSummary } from "@/lib/problem";
import { DIFFICULTIES, PROBLEM_TYPES } from "@/lib/types";
import { wilsonScore } from "@/lib/curation";

export const runtime = "nodejs";

/**
 * GET /api/problems — the shared bank list. Excludes retired problems, filters
 * by `?type=`/`?difficulty=`, and ranks by community quality (Wilson lower
 * bound) or recency via `?sort=top|new`. `?limit=` caps the page.
 *
 * Note (scale): ranking is computed in-code here, which is fine for a bank of
 * hundreds–low thousands. At larger scale this becomes a stored, indexed
 * `rankScore` column updated on each vote — see SCALING.md.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type");
  const difficulty = searchParams.get("difficulty");
  const sort = searchParams.get("sort") === "new" ? "new" : "top";
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") ?? "50", 10) || 50));

  const where: { retired: boolean; type?: string; difficulty?: string } = { retired: false };
  if (type && (PROBLEM_TYPES as string[]).includes(type)) where.type = type;
  if (difficulty && (DIFFICULTIES as string[]).includes(difficulty)) where.difficulty = difficulty;

  const rows = await prisma.problem.findMany({ where, orderBy: { createdAt: "desc" } });

  const summaries = rows.map(toSummary);
  if (sort === "top") {
    const rank = new Map(rows.map((r) => [r.id, wilsonScore(r.upvotes, r.downvotes)]));
    summaries.sort((a, b) => (rank.get(b.id)! - rank.get(a.id)!) || 0);
  }

  return NextResponse.json({ problems: summaries.slice(0, limit) });
}
