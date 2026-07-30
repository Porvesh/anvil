import { type NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { toProblem } from "@/lib/problem";
import { SubmissionModeError, gradeSubmission } from "@/lib/grading";
import { gradeBodySchema } from "@/lib/validation";
import { clientKey, rateLimit } from "@/lib/ratelimit";
import type { RunRecord } from "@/lib/types";
import { classifyModelError, isAbortError } from "@/lib/anthropic/reliability";
import { byokRequiredResponse, userModelFromRequest } from "@/lib/anthropic/byok";

export const runtime = "nodejs";

/**
 * POST /api/grade — grade a submission against the hidden answer key and persist
 * the attempt. Returns { attemptId, grade }; the results screen then drives the
 * Socratic follow-up via /api/socratic using the attemptId.
 */
export async function POST(req: NextRequest) {
  const limit = rateLimit(clientKey(req));
  if (!limit.ok) {
    return NextResponse.json({ error: "Rate limit exceeded — try again shortly." }, { status: 429 });
  }
  const client = userModelFromRequest(req);
  if (!client) return byokRequiredResponse();

  const parsed = gradeBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
  }
  const { problemId, sessionId, submission } = parsed.data;

  const row = await prisma.problem.findUnique({ where: { id: problemId } });
  if (!row) return NextResponse.json({ error: "Problem not found" }, { status: 404 });
  const problem = toProblem(row);

  let grade;
  try {
    grade = await gradeSubmission(client, problem, submission, req.signal);
  } catch (err) {
    if (err instanceof SubmissionModeError) {
      return NextResponse.json({ error: "Submission mode does not match problem type" }, { status: 400 });
    }
    if (isAbortError(err) || req.signal.aborted) {
      return NextResponse.json({ error: "Grading cancelled", code: "cancelled", retryable: false }, { status: 499 });
    }
    const info = classifyModelError(err, "grading");
    return NextResponse.json(
      { error: info.message, code: info.code, retryable: info.retryable },
      { status: info.status },
    );
  }

  // Persist the submission in the shape the re-grade path reads back, so a
  // stored attempt can be re-scored against a future grading change.
  const storedSubmission: unknown =
    submission.mode === "debug"
      ? { files: submission.files }
      : submission.mode === "review"
        ? submission.comments
        : { doc: submission.doc };
  const runHistory: RunRecord[] | undefined = submission.mode === "debug" ? submission.runHistory : undefined;

  let attempt;
  try {
    [attempt] = await prisma.$transaction([
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
  } catch {
    return NextResponse.json(
      {
        error: "Your grade was computed but could not be saved. Your draft is safe; try again.",
        code: "persistence",
        retryable: true,
      },
      { status: 503 },
    );
  }

  return NextResponse.json({ attemptId: attempt.id, grade });
}
