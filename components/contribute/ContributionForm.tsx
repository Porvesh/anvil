"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { getSessionId } from "@/lib/session";
import { streamSSE } from "@/lib/sseClient";
import { IconArrowRight, IconLock, IconSparkle } from "@/lib/icons";
import type { Difficulty, ProblemType } from "@/lib/types";
import styles from "./ContributionForm.module.css";

type Outcome =
  | { kind: "accepted"; problemId: string; title: string }
  | { kind: "duplicate"; problemId: string; title: string }
  | { kind: "rejected"; message: string };

function stringField(payload: Record<string, unknown>, key: string): string | null {
  return typeof payload[key] === "string" ? payload[key] : null;
}

export function ContributionForm() {
  const [question, setQuestion] = useState("");
  const [roleContext, setRoleContext] = useState("");
  const [followUps, setFollowUps] = useState("");
  const [requestedType, setRequestedType] = useState<ProblemType | "auto">("auto");
  const [requestedDifficulty, setRequestedDifficulty] = useState<Difficulty | "auto">("auto");
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const canSubmit = question.trim().length >= 40 && attested && !busy;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setOutcome(null);
    setPhase("Starting privacy and quality review");
    const controller = new AbortController();
    abortRef.current = controller;
    let completed: Outcome | null = null;
    let streamError: string | null = null;

    try {
      await streamSSE(
        "/api/contributions",
        {
          sessionId: getSessionId(),
          question: question.trim(),
          roleContext: roleContext.trim() || undefined,
          followUps: followUps.trim() || undefined,
          requestedType: requestedType === "auto" ? undefined : requestedType,
          requestedDifficulty: requestedDifficulty === "auto" ? undefined : requestedDifficulty,
          attested: true,
        },
        {
          onDelta: () => {},
          onPhase: (_name, note) => setPhase(note ?? "Reviewing contribution"),
          onError: (message) => {
            streamError = message;
          },
          onDone: (payload) => {
            const kind = stringField(payload, "outcome");
            if (kind === "accepted" || kind === "duplicate") {
              const problemId = stringField(payload, "problemId");
              const title = stringField(payload, "title");
              if (problemId && title) completed = { kind, problemId, title };
            } else if (kind === "rejected") {
              completed = {
                kind: "rejected",
                message: stringField(payload, "message") ?? "This contribution was not added to the bank.",
              };
            }
          },
        },
        { signal: controller.signal },
      );

      if (streamError) throw new Error(streamError);
      const resolved = completed as Outcome | null;
      if (!resolved) throw new Error("Contribution review ended without a result.");
      setOutcome(resolved);
      if (resolved.kind !== "rejected") {
        setQuestion("");
        setRoleContext("");
        setFollowUps("");
      }
      setPhase(null);
    } catch (cause) {
      if (controller.signal.aborted) {
        setError("Contribution review cancelled. Nothing was saved from the source text.");
      } else {
        setError(cause instanceof Error ? cause.message : "Contribution review failed");
      }
      setPhase(null);
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  return (
    <main className={styles.wrap}>
      <header className={styles.head}>
        <span className="eyebrow">Community contribution</span>
        <h1>Contribute an interview question</h1>
        <p>Anvil extracts the reusable engineering signal, checks the bank, then authors and verifies an original exercise.</p>
      </header>

      <div className={styles.privacy}>
        <IconLock size={16} />
        <div>
          <strong>Your source text is not saved</strong>
          <span>It is processed in this live request by your connected provider. Anvil stores only derived scores, tags, status, and any verified exercise.</span>
        </div>
      </div>

      <form className={styles.form} onSubmit={submit}>
        <label className={styles.primaryField}>
          <span>What were you asked?</span>
          <small>Include the technical setup, constraints, and what the interviewer wanted you to reason through.</small>
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            minLength={40}
            maxLength={12_000}
            placeholder="Paste the question or describe it in your own words…"
            spellCheck
            disabled={busy}
            required
          />
          <span className={styles.characterCount}>{question.length.toLocaleString()} / 12,000</span>
        </label>

        <div className={styles.optionalGrid}>
          <label>
            <span>Role or JD context <em>Optional</em></span>
            <textarea
              value={roleContext}
              onChange={(event) => setRoleContext(event.target.value)}
              maxLength={12_000}
              placeholder="Relevant responsibilities, stack, or seniority"
              disabled={busy}
            />
          </label>
          <label>
            <span>Follow-up questions <em>Optional</em></span>
            <textarea
              value={followUps}
              onChange={(event) => setFollowUps(event.target.value)}
              maxLength={8_000}
              placeholder="What did they probe after your first answer?"
              disabled={busy}
            />
          </label>
        </div>

        <div className={styles.options}>
          <label>
            <span>Track</span>
            <select value={requestedType} onChange={(event) => setRequestedType(event.target.value as ProblemType | "auto")} disabled={busy}>
              <option value="auto">Let Anvil decide</option>
              <option value="debug">Debug</option>
              <option value="review">Code review</option>
              <option value="design">System design</option>
            </select>
          </label>
          <label>
            <span>Difficulty</span>
            <select value={requestedDifficulty} onChange={(event) => setRequestedDifficulty(event.target.value as Difficulty | "auto")} disabled={busy}>
              <option value="auto">Infer from the question</option>
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </select>
          </label>
        </div>

        <label className={styles.attestation}>
          <input type="checkbox" checked={attested} onChange={(event) => setAttested(event.target.checked)} disabled={busy} />
          <span>I removed confidential information, credentials, customer data, and details I am not allowed to share.</span>
        </label>

        {phase && (
          <div className={styles.progress} role="status">
            <IconSparkle />
            <span>{phase}</span>
          </div>
        )}
        {error && <p className={styles.error} role="alert">{error}</p>}

        {outcome && (
          <section className={`${styles.result} ${styles[outcome.kind]}`} aria-live="polite">
            <div>
              <strong>{outcome.kind === "accepted" ? "Added to the bank" : outcome.kind === "duplicate" ? "Already covered" : "Not added"}</strong>
              <span>{outcome.kind === "rejected" ? outcome.message : outcome.title}</span>
            </div>
            {outcome.kind !== "rejected" && (
              <Link href={`/solve/${outcome.problemId}`}>
                {outcome.kind === "accepted" ? "Start problem" : "Open existing problem"}
                <IconArrowRight />
              </Link>
            )}
          </section>
        )}

        <div className={styles.actions}>
          <Link href="/bank">Back to bank</Link>
          {busy && <button type="button" className="btn-ghost" onClick={() => abortRef.current?.abort()}>Cancel</button>}
          <button type="submit" className="btn-primary" disabled={!canSubmit}>
            {busy ? "Reviewing…" : "Review contribution"}
          </button>
        </div>
      </form>
    </main>
  );
}
