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
} from "../types";
import { matchReviewComments } from "./matcher";
import { judgeDebug, judgeReview } from "../anthropic/grade";

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
  const judgment = await judgeReview(problem, unmatched);

  const outcomes: IssueOutcome[] = [
    ...caught.map<IssueOutcome>((c) => ({
      issueId: c.issue.id,
      status: "caught",
      failure: c.issue.failure,
      explanation: c.issue.explanation,
      matchedOn: c.comment.body,
    })),
    ...missed.map<IssueOutcome>((i) => ({
      issueId: i.id,
      status: "missed",
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
  const score = clampScore(recall * 100 - falsePositives.length * FALSE_POSITIVE_PENALTY);

  return {
    score,
    headline: judgment.headline,
    summary: judgment.summary,
    outcomes,
    falsePositives,
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
  finalCode: string,
  runHistory: RunRecord[],
  testsPassed: boolean,
): Promise<Grade> {
  const judgment = await judgeDebug(problem, finalCode, runHistory, testsPassed);

  const outcomes: IssueOutcome[] = problem.answerKey.map<IssueOutcome>((issue) => {
    const verdict = judgment.issues.find((i) => i.issueId === issue.id);
    const addressed = verdict?.addressed ?? testsPassed;
    return {
      issueId: issue.id,
      status: addressed ? "caught" : "missed",
      failure: issue.failure,
      explanation: issue.explanation,
      matchedOn: verdict?.note,
    };
  });

  const objective = testsPassed ? 100 : 0;
  const score = clampScore(objective * OBJECTIVE_WEIGHT + judgment.approachScore * APPROACH_WEIGHT);

  return {
    score,
    headline: judgment.headline,
    summary: judgment.summary,
    outcomes,
    falsePositives: [],
    testsPassed,
  };
}
