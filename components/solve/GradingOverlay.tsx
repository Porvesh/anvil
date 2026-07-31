"use client";

import { useEffect, useState } from "react";
import { Logo } from "@/components/shell/Logo";
import styles from "./GradingOverlay.module.css";

/** What grading is actually doing, surfaced step by step — the transparency is
 *  the point: the grade is a match against seeded ground truth, not vibes. */
const STEPS = [
  "Matching your work against the seeded flaws…",
  "Checking line anchors: caught / missed / false positives…",
  "Judging precision and root-cause quality…",
  "Preparing your follow-up questions…",
];

export function GradingOverlay({ onCancel }: { onCancel: () => void }) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 1600);
    return () => clearInterval(id);
  }, []);

  return (
    <div className={styles.overlay} role="status" aria-live="polite">
      <div className={styles.card}>
        <div className={styles.mark}>
          <Logo size={44} />
        </div>
        <div className={styles.title}>Forging your grade</div>
        <div className={styles.step}>{STEPS[step]}</div>
        <div className={styles.dots}>
          <span />
          <span />
          <span />
        </div>
        <button className={styles.cancel} onClick={onCancel}>Cancel grading</button>
      </div>
    </div>
  );
}
