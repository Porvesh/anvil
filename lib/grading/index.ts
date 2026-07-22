/**
 * Grading assembly (spec §12). Combines the deterministic line-anchor matcher
 * with the model judgment layer and computes an explainable score. Scoring is
 * kept in code (not the model) so the number is reproducible and defensible —
 * the model contributes qualitative judgment, not the grade itself.
 */
import type {
  FalsePositive,
  Grade,
  IssueOutcome,
  Problem,
  ReviewComment,
  RunRecord,
  ScoreLine,
  SolutionFile,
  Submission,
} from "../types";
import { CALLS } from "../anthropic/models";
import { matchReviewComments } from "./matcher";
import { judgeDebug, judgeDesign, judgeReview } from "../anthropic/grade";

/** Clamp to the 0–100 integer range. */
function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Debug's objective signal: the final recorded run went fully green. */
export function testsPassedFrom(runHistory: RunRecord[]): boolean {
  const last = runHistory.at(-1);
  return !!last && last.failed === 0 && last.passed > 0;
}

/** Raised when a submission's mode doesn't match the problem it claims to answer. */
export class SubmissionModeError extends Error {
  constructor(mode: string, type: string) {
    super(`submission mode "${mode}" does not match problem type "${type}"`);
    this.name = "SubmissionModeError";
  }
}

/**
 * Dispatch a submission to the right grader.
 *
 * Shared by the live grade route and the re-grade script (scripts/regrade.ts),
 * so a stored Attempt is always re-scored through exactly the path that
 * produced it — if these drifted, a re-grade comparison would measure the drift
 * rather than the grading change it was meant to evaluate.
 */
export async function gradeSubmission(problem: Problem, submission: Submission): Promise<Grade> {
  if (submission.mode !== problem.type) {
    throw new SubmissionModeError(submission.mode, problem.type);
  }
  switch (submission.mode) {
    case "debug":
      return gradeDebug(problem, submission.files, submission.runHistory, testsPassedFrom(submission.runHistory));
    case "review":
      return gradeReview(problem, submission.comments);
    case "design":
      return gradeDesign(problem, submission.doc);
  }
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

/** Each confirmed false positive costs this many points. */
const FALSE_POSITIVE_PENALTY = 12;

export async function gradeReview(
  problem: Problem,
  comments: ReviewComment[],
): Promise<Grade> {
  const { caught, missed, unmatched } = matchReviewComments(comments, problem.answerKey);
  const judgment = await judgeReview(problem, unmatched, {
    caughtIds: caught.map((c) => c.issue.id),
    missedIds: missed.map((i) => i.id),
  });

  // The matcher decides catches by line number, which systematically
  // under-credits reviewers who comment at the conceptual site rather than the
  // defect (B4). The judge gets to rescue those: if it recognises an unmatched
  // comment as describing a missed issue, that issue is re-credited as caught.
  // Only *missed* issues can be rescued, and only once each, so this can never
  // inflate recall past what the matcher already found.
  const missedById = new Map(missed.map((i) => [i.id, i]));
  const rescued = new Map<string, ReviewComment>();
  unmatched.forEach((comment, idx) => {
    const verdict = judgment.assessments.find((a) => a.index === idx);
    const id = verdict?.matchedIssueId;
    if (!id || !missedById.has(id) || rescued.has(id)) return;
    rescued.set(id, comment);
  });

  const stillMissed = missed.filter((i) => !rescued.has(i.id));

  const outcomes: IssueOutcome[] = [
    ...caught.map<IssueOutcome>((c) => ({
      issueId: c.issue.id,
      status: "caught",
      severity: c.issue.severity,
      failure: c.issue.failure,
      explanation: c.issue.explanation,
      matchedOn: c.comment.body,
    })),
    ...[...rescued].map<IssueOutcome>(([id, comment]) => {
      const issue = missedById.get(id)!;
      return {
        issueId: issue.id,
        status: "caught",
        severity: issue.severity,
        failure: issue.failure,
        explanation: issue.explanation,
        matchedOn: comment.body,
      };
    }),
    ...stillMissed.map<IssueOutcome>((i) => ({
      issueId: i.id,
      status: "missed",
      severity: i.severity,
      failure: i.failure,
      explanation: i.explanation,
    })),
  ];

  // A comment is a false positive only if the model judged it neither a real
  // issue nor a rescued catch. Rescued comments were right about a seeded flaw,
  // so penalizing them would deduct 12 points for being correct.
  const rescuedComments = new Set(rescued.values());
  const falsePositives: FalsePositive[] = [];
  unmatched.forEach((comment, idx) => {
    if (rescuedComments.has(comment)) return;
    const verdict = judgment.assessments.find((a) => a.index === idx);
    if (verdict && verdict.isRealIssue) return;
    falsePositives.push({ line: comment.line, body: comment.body, note: verdict?.note });
  });

  const total = problem.answerKey.length || 1;
  const caughtCount = caught.length + rescued.size;
  const recall = caughtCount / total;
  const caughtPoints = Math.round(recall * 100);
  const fpPenalty = falsePositives.length * FALSE_POSITIVE_PENALTY;
  const score = clampScore(caughtPoints - fpPenalty);

  const breakdown: ScoreLine[] = [
    {
      label: "Issues caught",
      earned: caughtPoints,
      max: 100,
      detail:
        `${caughtCount}/${problem.answerKey.length} seeded` +
        (rescued.size ? ` (${rescued.size} credited off-line)` : ""),
    },
  ];
  if (falsePositives.length > 0) {
    breakdown.push({
      label: "False positives",
      earned: -fpPenalty,
      max: 0,
      detail: `${falsePositives.length} × −${FALSE_POSITIVE_PENALTY}`,
    });
  }

  return {
    score,
    headline: judgment.headline,
    summary: judgment.summary,
    outcomes,
    falsePositives,
    breakdown,
    graderModel: CALLS.judgeReview.model,
  };
}

// ---------------------------------------------------------------------------
// Design
// ---------------------------------------------------------------------------

// Rubric coverage carries the score; judged depth refines it.
const COVERAGE_WEIGHT = 0.7;
const DEPTH_WEIGHT = 0.3;

/** Two judges disagreeing by more than this flags the *rubric*, not the user. */
const DIVERGENCE_THRESHOLD = 15;

/**
 * Grade a design doc.
 *
 * Design is the only mode with no deterministic layer beneath it — there is no
 * matcher and no test suite, so the model's read *is* the score. Everywhere
 * else a bad judgment shifts a number that has an objective floor; here it is
 * the whole number. So this is the one place worth paying for an ensemble: two
 * independent judgments, averaged.
 *
 * Averaging (rather than requiring agreement) is deliberate. Requiring both
 * judges to agree an aspect was addressed would bias every design score
 * downward, punishing the user for the graders' disagreement. Averaging leaves
 * the expected score unchanged and just reduces its variance, which is the
 * actual problem.
 *
 * The spread between the two is recorded as `judgeDivergence`. A design problem
 * whose judges routinely disagree has an ambiguous rubric — that is a signal
 * about the *problem*, and belongs with the curation data rather than in front
 * of the user.
 */
export async function gradeDesign(problem: Problem, doc: string): Promise<Grade> {
  const [first, second] = await Promise.all([judgeDesign(problem, doc), judgeDesign(problem, doc)]);

  const total = problem.answerKey.length || 1;
  const addressedCount = (j: typeof first) =>
    problem.answerKey.filter((issue) => j.aspects.find((a) => a.issueId === issue.id)?.addressed).length;

  const coverage = ((addressedCount(first) + addressedCount(second)) / 2 / total) * 100;
  const depth = (clampScore(first.depthScore) + clampScore(second.depthScore)) / 2;

  // Per-judge assembled scores, compared only to measure the spread.
  const assemble = (j: typeof first) =>
    clampScore((addressedCount(j) / total) * 100 * COVERAGE_WEIGHT + clampScore(j.depthScore) * DEPTH_WEIGHT);
  const judgeDivergence = Math.abs(assemble(first) - assemble(second));

  // For the results screen, an aspect shows as addressed if either judge found
  // it — matching the averaged score's generosity rather than contradicting it.
  const outcomes: IssueOutcome[] = problem.answerKey.map<IssueOutcome>((issue) => {
    const a = first.aspects.find((x) => x.issueId === issue.id);
    const b = second.aspects.find((x) => x.issueId === issue.id);
    const addressed = Boolean(a?.addressed || b?.addressed);
    const contested = Boolean(a?.addressed) !== Boolean(b?.addressed);
    return {
      issueId: issue.id,
      status: addressed ? "caught" : "missed",
      severity: issue.severity,
      failure: issue.failure,
      explanation: issue.explanation,
      // Prefer the note from whichever judge credited it; mark partial credit
      // honestly rather than implying both graders were convinced.
      matchedOn: addressed
        ? `${(a?.addressed ? a.note : b?.note) ?? ""}${contested ? " (partially addressed)" : ""}`.trim()
        : undefined,
    };
  });

  const caughtCount = outcomes.filter((o) => o.status === "caught").length;
  const coverageEarned = Math.round(coverage * COVERAGE_WEIGHT);
  const depthEarned = Math.round(depth * DEPTH_WEIGHT);
  const score = clampScore(coverageEarned + depthEarned);
  const judgment = first;

  const breakdown: ScoreLine[] = [
    {
      label: "Rubric coverage",
      earned: coverageEarned,
      max: Math.round(100 * COVERAGE_WEIGHT),
      detail: `${caughtCount}/${problem.answerKey.length} dimensions`,
    },
    {
      label: "Depth",
      earned: depthEarned,
      max: Math.round(100 * DEPTH_WEIGHT),
      detail: "capacity math, trade-offs, failure modes",
    },
  ];

  return {
    score,
    headline: judgment.headline,
    summary: judgment.summary,
    outcomes,
    falsePositives: [],
    breakdown,
    graderModel: CALLS.judgeDesign.model,
    judgeDivergence,
    rubricAmbiguous: judgeDivergence > DIVERGENCE_THRESHOLD,
  };
}

// ---------------------------------------------------------------------------
// Debug
// ---------------------------------------------------------------------------

// Objective (tests pass) vs. approach quality weighting.
const OBJECTIVE_WEIGHT = 0.55;
const APPROACH_WEIGHT = 0.45;

export async function gradeDebug(
  problem: Problem,
  finalFiles: SolutionFile[],
  runHistory: RunRecord[],
  testsPassed: boolean,
): Promise<Grade> {
  const judgment = await judgeDebug(problem, finalFiles, runHistory, testsPassed);

  const outcomes: IssueOutcome[] = problem.answerKey.map<IssueOutcome>((issue) => {
    const verdict = judgment.issues.find((i) => i.issueId === issue.id);
    const addressed = verdict?.addressed ?? testsPassed;
    return {
      issueId: issue.id,
      status: addressed ? "caught" : "missed",
      severity: issue.severity,
      failure: issue.failure,
      explanation: issue.explanation,
      matchedOn: verdict?.note,
    };
  });

  const objective = testsPassed ? 100 : 0;
  const objectiveEarned = Math.round(objective * OBJECTIVE_WEIGHT);
  const approachEarned = Math.round(judgment.approachScore * APPROACH_WEIGHT);
  const score = clampScore(objectiveEarned + approachEarned);

  const breakdown: ScoreLine[] = [
    {
      label: "Tests pass",
      earned: objectiveEarned,
      max: Math.round(100 * OBJECTIVE_WEIGHT),
      detail: testsPassed ? "all green" : "still failing",
    },
    {
      label: "Approach quality",
      earned: approachEarned,
      max: Math.round(100 * APPROACH_WEIGHT),
      detail: "root-cause vs. symptom-masking",
    },
  ];

  return {
    score,
    headline: judgment.headline,
    summary: judgment.summary,
    outcomes,
    falsePositives: [],
    breakdown,
    graderModel: CALLS.judgeDebug.model,
    testsPassed,
  };
}
