import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { toPublicProblem } from "@/lib/problem";

/**
 * GET /api/problems/[id] — one problem for the solve view. The answer key is
 * stripped by toPublicProblem so ground truth never reaches the browser.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = await prisma.problem.findUnique({ where: { id } });
  if (!row) return NextResponse.json({ error: "Problem not found" }, { status: 404 });
  return NextResponse.json({ problem: toPublicProblem(row) });
}
