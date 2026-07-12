"use client";

import Link from "next/link";
import type { Grade } from "@/lib/types";
import styles from "./Results.module.css";

const RING_CIRCUMFERENCE = 2 * Math.PI * 44; // r=44

/**
 * Results breakdown (spec §6, §12). Shows the score ring plus caught / missed /
 * false-positive issues. The Socratic follow-up runs in the interviewer panel
 * beside this, so grading and teaching share the same shell.
 */
export function Results({ grade, onReview }: { grade: Grade; onReview: () => void }) {
  const caught = grade.outcomes.filter((o) => o.status === "caught");
  const missed = grade.outcomes.filter((o) => o.status === "missed");
  const offset = RING_CIRCUMFERENCE * (1 - grade.score / 100);

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
          </div>
        </div>

        <div className={styles.rgrid}>
          <div className={styles.rcard}>
            <h3>Issues you caught</h3>
            {caught.length === 0 && <div className={styles.empty}>Nothing caught this time.</div>}
            {caught.map((o) => (
              <div key={o.issueId} className={`${styles.issue} ${styles.ok}`}>
                <span className={styles.m}>CAUGHT</span>
                <span className={styles.d}>
                  {o.failure}
                  {o.matchedOn && <span>{o.matchedOn}</span>}
                </span>
              </div>
            ))}
            {grade.falsePositives.map((fp, i) => (
              <div key={`fp-${i}`} className={`${styles.issue} ${styles.fp}`}>
                <span className={styles.m}>FALSE +</span>
                <span className={styles.d}>
                  {fp.body}
                  {fp.note && <span>{fp.note}</span>}
                </span>
              </div>
            ))}
          </div>

          <div className={styles.rcard}>
            <h3>{missed.length === 1 ? "Issue you missed" : "Issues you missed"}</h3>
            {missed.length === 0 && <div className={styles.empty}>You caught everything. 🔨</div>}
            {missed.map((o) => (
              <div key={o.issueId} className={`${styles.issue} ${styles.miss}`}>
                <span className={styles.m}>MISSED</span>
                <span className={styles.d}>
                  {o.failure}
                  <span>{o.explanation}</span>
                </span>
              </div>
            ))}
          </div>
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
