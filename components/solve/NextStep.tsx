"use client";

import type { ProblemType, RunResult } from "@/lib/types";
import styles from "./NextStep.module.css";

/**
 * The "you are here → do this next" strip (addresses: the flow wasn't intuitive
 * about what to do or how much was left). Always tells the user their current
 * state, the next concrete action, and a progress bar toward being ready to
 * submit. Reacts to live solve state per mode.
 */
export function NextStep({
  mode,
  issueCount,
  // debug
  runResult,
  running,
  // review
  commentCount,
  // design
  docWords,
}: {
  mode: ProblemType;
  issueCount: number;
  runResult?: RunResult | null;
  running?: boolean;
  commentCount?: number;
  docWords?: number;
}) {
  let message: React.ReactNode;
  let ready = false;
  let fraction = 0;
  let count = "";

  if (mode === "debug") {
    const passed = runResult?.tests.filter((t) => t.passed).length ?? 0;
    const total = runResult?.tests.length ?? 0;
    if (running) {
      message = <>Running the suite in your browser…</>;
    } else if (!runResult) {
      message = (
        <>
          <b>Step 1:</b> read the failing tests — press <b>Run tests</b> (⌘↵) to see what breaks.
        </>
      );
    } else if (runResult.error || runResult.timedOut) {
      message = <>The code errored before tests ran — check the Tests panel, then fix and re-run.</>;
    } else if (total > 0 && passed === total) {
      ready = true;
      fraction = 1;
      count = `${passed}/${total} green`;
      message = (
        <>
          <b>All tests green.</b> Confident it's the root cause, not a mask? <b>Submit for review</b>.
        </>
      );
    } else {
      fraction = total ? passed / total : 0;
      count = `${passed}/${total} passing`;
      message = (
        <>
          <b>{total - passed} still failing</b> — trace the root cause, edit, and re-run. Keep going until all green.
        </>
      );
    }
  } else if (mode === "review") {
    const n = commentCount ?? 0;
    ready = n > 0;
    fraction = issueCount ? Math.min(1, n / issueCount) : n > 0 ? 1 : 0;
    count = `${n} comment${n === 1 ? "" : "s"}`;
    message =
      n === 0 ? (
        <>
          <b>{issueCount} flaws are hidden</b> in this PR. Click any line to leave your first comment.
        </>
      ) : (
        <>
          You've flagged <b>{n}</b> — precision counts, so only what you'd block a PR over. <b>Submit review</b> when done.
        </>
      );
  } else {
    const w = docWords ?? 0;
    ready = w >= 120;
    fraction = Math.min(1, w / 200);
    count = `${w} words`;
    message =
      w < 40 ? (
        <>
          <b>Start with assumptions + scale.</b> Fill the sections in the doc, thinking out loud. Ask the interviewer to pressure-test you.
        </>
      ) : (
        <>
          Cover requirements, data model, scale, failure modes, trade-offs. <b>Submit</b> when the doc makes the argument.
        </>
      );
  }

  return (
    <div className={styles.bar}>
      <span className={styles.step}>
        <span className={`${styles.dot} ${ready ? styles.dotReady : styles.dotDo}`} />
        {message}
      </span>
      {count && (
        <span className={styles.track}>
          <span className={styles.count}>{count}</span>
          <span className={styles.bar2}>
            <span className={`${styles.fill} ${ready ? styles.fillReady : styles.fillDo}`} style={{ width: `${fraction * 100}%` }} />
          </span>
        </span>
      )}
    </div>
  );
}
