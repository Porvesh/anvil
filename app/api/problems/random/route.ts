import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { DIFFICULTIES, PROBLEM_TYPES } from "@/lib/types";

export const runtime = "nodejs";

/**
 * GET /api/problems/random — pick a random non-retired problem, for the shuffle
 * / "next problem" action. Uses count + random skip (two cheap indexed queries)
 * rather than loading the table, so it stays O(1)-ish as the bank grows.
 * `?exclude=` avoids handing back the problem the user just finished.
 */
/**
 * A stable row order is what makes `skip` mean anything.
 *
 * Without an explicit `orderBy` the database may return rows in a different
 * order for each query, so a random `skip` doesn't sample the set — it lands
 * somewhere unpredictable. Measured on a 4-problem set, `skip: 0` and `skip: 2`
 * both returned the same row and one problem was unreachable at every skip
 * value, i.e. shuffle could never serve it. Ordering by the primary key costs
 * nothing (it's the clustered index) and makes skip a true 1:1 selector.
 */
const STABLE_ORDER = { id: "asc" } as const;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type");
  const difficulty = searchParams.get("difficulty");
  const exclude = searchParams.get("exclude");

  const where: { retired: boolean; type?: string; difficulty?: string; id?: { not: string } } = { retired: false };
  if (type && (PROBLEM_TYPES as string[]).includes(type)) where.type = type;
  if (difficulty && (DIFFICULTIES as string[]).includes(difficulty)) where.difficulty = difficulty;
  if (exclude) where.id = { not: exclude };

  const count = await prisma.problem.count({ where });
  if (count === 0) {
    // Fall back to ignoring the exclusion (bank may have only one match).
    delete where.id;
    const total = await prisma.problem.count({ where });
    if (total === 0) return NextResponse.json({ id: null });
    const row = await prisma.problem.findFirst({ where, orderBy: STABLE_ORDER, skip: Math.floor(Math.random() * total), select: { id: true } });
    return NextResponse.json({ id: row?.id ?? null });
  }

  const row = await prisma.problem.findFirst({ where, orderBy: STABLE_ORDER, skip: Math.floor(Math.random() * count), select: { id: true } });
  return NextResponse.json({ id: row?.id ?? null });
}
