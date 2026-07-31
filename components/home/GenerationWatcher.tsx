"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PENDING_EVENT, clearPending, readPending, type PendingGeneration } from "@/lib/pendingGeneration";
import styles from "./GenerationWatcher.module.css";

type Phase = "queued" | "building" | "ready" | "failed";

const PHASE_COPY: Record<Phase, string> = {
  queued: "Queued — your tailored problem is next up",
  building: "Building your tailored problem…",
  ready: "Your tailored problem is ready",
  failed: "Couldn't build that one",
};

/**
 * Watches an in-flight generation and surfaces it as a corner toast.
 *
 * Mounted in the root layout rather than on the home page on purpose: the user
 * is deliberately sent off to solve a bank problem the moment they paste a JD,
 * so by the time generation finishes they are somewhere else entirely. A toast
 * scoped to the page that started the job would unmount before it had anything
 * to say.
 *
 * A failure is quiet by design (the toast just goes away): the user is already
 * mid-problem, and interrupting them with an error about work they never waited
 * for would be worse than the miss itself.
 */
export function GenerationWatcher() {
  const [pending, setPending] = useState<PendingGeneration | null>(null);
  const [phase, setPhase] = useState<Phase>("queued");
  const [problemId, setProblemId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // Pick up a job started on any page, including after a reload.
  useEffect(() => {
    const sync = () => setPending(readPending());
    sync();
    window.addEventListener(PENDING_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(PENDING_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const jobId = pending?.jobId;

  useEffect(() => {
    if (!jobId) return;
    setPhase("queued");
    setProblemId(null);
    setDismissed(false);

    const source = new EventSource(`/api/generate/${jobId}/stream`);

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "phase") {
          setPhase(payload.phase === "pending" ? "queued" : "building");
        } else if (payload.type === "done") {
          setPhase("ready");
          setProblemId(payload.problemId);
          clearPending();
          source.close();
        } else if (payload.type === "error") {
          setPhase("failed");
          clearPending();
          source.close();
        }
      } catch {
        // A malformed frame isn't worth surfacing; the next one will do.
      }
    };

    // A dropped connection is not a failed job — the worker keeps going and the
    // problem still lands in the bank. Close quietly rather than crying wolf.
    source.onerror = () => source.close();

    return () => source.close();
  }, [jobId]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    clearPending();
  }, []);

  if (dismissed) return null;
  if (!pending && phase !== "ready") return null;
  if (phase === "failed") return null;

  return (
    <div className={styles.toast} role="status" aria-live="polite">
      <div className={styles.body}>
        <span className={`${styles.dot} ${phase === "ready" ? styles.dotReady : ""}`} aria-hidden />
        <div>
          <div className={styles.title}>{PHASE_COPY[phase]}</div>
          {pending?.label && phase !== "ready" ? <div className={styles.label}>{pending.label}</div> : null}
        </div>
      </div>
      {phase === "ready" && problemId ? (
        <Link className={styles.action} href={`/solve/${problemId}`} onClick={dismiss}>
          Open it
        </Link>
      ) : (
        <button className={styles.close} onClick={dismiss} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}
