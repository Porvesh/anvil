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
