"use client";

import { useEffect, useState } from "react";
import { IconClock } from "@/lib/icons";
import { formatDuration, readClock } from "@/lib/interview";
import styles from "./InterviewBar.module.css";

/**
 * The interview clock.
 *
 * Ticks off a deadline rather than decrementing a counter, so a backgrounded
 * tab, a throttled timer, or a page refresh all read the same time. It goes
 * amber inside the final five minutes and red in the last sixty seconds — the
 * only escalation, because a clock that shouts for forty-five minutes is just
 * noise.
 *
 * The run budget deliberately lives on the Run button rather than here: it is
 * spent by a specific action, and stating it in two places at once is one place
 * too many to keep truthful.
 */
export function InterviewBar({ deadline, onEnd }: { deadline: number; onEnd: () => void }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const clock = readClock(deadline, now);
  const urgent = clock.remainingMs <= 60_000;
  const tone = urgent ? styles.urgent : clock.wrappingUp ? styles.wrapping : "";

  return (
    <div className={`${styles.bar} ${tone}`}>
      <span className={styles.badge}>Interview</span>

      <span
        className={styles.time}
        // Announced only at the beats that matter; a per-second live region
        // would read the clock aloud sixty times a minute to a screen reader.
        role="timer"
        aria-live={urgent || clock.wrappingUp ? "polite" : "off"}
      >
        <IconClock />
        <b>{formatDuration(clock.remainingMs)}</b>
        <span className={styles.unit}>left</span>
      </span>

      <span className={styles.track} aria-hidden>
        <span className={styles.fill} style={{ width: `${clock.progress * 100}%` }} />
      </span>

      <button className={styles.end} onClick={onEnd}>
        End early
      </button>
    </div>
  );
}
