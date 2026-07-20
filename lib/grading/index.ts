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
} from "../types";
import { matchReviewComments } from "./matcher";
import { judgeDebug, judgeDesign, judgeReview } from "../anthropic/grade";

/** Clamp to the 0–100 integer range. */
function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
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

  const outcomes: IssueOutcome[] = [
    ...caught.map<IssueOutcome>((c) => ({
      issueId: c.issue.id,
      status: "caught",
      severity: c.issue.severity,
      failure: c.issue.failure,
      explanation: c.issue.explanation,
      matchedOn: c.comment.body,
    })),
    ...missed.map<IssueOutcome>((i) => ({
      issueId: i.id,
      status: "missed",
      severity: i.severity,
      failure: i.failure,
      explanation: i.explanation,
    })),
  ];

  // Only comments the model deems NOT a real issue count as false positives;
  // genuine extra catches are neutral (neither rewarded nor penalized in v1).
  const falsePositives: FalsePositive[] = [];
  unmatched.forEach((comment, idx) => {
    const verdict = judgment.assessments.find((a) => a.index === idx);
    if (verdict && verdict.isRealIssue) return;
    falsePositives.push({ line: comment.line, body: comment.body, note: verdict?.note });
  });

  const total = problem.answerKey.length || 1;
  const recall = caught.length / total;
  const caughtPoints = Math.round(recall * 100);
  const fpPenalty = falsePositives.length * FALSE_POSITIVE_PENALTY;
  const score = clampScore(caughtPoints - fpPenalty);

  const breakdown: ScoreLine[] = [
    {
      label: "Issues caught",
      earned: caughtPoints,
      max: 100,
      detail: `${caught.length}/${problem.answerKey.length} seeded`,
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
  };
}

// ---------------------------------------------------------------------------
// Design
// ---------------------------------------------------------------------------

// Rubric coverage carries the score; judged depth refines it.
const COVERAGE_WEIGHT = 0.7;
const DEPTH_WEIGHT = 0.3;

export async function gradeDesign(problem: Problem, doc: string): Promise<Grade> {
  const judgment = await judgeDesign(problem, doc);

  const outcomes: IssueOutcome[] = problem.answerKey.map<IssueOutcome>((issue) => {
    const verdict = judgment.aspects.find((a) => a.issueId === issue.id);
    const addressed = verdict?.addressed ?? false;
    return {
      issueId: issue.id,
      status: addressed ? "caught" : "missed",
      severity: issue.severity,
      failure: issue.failure,
      explanation: issue.explanation,
      matchedOn: addressed ? verdict?.note : undefined,
    };
  });

  const total = problem.answerKey.length || 1;
  const caughtCount = outcomes.filter((o) => o.status === "caught").length;
  const coverage = (caughtCount / total) * 100;
  const depth = Math.max(0, Math.min(100, judgment.depthScore));
  const coverageEarned = Math.round(coverage * COVERAGE_WEIGHT);
  const depthEarned = Math.round(depth * DEPTH_WEIGHT);
  const score = clampScore(coverageEarned + depthEarned);

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
    testsPassed,
  };
}
