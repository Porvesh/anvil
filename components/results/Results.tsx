"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Grade, Severity } from "@/lib/types";
import styles from "./Results.module.css";

const RING_CIRCUMFERENCE = 2 * Math.PI * 44; // r=44

const SEV_CLASS: Record<Severity, string> = {
  critical: styles.sevCritical,
  major: styles.sevMajor,
  minor: styles.sevMinor,
};

function SeverityChip({ severity }: { severity?: Severity }) {
  if (!severity) return null;
  return <span className={`${styles.sev} ${SEV_CLASS[severity]}`}>{severity}</span>;
}

/**
 * Results breakdown (spec §6, §12): animated score ring, caught / missed /
 * false-positive issues with severities, and — because the grade should be
 * explainable, not a trust-me number — the exact formula it came from. The
 * Socratic follow-up runs in the interviewer panel beside this.
 */
export function Results({ grade, mode, onReview }: { grade: Grade; mode: "debug" | "review"; onReview: () => void }) {
  const caught = grade.outcomes.filter((o) => o.status === "caught");
  const missed = grade.outcomes.filter((o) => o.status === "missed");

  // Animate the ring from empty to the score on mount.
  const [offset, setOffset] = useState(RING_CIRCUMFERENCE);
  useEffect(() => {
    const id = requestAnimationFrame(() => setOffset(RING_CIRCUMFERENCE * (1 - grade.score / 100)));
    return () => cancelAnimationFrame(id);
  }, [grade.score]);

  return (
    <div className={styles.results}>
      <div className={styles.inner}>
        <div className={styles.rhead}>
          <div className={styles.ring}>
            <svg viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="44" stroke="var(--raise)" strokeWidth="7" fill="none" />
              <circle
                cx="50"
                cy="50"
                r="44"
                stroke="var(--spark)"
                strokeWidth="7"
                fill="none"
                strokeLinecap="round"
                strokeDasharray={RING_CIRCUMFERENCE}
                strokeDashoffset={offset}
              />
            </svg>
            <div className={styles.val}>
              {grade.score}
              <small>%</small>
            </div>
          </div>
          <div>
            <h1>{grade.headline}</h1>
            <p>{grade.summary}</p>
            {grade.testsPassed !== undefined && (
              <span className={`${styles.testsBadge} ${grade.testsPassed ? styles.testsPass : styles.testsFail}`}>
                {grade.testsPassed ? "✓ test suite green on final submission" : "✗ test suite still failing at submission"}
              </span>
            )}
          </div>
        </div>

        <div className={styles.rgrid}>
          <div className={styles.rcard}>
            <h3>What you caught</h3>
            {caught.length === 0 && grade.falsePositives.length === 0 && (
              <div className={styles.empty}>Nothing caught this time — the follow-up will walk you through the gaps.</div>
            )}
            {caught.map((o) => (
              <div key={o.issueId} className={`${styles.issue} ${styles.ok}`}>
                <span className={styles.m}>CAUGHT</span>
                <span className={styles.d}>
                  {o.failure}
                  <SeverityChip severity={o.severity} />
                  {o.matchedOn && <span>“{o.matchedOn}”</span>}
                </span>
              </div>
            ))}
            {grade.falsePositives.map((fp, i) => (
              <div key={`fp-${i}`} className={`${styles.issue} ${styles.fp}`}>
                <span className={styles.m}>FALSE +</span>
                <span className={styles.d}>
                  “{fp.body}”
                  {fp.note && <span>{fp.note}</span>}
                </span>
              </div>
            ))}
          </div>

          <div className={styles.rcard}>
            <h3>{missed.length === 1 ? "What you missed" : missed.length === 0 ? "Missed" : "What you missed"}</h3>
            {missed.length === 0 && <div className={styles.empty}>You caught everything that was seeded. 🔨</div>}
            {missed.map((o) => (
              <div key={o.issueId} className={`${styles.issue} ${styles.miss}`}>
                <span className={styles.m}>MISSED</span>
                <span className={styles.d}>
                  {o.failure}
                  <SeverityChip severity={o.severity} />
                  <span>{o.explanation}</span>
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.formula}>
          <span className={styles.formulaLabel}>How this was scored</span>
          <span className={styles.formulaText}>
            {mode === "review" ? (
              <>
                The flaws were seeded, so grading is a match against ground truth: <code>caught / {grade.outcomes.length} seeded</code> sets
                the base, and each confirmed false positive costs <code>−12</code> — precision matters as much as recall in a real review.
              </>
            ) : (
              <>
                <code>55%</code> objective — does the test suite go green — plus <code>45%</code> approach quality: root-cause fix vs.
                symptom-masking, judged against the seeded answer key, with your run history as the iteration signal.
              </>
            )}
          </span>
        </div>

        <div className={styles.actions}>
          <Link href="/" className="btn-ghost">
            Back to bank
          </Link>
          <button className="btn-ghost" onClick={onReview}>
            Review my answer
          </button>
          <Link href="/" className="btn-primary">
            Save &amp; next problem
          </Link>
        </div>
      </div>
    </div>
  );
}
