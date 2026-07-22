/**
 * Unit tests for the deterministic grading core (lib/grading/matcher.ts). This
 * is the load-bearing logic — caught/missed/false-positive falls out of here —
 * so it's tested independently of the DB and model calls.
 */
import { describe, it, expect } from "vitest";
import { matchReviewComments } from "../lib/grading/matcher";
import type { AnswerKeyIssue, ReviewComment } from "../lib/types";

const KEY: AnswerKeyIssue[] = [
  {
    id: "unbounded",
    lineStart: 42,
    lineEnd: 42,
    severity: "major",
    failure: "unbounded retry",
    explanation: "…",
    keywords: ["while true", "unbounded", "max attempts"],
  },
  {
    id: "broad-except",
    lineStart: 46,
    lineEnd: 46,
    severity: "minor",
    failure: "broad except",
    explanation: "…",
    keywords: ["except exception", "swallow"],
  },
];

/** An "absent guard" flaw: the defect is at line 88, but the conceptual site is
 *  the function signature at 80, where strong reviewers actually comment. */
const ANCHORED: AnswerKeyIssue[] = [
  {
    id: "no-idempotency",
    lineStart: 88,
    lineEnd: 88,
    anchors: [80, 81],
    severity: "critical",
    failure: "duplicate charge on webhook retry",
    explanation: "…",
    keywords: ["idempotency", "duplicate", "retry"],
  },
];

const c = (line: number, body: string): ReviewComment => ({ line, body });

describe("matchReviewComments", () => {
  it("credits a comment on the exact buggy line as caught, regardless of wording", () => {
    const r = matchReviewComments([c(42, "this never terminates")], KEY);
    expect(r.caught.map((x) => x.issue.id)).toEqual(["unbounded"]);
    expect(r.missed.map((x) => x.id)).toEqual(["broad-except"]);
    expect(r.unmatched).toHaveLength(0);
  });

  it("reports an issue with no nearby comment as missed", () => {
    const r = matchReviewComments([], KEY);
    expect(r.caught).toHaveLength(0);
    expect(r.missed.map((x) => x.id)).toEqual(["unbounded", "broad-except"]);
  });

  it("credits an adjacent comment only when its text hits the issue keywords", () => {
    // line 45 is within ±1 of the broad-except issue (46) AND mentions 'swallow'
    const r = matchReviewComments([c(45, "this swallows real errors")], KEY);
    expect(r.caught.map((x) => x.issue.id)).toEqual(["broad-except"]);
  });

  it("does NOT credit an adjacent off-topic comment (the false-'caught' bug)", () => {
    // line 47 is ±1 of broad-except (46) but is about sleep, not the exception
    const r = matchReviewComments([c(47, "sleep(1) is too short")], KEY);
    expect(r.caught).toHaveLength(0);
    expect(r.missed.map((x) => x.id)).toContain("broad-except");
    expect(r.unmatched).toHaveLength(1);
  });

  it("treats an unrelated far-away comment as a false positive (unmatched)", () => {
    const r = matchReviewComments([c(10, "nit: rename this variable")], KEY);
    expect(r.caught).toHaveLength(0);
    expect(r.unmatched).toHaveLength(1);
  });

  it("does not let one comment claim two issues", () => {
    // A single comment near both lines should be credited to only the nearest.
    const near: AnswerKeyIssue[] = [
      { ...KEY[0], lineStart: 44, lineEnd: 44 },
      { ...KEY[1], lineStart: 45, lineEnd: 45 },
    ];
    const r = matchReviewComments([c(44, "while true unbounded loop")], near);
    expect(r.caught).toHaveLength(1);
    expect(r.caught[0].issue.id).toBe("unbounded");
  });
});

describe("matchReviewComments — conceptual-site anchors (B4)", () => {
  it("credits a keyword-bearing comment on a declared anchor line", () => {
    // The reviewer flagged the missing guard at the function signature (80)
    // rather than the line that technically lacks it (88). Same insight.
    const r = matchReviewComments([c(80, "no idempotency key here — a retry double-charges")], ANCHORED);
    expect(r.caught.map((x) => x.issue.id)).toEqual(["no-idempotency"]);
    expect(r.caught[0].kind).toBe("anchor");
    expect(r.unmatched).toHaveLength(0);
  });

  it("keyword-gates anchors, so an unrelated comment on one is not a catch", () => {
    const r = matchReviewComments([c(80, "nit: this function name is vague")], ANCHORED);
    expect(r.caught).toHaveLength(0);
    expect(r.missed.map((x) => x.id)).toEqual(["no-idempotency"]);
    expect(r.unmatched).toHaveLength(1);
  });

  it("ignores lines that are neither in range, adjacent, nor anchored", () => {
    const r = matchReviewComments([c(60, "idempotency matters somewhere")], ANCHORED);
    expect(r.caught).toHaveLength(0);
    expect(r.unmatched).toHaveLength(1);
  });

  it("prefers the exact line over an anchor when both are commented", () => {
    const r = matchReviewComments(
      [c(80, "idempotency concern in this handler"), c(88, "this write is not idempotent")],
      ANCHORED,
    );
    expect(r.caught).toHaveLength(1);
    expect(r.caught[0].kind).toBe("exact");
    expect(r.caught[0].comment.line).toBe(88);
    // The anchor comment stays unmatched — the judge decides if it's a real
    // extra observation or a false positive.
    expect(r.unmatched.map((x) => x.line)).toEqual([80]);
  });

  it("is unchanged for issues that declare no anchors", () => {
    const r = matchReviewComments([c(30, "unbounded retry risk")], KEY);
    expect(r.caught).toHaveLength(0);
    expect(r.unmatched).toHaveLength(1);
  });
});
