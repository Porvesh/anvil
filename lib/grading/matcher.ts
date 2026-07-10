/**
 * Deterministic grading core (spec §10, §12).
 *
 * Because the generator seeds the flaws, the answer key is keyed by line range.
 * Grading a review therefore reduces to a coordinate check: did the user attach
 * a comment inside the hunk where a seeded issue lives? caught / missed /
 * false-positive falls out of comparing comment anchors to answer-key ranges.
 *
 * This module is pure and side-effect free so it can be unit tested without a DB
 * or a model call. The model layer (lib/anthropic) refines these results with
 * precision judgment and the Socratic follow-up.
 */
import type { AnswerKeyIssue, ReviewComment } from "../types";

/** Line-anchor tolerance: a comment within ±1 line of an issue's range still
 *  counts, since reviewers often comment on the line above/below the exact one.
 *  Spec §17 flags this threshold as needing care to avoid false "you missed it". */
export const ANCHOR_TOLERANCE = 1;

export interface CaughtMatch {
  issue: AnswerKeyIssue;
  comment: ReviewComment;
  /** Whether the comment text also overlaps the issue's keywords (stronger signal). */
  keywordHit: boolean;
}

export interface ReviewMatchResult {
  caught: CaughtMatch[];
  missed: AnswerKeyIssue[];
  /** Comments that matched no seeded issue — candidate false positives. */
  unmatched: ReviewComment[];
}

/** True when `line` falls within an issue's range, allowing for tolerance. */
export function withinIssue(line: number, issue: AnswerKeyIssue, tol = ANCHOR_TOLERANCE): boolean {
  return line >= issue.lineStart - tol && line <= issue.lineEnd + tol;
}

/** Does the comment body mention any of the issue's keywords? (case-insensitive) */
export function hasKeywordHit(body: string, keywords: string[]): boolean {
  const text = body.toLowerCase();
  return keywords.some((k) => k && text.includes(k.toLowerCase()));
}

/**
 * Match a user's line comments against the seeded answer key.
 *
 * Each issue is caught by the *closest* anchored comment (so one comment can't
 * claim several issues, and each issue is credited to its best comment). Any
 * comment not tied to an issue is returned as `unmatched` for the model to judge
 * as a real false positive vs. a valid extra observation.
 */
export function matchReviewComments(
  comments: ReviewComment[],
  answerKey: AnswerKeyIssue[],
): ReviewMatchResult {
  const usedComments = new Set<number>();
  const caught: CaughtMatch[] = [];
  const missed: AnswerKeyIssue[] = [];

  for (const issue of answerKey) {
    // Candidate comments anchored within this issue's range, nearest first.
    const candidates = comments
      .map((comment, idx) => ({ comment, idx }))
      .filter(({ comment, idx }) => !usedComments.has(idx) && withinIssue(comment.line, issue))
      .sort((a, b) => distanceToIssue(a.comment.line, issue) - distanceToIssue(b.comment.line, issue));

    if (candidates.length === 0) {
      missed.push(issue);
      continue;
    }

    const { comment, idx } = candidates[0];
    usedComments.add(idx);
    caught.push({
      issue,
      comment,
      keywordHit: hasKeywordHit(comment.body, issue.keywords),
    });
  }

  const unmatched = comments.filter((_, idx) => !usedComments.has(idx));
  return { caught, missed, unmatched };
}

/** Distance from a line to the nearest edge of an issue's range (0 if inside). */
function distanceToIssue(line: number, issue: AnswerKeyIssue): number {
  if (line < issue.lineStart) return issue.lineStart - line;
  if (line > issue.lineEnd) return line - issue.lineEnd;
  return 0;
}
