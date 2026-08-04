"use client";

import { INTERVIEW_RUN_BUDGET, INTERVIEW_DURATION_MS } from "@/lib/interview";
import { IconClock } from "@/lib/icons";
import styles from "./InterviewGate.module.css";

/**
 * The consent step before the clock starts.
 *
 * Arriving on a page that has already begun timing you would be hostile, and it
 * would also be wrong: someone linked into interview mode may want to read the
 * brief first, or may have opened the tab to come back to. Nothing is timed
 * until this button is pressed.
 *
 * It also states the constraints up front. A run budget discovered by hitting it
 * reads as a bug; announced beforehand, it is the exercise.
 */
export function InterviewGate({
  type,
  onStart,
  onDecline,
}: {
  type: "debug" | "review" | "design";
  onStart: () => void;
  onDecline: () => void;
}) {
  const minutes = Math.round(INTERVIEW_DURATION_MS / 60_000);

  return (
    <div className={styles.gate}>
      <div className={styles.card}>
        <div className={styles.mark}>
          <IconClock size={20} />
        </div>
        <span className="eyebrow">Interview conditions</span>
        <h2>{minutes} minutes, one shot</h2>
        <p className={styles.lead}>
          The same problem, under the constraints of a real screen. Practice mode is always there if you would rather
          take your time.
        </p>

        <ul className={styles.rules}>
          <li>
            <strong>A clock.</strong> {minutes} minutes, running from when you press start. At zero, whatever you have is
            submitted.
          </li>
          {type === "debug" && (
            <li>
              <strong>{INTERVIEW_RUN_BUDGET} test runs.</strong> Enough to check a hypothesis, not enough to guess. Read
              the code before you spend one.
            </li>
          )}
          <li>
            <strong>An interviewer in the room.</strong> They will open, check in, and call time — the way someone
            actually watching would.
          </li>
        </ul>

        <div className={styles.actions}>
          <button className="btn-ghost" onClick={onDecline}>
            Practice instead
          </button>
          <button className="btn-primary" onClick={onStart}>
            Start the clock →
          </button>
        </div>
      </div>
    </div>
  );
}
