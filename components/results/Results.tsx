"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Grade, ProblemType, Severity } from "@/lib/types";
import { ProblemRating } from "./ProblemRating";
import styles from "./Results.module.css";

const RING_CIRCUMFERENCE = 2 * Math.PI * 44; // r=44

/** Ring color follows the same three bands as History, so a 72 always reads the
 *  same shade everywhere a score appears. */
function ringColor(score: number): string {
  if (score >= 75) return "var(--green)";
  if (score >= 50) return "var(--amber)";
  return "var(--red)";
}

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
export function Results({
  grade,
  problemId,
  problemType,
  onReview,
  rateable = true,
  footer,
}: {
  grade: Grade;
  problemId: string;
  problemType: ProblemType;
  onReview: () => void;
  /**
   * Whether to offer the curation vote. False for the recorded demo, where the
   * viewer solved nothing and so has no basis to rate the problem.
   */
  rateable?: boolean;
  /** Replaces the default action row (demo walkthrough supplies its own). */
  footer?: ReactNode;
}) {
  const router = useRouter();
  const [loadingNext, setLoadingNext] = useState(false);
  const caught = grade.outcomes.filter((o) => o.status === "caught");
  const missed = grade.outcomes.filter((o) => o.status === "missed");

  async function nextProblem() {
    setLoadingNext(true);
    try {
      const res = await fetch(`/api/problems/random?type=${problemType}&exclude=${problemId}`);
      const { id } = await res.json();
      router.push(id ? `/solve/${id}` : "/");
    } catch {
      router.push("/");
    }
  }

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
                stroke={ringColor(grade.score)}
                strokeWidth="7"
                fill="none"
                strokeLinecap="round"
                strokeDasharray={RING_CIRCUMFERENCE}
                strokeDashoffset={offset}
              />
            </svg>
            <div className={styles.val} style={{ color: ringColor(grade.score) }}>
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
            {missed.length === 0 && <div className={styles.empty}>You caught everything that was seeded — clean sweep.</div>}
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
          <div className={styles.formulaLabel}>How this was scored</div>
          <div className={styles.breakdown}>
            {grade.breakdown.map((line) => {
              const negative = line.earned < 0;
              return (
                <div key={line.label} className={`${styles.brline} ${negative ? styles.brNeg : ""}`}>
                  <span className={styles.brLabel}>
                    {line.label}
                    {line.detail && <span className={styles.brDetail}>{line.detail}</span>}
                  </span>
                  <span className={styles.brBar}>
                    <span
                      className={`${styles.brBarFill} ${negative ? styles.brBarFillNeg : ""}`}
                      style={{ width: `${line.max > 0 ? Math.min(100, (Math.abs(line.earned) / line.max) * 100) : 0}%` }}
                    />
                  </span>
                  <span className={styles.brScore}>
                    {line.earned >= 0 ? line.earned : `−${Math.abs(line.earned)}`}
                    {line.max > 0 && <small>/{line.max}</small>}
                  </span>
                </div>
              );
            })}
            <div className={`${styles.brline} ${styles.brTotal}`}>
              <span className={styles.brLabel}>Total</span>
              <span className={styles.brBar} aria-hidden />
              <span className={styles.brScore}>
                {grade.score}
                <small>/100</small>
              </span>
            </div>
          </div>
        </div>

        {rateable && <ProblemRating problemId={problemId} />}

        {footer ?? (
          <div className={styles.actions}>
            <Link href="/" className="btn-ghost">
              Back to bank
            </Link>
            <button className="btn-ghost" onClick={onReview}>
              Review my answer
            </button>
            <button className="btn-primary" onClick={nextProblem} disabled={loadingNext}>
              {loadingNext ? "Finding one…" : `Next ${problemType} problem →`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
