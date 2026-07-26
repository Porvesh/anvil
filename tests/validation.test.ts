import { describe, expect, it } from "vitest";
import { formatHintFiles } from "../lib/anthropic/hint";
import { hintBodySchema, submissionSchema } from "../lib/validation";

describe("API payload bounds", () => {
  it("accepts current multi-file debug context for hints", () => {
    const parsed = hintBodySchema.safeParse({
      problemId: "p1",
      files: [
        { path: "service.py", content: "def run():\n    return 1" },
        { path: "tests.py", content: "assert run() == 2", readOnly: true },
      ],
      output: "FAIL test_run: expected 2",
      history: [],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects inputs large enough to create unbounded model or database work", () => {
    expect(
      hintBodySchema.safeParse({ problemId: "p1", userMessage: "x".repeat(4_001) }).success,
    ).toBe(false);
    expect(
      submissionSchema.safeParse({
        mode: "review",
        comments: Array.from({ length: 101 }, () => ({ line: 1, body: "issue" })),
      }).success,
    ).toBe(false);
  });
});

describe("formatHintFiles", () => {
  it("keeps paths and read-only boundaries visible to the interviewer", () => {
    expect(
      formatHintFiles([
        { path: "pkg/service.py", content: "return total" },
        { path: "pkg/model.py", content: "class Model: pass", readOnly: true },
      ]),
    ).toContain("--- pkg/model.py (read-only) ---\nclass Model: pass");
  });
});
