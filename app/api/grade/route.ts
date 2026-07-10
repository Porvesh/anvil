import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { toProblem } from "@/lib/problem";
import { gradeDebug, gradeDesign, gradeReview } from "@/lib/grading";
import { gradeBodySchema } from "@/lib/validation";
import { clientKey, rateLimit } from "@/lib/ratelimit";
import type { RunRecord } from "@/lib/types";

export const runtime = "nodejs";

/** Objective signal for debug: the final run went fully green. */
function testsPassedFrom(runHistory: RunRecord[]): boolean {
  const last = runHistory.at(-1);
  return !!last && last.failed === 0 && last.passed > 0;
}

/**
 * POST /api/grade — grade a submission against the hidden answer key and persist
 * the attempt. Returns { attemptId, grade }; the results screen then drives the
 * Socratic follow-up via /api/socratic using the attemptId.
 */
export async function POST(req: Request) {
  const limit = rateLimit(clientKey(req));
  if (!limit.ok) {
    return NextResponse.json({ error: "Rate limit exceeded — try again shortly." }, { status: 429 });
  }

  const parsed = gradeBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
  }
  const { problemId, sessionId, submission } = parsed.data;

  const row = await prisma.problem.findUnique({ where: { id: problemId } });
  if (!row) return NextResponse.json({ error: "Problem not found" }, { status: 404 });
  const problem = toProblem(row);

  // Grade + assemble the stored submission shape per mode.
  let grade;
  let storedSubmission: unknown;
  let runHistory: RunRecord[] | undefined;

  if (submission.mode === "debug") {
    if (problem.type !== "debug") {
      return NextResponse.json({ error: "Submission mode does not match problem type" }, { status: 400 });
    }
    const testsPassed = testsPassedFrom(submission.runHistory);
    grade = await gradeDebug(problem, submission.files, submission.runHistory, testsPassed);
    storedSubmission = { files: submission.files };
    runHistory = submission.runHistory;
  } else if (submission.mode === "review") {
    if (problem.type !== "review") {
      return NextResponse.json({ error: "Submission mode does not match problem type" }, { status: 400 });
    }
    grade = await gradeReview(problem, submission.comments);
    storedSubmission = submission.comments;
  } else {
    if (problem.type !== "design") {
      return NextResponse.json({ error: "Submission mode does not match problem type" }, { status: 400 });
    }
    grade = await gradeDesign(problem, submission.doc);
    storedSubmission = { doc: submission.doc };
  }

  const [attempt] = await prisma.$transaction([
    prisma.attempt.create({
      data: {
        problemId,
        sessionId,
        submission: storedSubmission as object,
        runHistory: (runHistory ?? undefined) as object | undefined,
        grade: grade as unknown as object,
      },
    }),
    // Popularity signal for the bank — atomic so concurrent solvers don't clobber.
    prisma.problem.update({ where: { id: problemId }, data: { timesAttempted: { increment: 1 } } }),
  ]);

  return NextResponse.json({ attemptId: attempt.id, grade });
}
