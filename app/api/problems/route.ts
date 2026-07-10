import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { toSummary } from "@/lib/problem";
import { DIFFICULTIES, PROBLEM_TYPES } from "@/lib/types";

/**
 * GET /api/problems — the shared bank list. Optional `?type=` and `?difficulty=`
 * filters. Returns compact summaries (no code, no answer key).
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type");
  const difficulty = searchParams.get("difficulty");

  const where: { type?: string; difficulty?: string } = {};
  if (type && (PROBLEM_TYPES as string[]).includes(type)) where.type = type;
  if (difficulty && (DIFFICULTIES as string[]).includes(difficulty)) where.difficulty = difficulty;

  const rows = await prisma.problem.findMany({ where, orderBy: { createdAt: "desc" } });
  return NextResponse.json({ problems: rows.map(toSummary) });
}
