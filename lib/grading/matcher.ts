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

/** How a comment came to be credited — exact hits outrank looser matches. */
export type MatchKind = "exact" | "adjacent" | "anchor";

export interface CaughtMatch {
  issue: AnswerKeyIssue;
  comment: ReviewComment;
  /** Whether the comment text also overlaps the issue's keywords (stronger signal). */
  keywordHit: boolean;
  /** Which rule credited this match (see MatchKind). */
  kind: MatchKind;
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

/**
 * Is this comment even on the same file as this issue?
 *
 * Line numbers restart in every file, so without this check a comment on line 42
 * of one file is credited for an issue on line 42 of another — the bigger and
 * more multi-file the PR, the more often that collides, and it reads as the
 * grader inventing a catch the user never made.
 *
 * Falls back to line-only when either side omits the path: single-file problems
 * (and attempts stored before comments carried one) are unambiguous anyway, and
 * failing them closed would retroactively un-catch real catches.
 */
export function sameFile(comment: ReviewComment, issue: AnswerKeyIssue): boolean {
  if (!comment.file || !issue.file) return true;
  return comment.file === issue.file;
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
    const candidates = comments
      .map((comment, idx) => ({ comment, idx, kind: classify(comment, issue) }))
      .filter((c): c is typeof c & { kind: MatchKind } => !usedComments.has(c.idx) && c.kind !== null)
      // Prefer the strongest rule, then the closest line — so an exact hit is
      // never displaced by a keyword-gated anchor further away.
      .sort((a, b) => RANK[a.kind] - RANK[b.kind] || distanceToIssue(a.comment.line, issue) - distanceToIssue(b.comment.line, issue));

    if (candidates.length === 0) {
      missed.push(issue);
      continue;
    }

    const { comment, idx, kind } = candidates[0];
    usedComments.add(idx);
    caught.push({
      issue,
      comment,
      keywordHit: hasKeywordHit(comment.body, issue.keywords),
      kind,
    });
  }

  const unmatched = comments.filter((_, idx) => !usedComments.has(idx));
  return { caught, missed, unmatched };
}

/** Strength order: an exact line hit beats adjacency, which beats an anchor. */
const RANK: Record<MatchKind, number> = { exact: 0, adjacent: 1, anchor: 2 };

/**
 * Decide whether (and how) a comment is credited to an issue. Null = no match.
 *
 * Three rules, loosest last:
 *  - **exact** — the comment lands inside the issue's line range. No keyword
 *    check: the user pointed straight at it, whatever words they used.
 *  - **adjacent** — within ±1 line AND the text mentions the issue's keywords.
 *    The keyword gate is the whole trick; without it an unrelated comment on a
 *    neighbouring line gets miscredited, which reads as the grader inventing a
 *    catch the user didn't make.
 *  - **anchor** — on a generator-declared conceptual site AND keyword-gated.
 *    Same gate, wider reach; see AnswerKeyIssue.anchors.
 */
function classify(comment: ReviewComment, issue: AnswerKeyIssue): MatchKind | null {
  // Every rule below is a line-coordinate test, so all of them are meaningless
  // across files. Gate once, here.
  if (!sameFile(comment, issue)) return null;
  if (withinIssue(comment.line, issue, 0)) return "exact";
  const keywordHit = hasKeywordHit(comment.body, issue.keywords);
  if (!keywordHit) return null;
  if (withinIssue(comment.line, issue)) return "adjacent";
  if (issue.anchors?.includes(comment.line)) return "anchor";
  return null;
}

/** Distance from a line to the nearest edge of an issue's range (0 if inside). */
function distanceToIssue(line: number, issue: AnswerKeyIssue): number {
  if (line < issue.lineStart) return issue.lineStart - line;
  if (line > issue.lineEnd) return line - issue.lineEnd;
  return 0;
}
