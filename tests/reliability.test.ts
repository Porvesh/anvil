import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { classifyModelError, isAbortError, modelRequestOptions } from "../lib/anthropic/reliability";

describe("model request policy", () => {
  it("uses short interactive deadlines and longer generation deadlines", () => {
    expect(modelRequestOptions("hint").timeout).toBe(45_000);
    expect(modelRequestOptions("socratic").maxRetries).toBe(1);
    expect(modelRequestOptions("judgeDesign").timeout).toBe(120_000);
    expect(modelRequestOptions("generation").timeout).toBe(8 * 60_000);
  });

  it("passes cancellation through to the SDK", () => {
    const controller = new AbortController();
    expect(modelRequestOptions("judgeReview", controller.signal).signal).toBe(controller.signal);
  });
});

describe("model error classification", () => {
  it("turns timeouts and connection failures into retryable public errors", () => {
    const timeout = classifyModelError(new Anthropic.APIConnectionTimeoutError({}), "grading");
    expect(timeout).toMatchObject({ code: "timeout", status: 504, retryable: true });
    expect(timeout.message).toContain("work is safe");

    const connection = classifyModelError(new Anthropic.APIConnectionError({ message: "socket reset" }));
    expect(connection).toMatchObject({ code: "unavailable", status: 503, retryable: true });
    expect(connection.message).not.toContain("socket reset");
  });

  it("does not suggest retrying credentials or cancellation", () => {
    const auth = Anthropic.APIError.generate(
      401,
      { error: { type: "authentication_error", message: "bad key" } },
      "bad key",
      new Headers(),
    );
    expect(classifyModelError(auth)).toMatchObject({ code: "configuration", retryable: false });

    const aborted = new DOMException("aborted", "AbortError");
    expect(isAbortError(aborted)).toBe(true);
    expect(classifyModelError(aborted)).toMatchObject({ code: "cancelled", status: 499, retryable: false });
  });
});
