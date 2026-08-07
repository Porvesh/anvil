"use client";

import Link from "next/link";
import { useState } from "react";
import type { ChatMessage, Grade, PublicProblem, ReviewComment } from "@/lib/types";
import { ReviewPane } from "@/components/solve/ReviewPane";
import { Results } from "@/components/results/Results";
import { InterviewerPanel } from "@/components/ai/InterviewerPanel";
import styles from "./DemoWalkthrough.module.css";

type Step = "review" | "results" | "followup";

const STEPS: { id: Step; label: string; blurb: string }[] = [
  { id: "review", label: "The PR", blurb: "A plausible AI-written patch with flaws planted in it." },
  { id: "results", label: "The grade", blurb: "Which planted flaws the comments caught, and what that scores." },
  { id: "followup", label: "The follow-up", blurb: "The interviewer probing the one that got away." },
];

/**
 * A recorded attempt, walked through in the order it happened.
 *
 * Uses the same components as the live product — the diff viewer, the results
 * breakdown, the interviewer panel — because a demo built from lookalike
 * components is a demo of the lookalikes. The only differences are that the
 * comments are already placed, the transcript is already written, and rating is
 * switched off since the viewer solved nothing.
 */
export function DemoWalkthrough({
  problem,
  comments,
  grade,
  transcript,
  narrated,
}: {
  problem: PublicProblem;
  comments: ReviewComment[];
  grade: Grade;
  transcript: ChatMessage[];
  /** Whether the recorded commentary matches this specific problem. */
  narrated: boolean;
}) {
  const [step, setStep] = useState<Step>("review");
  const caught = grade.outcomes.filter((outcome) => outcome.status === "caught").length;

  return (
    <div className={styles.wrap}>
      <header className={styles.head}>
        <div>
          <span className="eyebrow">Recorded example</span>
          <h1>A code review, graded</h1>
          <p>
            Someone else&rsquo;s attempt at a problem from the bank — no API key needed to read it. The score below is
            computed live by the same matcher and scoring code the product uses; only the interviewer&rsquo;s wording is
            recorded.
          </p>
        </div>
        <Link className="btn-primary" href="/bank?type=review">
          Try one yourself →
        </Link>
      </header>

      <nav className={styles.steps} aria-label="Walkthrough steps">
        {STEPS.map((entry, index) => (
          <button
            key={entry.id}
            className={`${styles.step} ${step === entry.id ? styles.stepOn : ""}`}
            onClick={() => setStep(entry.id)}
            aria-current={step === entry.id ? "step" : undefined}
          >
            <span className={styles.stepNum}>{index + 1}</span>
            <span className={styles.stepText}>
              <strong>{entry.label}</strong>
              <span>{entry.blurb}</span>
            </span>
          </button>
        ))}
      </nav>

      {step === "review" && (
        <section className={styles.stage}>
          {narrated && (
            <p className={styles.note}>
              Three flaws were planted in this diff before it reached the bank, and the generator verified each one
              actually breaks something. The comments below are the recorded reviewer&rsquo;s — read the diff first and
              see which ones you&rsquo;d have left.
            </p>
          )}
          <ReviewPane
            title={problem.title}
            prompt={problem.prompt}
            prMeta={problem.prMeta}
            diff={problem.diff ?? []}
            comments={comments}
            // A recording: the comments are fixed, so both mutators are no-ops.
            onAddComment={() => {}}
            onRemoveComment={() => {}}
            readOnly
          />
          <div className={styles.advance}>
            <button className="btn-primary" onClick={() => setStep("results")}>
              See how it scored →
            </button>
          </div>
        </section>
      )}

      {step === "results" && (
        <section className={styles.stage}>
          <Results
            grade={grade}
            problemId={problem.id}
            problemType="review"
            onReview={() => setStep("review")}
            rateable={false}
            footer={
              <div className={styles.advance}>
                <button className="btn-ghost" onClick={() => setStep("review")}>
                  Back to the diff
                </button>
                <button className="btn-primary" onClick={() => setStep("followup")}>
                  {caught > 0 ? "Now the follow-up →" : "See the follow-up →"}
                </button>
              </div>
            }
          />
        </section>
      )}

      {step === "followup" && (
        <section className={styles.stage}>
          {narrated && (
            <p className={styles.note}>
              Grading is the setup, not the point. The interviewer knows exactly which planted flaw was missed, so the
              follow-up goes straight at it instead of asking how the review went.
            </p>
          )}
          <div className={styles.transcript}>
            <InterviewerPanel
              role="Probing the gaps you missed"
              messages={transcript}
              onSend={() => {}}
              busy={false}
              readOnly
              footer="Recorded transcript. With your own key connected, this is a live conversation."
            />
          </div>
          <div className={styles.advance}>
            <Link className="btn-ghost" href="/">
              Back to practice
            </Link>
            <Link className="btn-primary" href="/bank?type=review">
              Try a review yourself →
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
