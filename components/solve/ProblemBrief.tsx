"use client";

import { useState } from "react";
import type { ProblemType, Difficulty } from "@/lib/types";
import styles from "./ProblemBrief.module.css";

/** What each track actually trains — surfacing the product thesis in-context. */
const SKILLS: Record<ProblemType, string[]> = {
  debug: ["reading unfamiliar code", "root-cause isolation", "fix ≠ symptom-masking"],
  review: ["catching AI-slop bugs", "risk-ranked review", "precision — no nit tax"],
  design: ["requirements probing", "capacity math", "failure-mode thinking"],
};

/**
 * The bug-report card above the debug editor: the symptom (as an incident
 * report, matching how the problem would surface at work), difficulty, and
 * what the exercise trains. Collapsible so the editor keeps its space.
 */
export function ProblemBrief({
  type,
  difficulty,
  prompt,
  issueCount,
}: {
  type: ProblemType;
  difficulty: Difficulty;
  prompt: string;
  issueCount: number;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className={styles.brief}>
      <button className={styles.header} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={styles.eyebrow}>{type === "debug" ? "Bug report" : type === "design" ? "Design brief" : "Review brief"}</span>
        <div className={styles.chips}>
          <span className={`${styles.chip} ${styles.chipDiff}`}>{difficulty}</span>
          {type !== "design" && <span className={styles.chip}>python</span>}
          <span className={styles.chip}>
            {issueCount} {type === "design" ? (issueCount === 1 ? "rubric dimension" : "rubric dimensions") : issueCount === 1 ? "seeded flaw" : "seeded flaws"}
          </span>
          <span className={`${styles.toggle} ${open ? styles.open : ""}`}>▼</span>
        </div>
      </button>
      {open && (
        <div className={styles.body}>
          <div className={styles.symptom}>{prompt}</div>
          <div className={styles.trains}>
            <span className={styles.trainsLabel}>trains</span>
            {SKILLS[type].map((s) => (
              <span key={s} className={styles.skill}>
                {s}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
