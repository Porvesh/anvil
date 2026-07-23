/**
 * Re-score stored attempts against the current grading code (spec B4).
 *
 * This is the payoff for persisting raw submissions rather than only scores:
 * when the matcher or a judge changes, the question "did that actually help
 * anyone?" is answerable against real submissions instead of intuition. It is
 * the only feedback loop the grading layer has.
 *
 * Dry by default — prints the score delta per attempt and does not write. Pass
 * --write to persist the new grades.
 *
 *   npx tsx scripts/regrade.ts                 # compare only
 *   npx tsx scripts/regrade.ts --write         # persist new grades
 *   npx tsx scripts/regrade.ts --type review   # only review attempts
 */
import "../lib/loadEnv";
import { PrismaClient } from "@prisma/client";
import { toProblem } from "../lib/problem";
import { SubmissionModeError, gradeSubmission } from "../lib/grading";
import type { Grade, ProblemType, ReviewComment, RunRecord, SolutionFile, Submission } from "../lib/types";

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const TYPE = args.includes("--type") ? (args[args.indexOf("--type") + 1] as ProblemType) : null;

/**
 * Rebuild a Submission from a stored Attempt. The persisted shape is per-mode
 * and lossy about which mode it was (that lives on the problem), so the
 * problem's type drives reconstruction.
 */
function toSubmission(type: ProblemType, stored: unknown, runHistory: RunRecord[]): Submission | null {
  if (type === "debug") {
    const files = (stored as { files?: SolutionFile[] })?.files;
    return files ? { mode: "debug", files, runHistory } : null;
  }
  if (type === "review") {
    return Array.isArray(stored) ? { mode: "review", comments: stored as ReviewComment[] } : null;
  }
  const doc = (stored as { doc?: string })?.doc;
  return typeof doc === "string" ? { mode: "design", doc } : null;
}

function arrow(before: number, after: number): string {
  const delta = after - before;
  if (delta === 0) return `${before} → ${after}  (no change)`;
  return `${before} → ${after}  (${delta > 0 ? "+" : ""}${delta})`;
}

async function main() {
  // Filtering in code rather than the query: `grade` is a Json column, so
  // "is not null" needs Prisma's JsonNull sentinels, and the attempt table is
  // small enough that it isn't worth the ceremony.
  const rows = await prisma.attempt.findMany({
    include: { problem: true },
    orderBy: { createdAt: "asc" },
  });
  const attempts = rows.filter((a) => a.grade !== null && (!TYPE || a.problem.type === TYPE));

  if (attempts.length === 0) {
    console.log("No graded attempts to re-score.");
    return;
  }

  console.log(`Re-grading ${attempts.length} attempt(s)${TYPE ? ` of type ${TYPE}` : ""}${WRITE ? " [WRITING]" : " [dry run]"}\n`);

  let moved = 0;
  let failed = 0;
  let totalDelta = 0;

  for (const attempt of attempts) {
    const problem = toProblem(attempt.problem);
    const old = attempt.grade as unknown as Grade;
    const submission = toSubmission(problem.type, attempt.submission, (attempt.runHistory ?? []) as unknown as RunRecord[]);

    if (!submission) {
      console.log(`✗ ${attempt.id}  unreadable stored submission for a ${problem.type} problem`);
      failed++;
      continue;
    }

    try {
      const fresh = await gradeSubmission(problem, submission);
      const delta = fresh.score - old.score;
      if (delta !== 0) {
        moved++;
        totalDelta += delta;
      }

      const caughtBefore = old.outcomes.filter((o) => o.status === "caught").length;
      const caughtAfter = fresh.outcomes.filter((o) => o.status === "caught").length;
      console.log(
        `${delta === 0 ? "·" : delta > 0 ? "↑" : "↓"} ${problem.type.padEnd(6)} ${problem.title.slice(0, 44).padEnd(44)} ` +
          `${arrow(old.score, fresh.score)}  caught ${caughtBefore}→${caughtAfter}  fp ${old.falsePositives.length}→${fresh.falsePositives.length}`,
      );

      if (WRITE) {
        await prisma.attempt.update({ where: { id: attempt.id }, data: { grade: fresh as unknown as object } });
      }
    } catch (err) {
      failed++;
      const why = err instanceof SubmissionModeError ? err.message : err instanceof Error ? err.message : String(err);
      console.log(`✗ ${attempt.id}  ${why}`);
    }
  }

  console.log(
    `\n${attempts.length - failed} re-graded, ${moved} moved` +
      (moved ? `, net ${totalDelta > 0 ? "+" : ""}${totalDelta} points` : "") +
      (failed ? `, ${failed} failed` : ""),
  );
  if (!WRITE && moved) console.log("Dry run — re-run with --write to persist.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
