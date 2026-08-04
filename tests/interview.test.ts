/**
 * Interview mode's clock and cue schedule.
 *
 * Pure by design, because the failure modes are all about time passing in ways
 * a UI test can't reproduce: a tab asleep across two checkpoints, a refresh
 * mid-session, a timer that fires late. Everything derives from a deadline, so
 * those cases are just arithmetic — and this is where they're pinned.
 */
import { describe, expect, it } from "vitest";
import {
  CHECKPOINTS_MS,
  INTERVIEW_DURATION_MS,
  INTERVIEW_RUN_BUDGET,
  WRAP_UP_AT_REMAINING_MS,
  cueKeysUpTo,
  formatDuration,
  nextCue,
  readClock,
  runBudget,
  startedAtFor,
} from "../lib/interview";

const START = 1_800_000_000_000;
const DEADLINE = START + INTERVIEW_DURATION_MS;

/** The clock `minutes` into the session. */
const at = (minutes: number) => readClock(DEADLINE, START + minutes * 60_000);

describe("interview clock", () => {
  it("counts down from the deadline", () => {
    expect(at(0)).toMatchObject({ elapsedMs: 0, remainingMs: INTERVIEW_DURATION_MS, expired: false, wrappingUp: false });
    expect(at(20).remainingMs).toBe(25 * 60_000);
    expect(at(20).progress).toBeCloseTo(20 / 45, 5);
    expect(startedAtFor(DEADLINE)).toBe(START);
  });

  it("enters the wrap-up window in the last five minutes", () => {
    expect(at(39).wrappingUp).toBe(false);
    expect(at(40).wrappingUp).toBe(true);
    expect(readClock(DEADLINE, DEADLINE - WRAP_UP_AT_REMAINING_MS).wrappingUp).toBe(true);
  });

  it("expires exactly once and never reports negative time", () => {
    expect(at(45)).toMatchObject({ expired: true, remainingMs: 0, wrappingUp: false });
    // A tab asleep well past the deadline still reads as a finished session,
    // not a wildly negative one.
    const late = readClock(DEADLINE, DEADLINE + 6 * 60 * 60_000);
    expect(late).toMatchObject({ expired: true, remainingMs: 0, progress: 1 });
    expect(late.elapsedMs).toBe(INTERVIEW_DURATION_MS);
  });

  it("formats as a wall clock", () => {
    expect(formatDuration(INTERVIEW_DURATION_MS)).toBe("45:00");
    expect(formatDuration(61_000)).toBe("1:01");
    expect(formatDuration(9_000)).toBe("0:09");
    expect(formatDuration(-5_000)).toBe("0:00");
  });
});

describe("cue schedule", () => {
  it("stays quiet until the first checkpoint", () => {
    const delivered = new Set<string>();
    expect(nextCue(at(0), delivered)).toBeNull();
    expect(nextCue(at(14), delivered)).toBeNull();
    expect(nextCue(at(15), delivered)).toEqual({ cue: "checkpoint", key: "checkpoint-0" });
  });

  it("delivers each cue once", () => {
    const delivered = new Set<string>();
    const due = nextCue(at(15), delivered)!;
    delivered.add(due.key);

    expect(nextCue(at(16), delivered)).toBeNull();
    expect(nextCue(at(30), delivered)).toEqual({ cue: "checkpoint", key: "checkpoint-1" });
  });

  it("skips a checkpoint slept through rather than delivering it late", () => {
    // The tab was backgrounded from minute 10 to minute 32. Being told "you're
    // fifteen minutes in" at minute thirty-two is worse than silence, so the
    // caller retires the passed keys and only the current one fires.
    const delivered = new Set(cueKeysUpTo(at(32).elapsedMs));
    expect(delivered.has("checkpoint-0")).toBe(true);
    expect(nextCue(at(32), delivered)).toBeNull();
  });

  it("prefers the wrap-up over an undelivered checkpoint", () => {
    // Nothing has fired all session; at minute 41 the useful thing to say is
    // "land it", not "how's it going".
    expect(nextCue(at(41), new Set())).toEqual({ cue: "wrapUp", key: "wrapUp" });
  });

  it("ends with time-up, once", () => {
    const delivered = new Set<string>();
    expect(nextCue(at(45), delivered)).toEqual({ cue: "timeUp", key: "timeUp" });
    delivered.add("timeUp");
    expect(nextCue(at(45), delivered)).toBeNull();
    expect(nextCue(at(60), delivered)).toBeNull();
  });

  it("schedules every checkpoint inside the session", () => {
    for (const checkpoint of CHECKPOINTS_MS) {
      expect(checkpoint).toBeLessThan(INTERVIEW_DURATION_MS - WRAP_UP_AT_REMAINING_MS);
    }
  });
});

describe("run budget", () => {
  it("counts down and then blocks", () => {
    expect(runBudget(0)).toEqual({ used: 0, limit: INTERVIEW_RUN_BUDGET, remaining: 3, exhausted: false });
    expect(runBudget(2)).toMatchObject({ remaining: 1, exhausted: false });
    expect(runBudget(3)).toMatchObject({ remaining: 0, exhausted: true });
  });

  it("never reports negative remaining runs", () => {
    // A draft restored from a practice session can carry more runs than an
    // interview allows; that is exhausted, not minus four.
    expect(runBudget(7)).toMatchObject({ remaining: 0, exhausted: true });
  });
});
