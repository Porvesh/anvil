/**
 * Timed interview mode.
 *
 * Practice mode is deliberately clock-free: a live countdown in the chrome is
 * pure pressure with no product signal, and Anvil grades judgment rather than
 * speed. But "no clock, unlimited runs, hints on tap" is not the event anyone is
 * preparing for. This is the opposite setting, entered on purpose — the clock
 * only exists because the user asked for it, and it never appears otherwise.
 *
 * Three things change under interview conditions, each mirroring a real
 * constraint rather than adding difficulty for its own sake:
 *
 * 1. **A deadline.** Forty-five minutes, the standard technical-screen slot.
 * 2. **A run budget.** You cannot brute-force a fix against the test suite while
 *    someone watches; you have to reason about the code and then run it. Three
 *    runs is enough to check a hypothesis, not enough to bisect.
 * 3. **An interviewer who speaks first.** They open, check in, and tell you to
 *    start wrapping up — the rhythm of the room.
 *
 * Everything here is pure, derived from a deadline timestamp rather than a
 * ticking counter, so a backgrounded tab, a refresh, or a restored draft all
 * produce the same answer.
 */

export const INTERVIEW_DURATION_MS = 45 * 60 * 1000;

/** Runs allowed against the test suite for the whole session (debug only). */
export const INTERVIEW_RUN_BUDGET = 3;

/**
 * Beats where the interviewer speaks, as elapsed-time fractions of the session.
 * Two check-ins and a wrap-up: enough presence to feel like a room, few enough
 * that they don't interrupt the work they're asking about.
 */
export const CHECKPOINTS_MS = [15 * 60 * 1000, 30 * 60 * 1000] as const;

/** How long before the deadline the interviewer calls time on new work. */
export const WRAP_UP_AT_REMAINING_MS = 5 * 60 * 1000;

export type InterviewCue = "opening" | "checkpoint" | "wrapUp" | "timeUp";

export interface InterviewClock {
  elapsedMs: number;
  remainingMs: number;
  /** Fraction of the session spent, clamped to 0–1. */
  progress: number;
  expired: boolean;
  /** True inside the final stretch, when the UI shifts to "land it". */
  wrappingUp: boolean;
}

export function startedAtFor(deadline: number): number {
  return deadline - INTERVIEW_DURATION_MS;
}

export function readClock(deadline: number, now = Date.now()): InterviewClock {
  const remainingMs = Math.max(0, deadline - now);
  const elapsedMs = Math.min(INTERVIEW_DURATION_MS, INTERVIEW_DURATION_MS - remainingMs);
  return {
    elapsedMs,
    remainingMs,
    progress: Math.min(1, Math.max(0, elapsedMs / INTERVIEW_DURATION_MS)),
    expired: remainingMs <= 0,
    wrappingUp: remainingMs > 0 && remainingMs <= WRAP_UP_AT_REMAINING_MS,
  };
}

/** `m:ss` under an hour — the format a wall clock in an interview room shows. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Which cue is due, given what has already been delivered.
 *
 * Returns at most one cue per call and never repeats one, so a tab that was
 * backgrounded across two checkpoints delivers the later one and silently drops
 * the stale one — being told "you're fifteen minutes in" at minute thirty-two is
 * worse than not being told at all.
 */
export function nextCue(clock: InterviewClock, delivered: ReadonlySet<string>): { cue: InterviewCue; key: string } | null {
  if (clock.expired) {
    return delivered.has("timeUp") ? null : { cue: "timeUp", key: "timeUp" };
  }
  if (clock.wrappingUp) {
    return delivered.has("wrapUp") ? null : { cue: "wrapUp", key: "wrapUp" };
  }
  // Latest passed checkpoint wins; earlier ones are marked delivered by the
  // caller so they never fire late.
  for (let i = CHECKPOINTS_MS.length - 1; i >= 0; i -= 1) {
    const key = `checkpoint-${i}`;
    if (clock.elapsedMs >= CHECKPOINTS_MS[i] && !delivered.has(key)) {
      return { cue: "checkpoint", key };
    }
  }
  return null;
}

/** Every cue key at or before `elapsedMs` — used to retire skipped checkpoints. */
export function cueKeysUpTo(elapsedMs: number): string[] {
  return CHECKPOINTS_MS.flatMap((at, index) => (elapsedMs >= at ? [`checkpoint-${index}`] : []));
}

/**
 * What the interviewer says when no model is available.
 *
 * Interview mode has to work without a connected provider key — the clock, the
 * run budget and the pressure are the point, and none of them need a model. With
 * a key these are replaced by a real turn that has read the candidate's work.
 */
export const SCRIPTED_CUES: Record<InterviewCue, string> = {
  opening:
    "We've got 45 minutes. Read it through before you change anything, and talk me through what you're seeing as you go — I'd rather hear your reasoning than watch you type.",
  checkpoint: "Where are you at? Tell me what you've ruled out so far.",
  wrapUp:
    "Five minutes left. Start landing what you have — I'd rather see a clear explanation of the fix than an edit you can't finish.",
  timeUp: "That's time. Let's look at what you've got.",
};

/** The instruction sent to the model when it should speak unprompted. */
export const CUE_INSTRUCTIONS: Record<Exclude<InterviewCue, "opening" | "timeUp">, string> = {
  checkpoint:
    "You are the interviewer and the room has gone quiet. Check in on the candidate in one or two sentences: ask what they have ruled out or where they are looking, based on the work in front of you. Do not give the answer, do not hint at the flaw, and do not summarise their code back to them.",
  wrapUp:
    "You are the interviewer and there are five minutes left. In one or two sentences, tell the candidate to start landing what they have and ask them to state their conclusion. Do not reveal anything about the flaw.",
};

export interface RunBudget {
  used: number;
  limit: number;
  remaining: number;
  exhausted: boolean;
}

export function runBudget(used: number, limit = INTERVIEW_RUN_BUDGET): RunBudget {
  const remaining = Math.max(0, limit - used);
  return { used, limit, remaining, exhausted: remaining === 0 };
}
