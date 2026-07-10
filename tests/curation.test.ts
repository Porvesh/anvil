/**
 * Unit tests for the community-curation policy (lib/curation.ts). This decides
 * which problems survive in the shared bank, so the vote-delta math and the
 * retirement threshold are tested directly.
 */
import { describe, it, expect } from "vitest";
import { shouldRetire, voteDeltas, wilsonScore, qualityLabel, RETIRE_MIN_VOTES } from "../lib/curation";

describe("voteDeltas", () => {
  it("first upvote: +1 up", () => {
    expect(voteDeltas(0, 1)).toEqual({ up: 1, down: 0, resulting: 1 });
  });
  it("first downvote: +1 down", () => {
    expect(voteDeltas(0, -1)).toEqual({ up: 0, down: 1, resulting: -1 });
  });
  it("re-clicking the same upvote toggles it off", () => {
    expect(voteDeltas(1, 1)).toEqual({ up: -1, down: 0, resulting: 0 });
  });
  it("re-clicking the same downvote toggles it off", () => {
    expect(voteDeltas(-1, -1)).toEqual({ up: 0, down: -1, resulting: 0 });
  });
  it("switching up→down moves one from up to down", () => {
    expect(voteDeltas(1, -1)).toEqual({ up: -1, down: 1, resulting: -1 });
  });
  it("switching down→up moves one from down to up", () => {
    expect(voteDeltas(-1, 1)).toEqual({ up: 1, down: -1, resulting: 1 });
  });
});

describe("shouldRetire", () => {
  it("does not retire below the minimum vote count, even if all negative", () => {
    expect(shouldRetire(0, RETIRE_MIN_VOTES - 1)).toBe(false);
  });
  it("retires a clearly net-negative problem with enough signal", () => {
    expect(shouldRetire(1, 6)).toBe(true); // 6 >= 2*1 and 6 > 1, total 7 >= 5
  });
  it("does not retire a well-liked problem", () => {
    expect(shouldRetire(20, 3)).toBe(false);
  });
  it("does not retire a merely-mixed problem (needs a losing ratio)", () => {
    expect(shouldRetire(5, 6)).toBe(false); // 6 < 2*5
  });
  it("borderline: equal votes never retire", () => {
    expect(shouldRetire(4, 4)).toBe(false);
  });
});

describe("wilsonScore", () => {
  it("is 0 with no votes", () => {
    expect(wilsonScore(0, 0)).toBe(0);
  });
  it("ranks many-positive above a single positive (confidence)", () => {
    expect(wilsonScore(50, 0)).toBeGreaterThan(wilsonScore(1, 0));
  });
  it("ranks a strong ratio above a weak one at similar volume", () => {
    expect(wilsonScore(18, 2)).toBeGreaterThan(wilsonScore(11, 9));
  });
  it("stays within [0,1]", () => {
    const s = wilsonScore(7, 3);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });
});

describe("qualityLabel", () => {
  it("labels low-vote problems 'new'", () => {
    expect(qualityLabel(1, 1).tone).toBe("new");
  });
  it("labels a strongly-liked problem 'good'", () => {
    expect(qualityLabel(30, 2).tone).toBe("good");
  });
  it("labels a contested problem 'mixed'", () => {
    expect(qualityLabel(5, 6).tone).toBe("mixed");
  });
});
