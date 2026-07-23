"use client";

import { useState } from "react";
import type { ProblemType, Difficulty } from "@/lib/types";
import { RichText } from "@/lib/richText";
import styles from "./ProblemBrief.module.css";

/**
 * The bug-report card above the debug editor: the symptom (as an incident
 * report, matching how the problem would surface at work) + difficulty.
 * Collapsible so the editor keeps its space.
 *
 * Design note: we deliberately do NOT show the seeded-flaw count here — real
 * bug reports and real design briefs don't come with a bug-count. Knowing
 * "there are exactly N issues" destroys the decision of when to stop looking,
 * which is half the skill. The count is revealed only on the results screen.
 */
export function ProblemBrief({
  type,
  difficulty,
  prompt,
}: {
  type: ProblemType;
  difficulty: Difficulty;
  prompt: string;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className={styles.brief}>
      <button className={styles.header} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={styles.eyebrow}>{type === "debug" ? "Bug report" : type === "design" ? "Design brief" : "Review brief"}</span>
        <div className={styles.chips}>
          <span className={`${styles.chip} ${styles.chipDiff}`}>{difficulty}</span>
          <span className={`${styles.toggle} ${open ? styles.open : ""}`}>▼</span>
        </div>
      </button>
      {open && (
        <div className={styles.body}>
          <RichText className={styles.symptom} text={prompt} />
        </div>
      )}
    </div>
  );
}
