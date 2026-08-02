import { describe, expect, it } from "vitest";
import { selectTailoredType } from "../lib/generation/selectType";

describe("tailored generation track selection", () => {
  it("always honors an explicit track", () => {
    expect(selectTailoredType("debug", "Architect distributed streaming systems and review pull requests")).toBe("debug");
  });

  it("selects review for review-shaped roles", () => {
    expect(selectTailoredType(undefined, "Own pull request quality and perform code reviews across the platform")).toBe("review");
  });

  it("selects design for real-time and architecture roles", () => {
    expect(selectTailoredType(undefined, "Optimize real-time robot video latency and distributed system reliability")).toBe("design");
  });

  it("defaults implementation-heavy roles to a runnable debug exercise", () => {
    expect(selectTailoredType(undefined, "Build Python services and diagnose difficult production bugs")).toBe("debug");
  });
});
