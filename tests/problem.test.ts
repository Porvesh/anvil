/**
 * Invariant tests for the server→client chokepoint (lib/problem.ts).
 *
 * `toPublicProblem` is the only place a bank row becomes client-facing, which
 * makes it the only place ground truth can leak. These tests assert on the
 * *serialized* payload rather than the typed value, because the failure mode
 * that actually shipped was a field surviving an object spread while the type
 * still looked correct — a `PublicProblem` that structurally satisfies its type
 * can still carry a spoiler on the wire.
 */
import { describe, it, expect } from "vitest";
import type { Problem as PrismaProblem } from "@prisma/client";
import { toProblem, toPublicProblem } from "../lib/problem";
import type { AnswerKeyIssue } from "../lib/types";

const ANSWER_KEY: AnswerKeyIssue[] = [
  {
    id: "IDEM-1",
    lineStart: 42,
    lineEnd: 47,
    severity: "critical",
    failure: "duplicate charge on webhook retry",
    explanation: "…",
    keywords: ["idempotency", "duplicate"],
  },
  {
    id: "LOCK-1",
    lineStart: 61,
    lineEnd: 61,
    severity: "major",
    failure: "check-then-act race",
    explanation: "…",
    keywords: ["lock", "race"],
  },
];

/** A bank row with every ground-truth-bearing column populated. */
function row(overrides: Partial<PrismaProblem> = {}): PrismaProblem {
  return {
    id: "p1",
    type: "debug",
    language: "python",
    difficulty: "hard",
    title: "Duplicate charges under webhook retry",
    prompt: "Payments are occasionally double-charged.",
    jdContext: "CONFIDENTIAL — Acme Corp, Staff Engineer, Payments Platform.",
    starterCode: null,
    files: [{ path: "payments/charge.py", content: "..." }],
    diff: null,
    prMeta: null,
    testSuite: { cases: [] },
    rubric: null,
    answerKey: ANSWER_KEY,
    qualityScore: 0.9,
    source: "generated",
    upvotes: 3,
    downvotes: 0,
    timesAttempted: 7,
    retired: false,
    createdAt: new Date(0),
    ...overrides,
  } as unknown as PrismaProblem;
}

describe("toPublicProblem", () => {
  it("withholds the answer key, its length, and the pasted JD (INV-1, INV-9, INV-12)", () => {
    const wire = JSON.parse(JSON.stringify(toPublicProblem(row())));

    expect(wire).not.toHaveProperty("answerKey");
    expect(wire).not.toHaveProperty("answerKeyCount");
    expect(wire).not.toHaveProperty("jdContext");
  });

  it("leaks no ground-truth substring anywhere in the serialized payload", () => {
    // Belt-and-braces against a future field that nests the key or the JD:
    // property checks only catch leaks at the top level.
    const wire = JSON.stringify(toPublicProblem(row()));

    for (const issue of ANSWER_KEY) {
      expect(wire).not.toContain(issue.id);
      expect(wire).not.toContain(issue.failure);
      expect(wire).not.toContain(issue.explanation);
    }
    expect(wire).not.toContain("Acme Corp");
  });

  it("still carries everything the solve surface needs to render", () => {
    const pub = toPublicProblem(row());

    expect(pub.id).toBe("p1");
    expect(pub.type).toBe("debug");
    expect(pub.title).toBeTruthy();
    expect(pub.prompt).toBeTruthy();
    expect(pub.files).toHaveLength(1);
    expect(pub.testSuite).toBeTruthy();
    expect(pub.upvotes).toBe(3);
  });

  it("keeps the answer key on the internal view, which grading reads", () => {
    expect(toProblem(row()).answerKey).toHaveLength(2);
    expect(toProblem(row()).jdContext).toContain("Acme Corp");
  });
});
