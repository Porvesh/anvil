/**
 * The review score itself.
 *
 * `lib/grading/matcher.ts` decides *what* was caught and is covered by
 * matcher.test.ts; this covers what the caught/missed/unmatched split is then
 * worth. The arithmetic is the product's central claim — "grading is a line
 * match, and here is the formula" — and until `assembleReviewGrade` was split
 * out of the model call it could only be exercised by paying a provider.
 */
import { describe, expect, it } from "vitest";
import { assembleReviewGrade } from "../lib/grading";
import { matchReviewComments } from "../lib/grading/matcher";
import type { AnswerKeyIssue, Problem, ReviewComment } from "../lib/types";
import type { ReviewJudgment } from "../lib/anthropic/grade";

const ISSUES: AnswerKeyIssue[] = [
  {
    id: "injection",
    file: "api/orders.py",
    lineStart: 18,
    lineEnd: 19,
    severity: "critical",
    failure: "user_id is interpolated into the SQL",
    explanation: "Use bind parameters.",
    keywords: ["injection", "parameterized", "f-string"],
  },
  {
    id: "off-by-one",
    file: "api/orders.py",
    lineStart: 16,
    lineEnd: 16,
    // The conceptual site: a reviewer may raise this at the signature instead.
    anchors: [14],
    severity: "major",
    failure: "page 1 skips the first page",
    explanation: "Offset should be (page - 1) * per_page.",
    keywords: ["off by one", "offset", "first page"],
  },
  {
    id: "count-scan",
    file: "api/orders.py",
    lineStart: 21,
    lineEnd: 21,
    severity: "major",
    failure: "the total loads every row",
    explanation: "Use SELECT COUNT(*).",
    keywords: ["count(*)", "full table", "loads every"],
  },
];

const problem = { answerKey: ISSUES } as Problem;

/** Score a set of comments with a scripted judgment, as the demo path does. */
function score(comments: ReviewComment[], judgment: Partial<ReviewJudgment> = {}) {
  const full: ReviewJudgment = {
    headline: "headline",
    summary: "summary",
    assessments: [],
    ...judgment,
  };
  return assembleReviewGrade(problem, matchReviewComments(comments, ISSUES), full, "test-model");
}

const on = (line: number, body: string): ReviewComment => ({ file: "api/orders.py", line, body });

describe("review scoring", () => {
  it("scores recall out of the seeded issues", () => {
    const grade = score([
      on(18, "SQL injection — user_id is interpolated, use parameterized queries"),
      on(16, "off by one: page 1 skips the first page"),
      on(21, "count(*) instead — this loads every row"),
    ]);

    expect(grade.score).toBe(100);
    expect(grade.outcomes.filter((o) => o.status === "caught")).toHaveLength(3);
    expect(grade.breakdown).toEqual([
      { label: "Issues caught", earned: 100, max: 100, detail: "3/3 seeded" },
    ]);
    expect(grade.graderModel).toBe("test-model");
  });

  it("charges 12 points for each comment the judge rejects", () => {
    const grade = score(
      [
        on(18, "SQL injection — user_id is interpolated, use parameterized queries"),
        on(21, "count(*) instead — this loads every row"),
        on(22, "I'd version this endpoint rather than adding fields"),
      ],
      { assessments: [{ index: 0, isRealIssue: false, matchedIssueId: null, note: "preference" }] },
    );

    // 2 of 3 caught (67) minus one false positive (12).
    expect(grade.score).toBe(55);
    expect(grade.falsePositives).toEqual([
      { line: 22, body: "I'd version this endpoint rather than adding fields", note: "preference" },
    ]);
    expect(grade.breakdown[1]).toEqual({ label: "False positives", earned: -12, max: 0, detail: "1 × −12" });
    expect(grade.outcomes.find((o) => o.issueId === "off-by-one")?.status).toBe("missed");
  });

  it("does not charge for a comment the judge accepts as a real extra finding", () => {
    const grade = score(
      [
        on(18, "SQL injection — parameterized queries please"),
        on(16, "off by one on the offset, first page unreachable"),
        on(21, "count(*) — loads every row"),
        on(30, "this logs the raw request body, which will capture card numbers"),
      ],
      { assessments: [{ index: 0, isRealIssue: true, matchedIssueId: null, note: "genuine, not seeded" }] },
    );

    expect(grade.falsePositives).toEqual([]);
    expect(grade.score).toBe(100);
  });

  it("credits a correct comment left away from the flaw's line", () => {
    // Nothing keyword-matches at line 40, so the matcher misses it; the judge
    // recognises it as the off-by-one and it is credited.
    const grade = score([on(40, "the pagination arithmetic here is wrong for the first page")], {
      assessments: [{ index: 0, isRealIssue: true, matchedIssueId: "off-by-one", note: "same defect" }],
    });

    expect(grade.outcomes.find((o) => o.issueId === "off-by-one")).toMatchObject({
      status: "caught",
      matchedOn: "the pagination arithmetic here is wrong for the first page",
    });
    // 1 of 3, and the rescuing comment is not also billed as a false positive.
    expect(grade.score).toBe(33);
    expect(grade.falsePositives).toEqual([]);
    expect(grade.breakdown[0].detail).toBe("1/3 seeded (1 credited off-line)");
  });

  it("credits a rescued issue only once, however many comments cite it", () => {
    const grade = score([on(40, "pagination arithmetic is off"), on(41, "and the offset is wrong too")], {
      assessments: [
        { index: 0, isRealIssue: true, matchedIssueId: "off-by-one", note: "" },
        { index: 1, isRealIssue: true, matchedIssueId: "off-by-one", note: "" },
      ],
    });

    expect(grade.outcomes.filter((o) => o.status === "caught")).toHaveLength(1);
    expect(grade.score).toBe(33);
  });

  it("ignores a judge that cites an issue the matcher already caught", () => {
    // Rescue exists to recover *missed* issues. Letting it re-credit a caught
    // one would push recall above what the matcher actually found.
    const grade = score(
      [on(18, "SQL injection — use parameterized queries"), on(40, "and the same injection concern applies here")],
      { assessments: [{ index: 0, isRealIssue: true, matchedIssueId: "injection", note: "" }] },
    );

    expect(grade.outcomes.filter((o) => o.status === "caught")).toHaveLength(1);
    expect(grade.score).toBe(33);
  });

  it("floors the score at zero rather than going negative", () => {
    const noise = Array.from({ length: 10 }, (_, i) => on(30 + i, `speculative remark ${i}`));
    const grade = score(noise, {
      assessments: noise.map((_, index) => ({ index, isRealIssue: false, matchedIssueId: null, note: "nit" })),
    });

    // 0 caught, 10 × −12 = −120 before clamping.
    expect(grade.score).toBe(0);
    expect(grade.falsePositives).toHaveLength(10);
  });

  it("reports every seeded issue exactly once, caught or missed", () => {
    const grade = score([on(18, "injection via f-string")]);

    expect(grade.outcomes.map((o) => o.issueId).sort()).toEqual(["count-scan", "injection", "off-by-one"]);
    expect(grade.outcomes.every((o) => o.failure && o.explanation)).toBe(true);
  });
});
