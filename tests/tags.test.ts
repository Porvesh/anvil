import { describe, it, expect } from "vitest";
import { asTag, parseTags, tagOverlap, isRelevantTagMatch, FIXED_VOCAB } from "../lib/tags";

describe("tag vocabulary", () => {
  it("normalizes case and whitespace when narrowing to the vocabulary", () => {
    expect(asTag("  Idempotency ")).toBe("idempotency");
    expect(asTag("kubernetes")).toBeNull();
  });

  it("drops out-of-vocabulary and duplicate tags rather than throwing", () => {
    // A stray tag from an older vocabulary should degrade matching, not break it.
    expect(parseTags(["caching", "caching", "blockchain", 7, null])).toEqual(["caching"]);
    expect(parseTags("not-an-array")).toEqual([]);
    expect(parseTags(undefined)).toEqual([]);
  });

  it("scores overlap against what the JD asked for, not the union", () => {
    // A problem covering everything asked plus extra is a full match: breadth
    // shouldn't be penalized the way Jaccard would.
    expect(tagOverlap(["caching", "retry"], ["caching", "retry", "distributed", "python"])).toBe(1);
    expect(tagOverlap(["caching", "retry"], ["caching"])).toBe(0.5);
    expect(tagOverlap(["caching"], ["auth"])).toBe(0);
  });

  it("treats an unlabelled JD as matching nothing", () => {
    expect(tagOverlap([], ["caching"])).toBe(0);
  });

  it("requires a shared domain instead of matching on generic systems tags", () => {
    const teleop = ["robotics", "distributed", "performance", "backend"] as const;
    const rateLimiter = ["rate-limiting", "distributed", "performance", "backend"] as const;
    const robotStreaming = ["robotics", "streaming", "performance", "distributed"] as const;

    expect(tagOverlap([...teleop], [...rateLimiter])).toBe(0.75);
    expect(isRelevantTagMatch([...teleop], [...rateLimiter])).toBe(false);
    expect(isRelevantTagMatch([...teleop], [...robotStreaming])).toBe(true);
  });

  it("keeps the vocabulary unique, which set-overlap depends on", () => {
    expect(new Set(FIXED_VOCAB).size).toBe(FIXED_VOCAB.length);
  });
});
