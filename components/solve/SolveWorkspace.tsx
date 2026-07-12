"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, PublicProblem, ReviewComment, RunRecord, RunResult } from "@/lib/types";
import { getRunner } from "@/lib/pyodide/runner";
import { getSessionId } from "@/lib/session";
import { streamSSE } from "@/lib/sseClient";
import { DebugPane } from "./DebugPane";
import { ReviewPane } from "./ReviewPane";
import { InterviewerPanel } from "@/components/ai/InterviewerPanel";
import { Results } from "@/components/results/Results";
import shell from "./Solve.module.css";
import type { Grade } from "@/lib/types";

type Phase = "solve" | "results";

function mmss(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Flatten the review diff to text for the hint model's context. */
function diffToText(problem: PublicProblem): string {
  return (problem.diff ?? [])
    .flatMap((h) => h.lines.map((l) => `${l.lineNo ?? ""}\t${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.content}`))
    .join("\n");
}

/**
 * The solve workspace (spec §6): the shared shell whose center pane morphs by
 * mode, plus the persistent interviewer panel. Owns the whole loop —
 * edit/run/comment → submit → grade → Socratic follow-up — as a small phase
 * machine, mirroring the single-surface flow of the v1.html prototype.
 */
export function SolveWorkspace({ problem }: { problem: PublicProblem }) {
  const isDebug = problem.type === "debug";
  const isReview = problem.type === "review";

  // --- solve state ---
  const [code, setCode] = useState(problem.starterCode ?? "");
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const runHistory = useRef<RunRecord[]>([]);

  // --- flow state ---
  const [phase, setPhase] = useState<Phase>("solve");
  const [submitting, setSubmitting] = useState(false);
  const [grade, setGrade] = useState<Grade | null>(null);
  const attemptId = useRef<string | null>(null);

  // --- interviewer chat ---
  const [chat, setChat] = useState<ChatMessage[]>([
    {
      role: "interviewer",
      content: isReview
        ? "Read the PR carefully — the description sounds reasonable, which is the point. Leave line comments where something's off, then submit. Ping me for a nudge."
        : `${problem.prompt} Read before you change anything — I'll stay out of your way. Ping me for a nudge.`,
    },
  ]);
  const [aiBusy, setAiBusy] = useState(false);

  // --- timer ---
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Warm the Pyodide runtime for debug problems so the first run is fast.
  useEffect(() => {
    if (isDebug) getRunner().preload();
  }, [isDebug]);

  // --- run code (debug) ---
  const runCode = useCallback(async () => {
    if (!problem.testSuite) return;
    setRunning(true);
    const result = await getRunner().run(code, problem.testSuite);
    setRunResult(result);
    runHistory.current.push({
      passed: result.tests.filter((t) => t.passed).length,
      failed: result.tests.filter((t) => !t.passed).length + (result.error || result.timedOut ? 1 : 0),
      output: result.output,
      at: elapsed,
    });
    setRunning(false);
  }, [code, problem.testSuite, elapsed]);

  // --- streaming interviewer helper ---
  const streamInterviewer = useCallback(async (url: string, body: object, userText?: string) => {
    setAiBusy(true);
    setChat((prev) => [
      ...prev,
      ...(userText ? [{ role: "user" as const, content: userText }] : []),
      { role: "interviewer" as const, content: "" },
    ]);
    await streamSSE(url, body, {
      onDelta: (t) =>
        setChat((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          copy[copy.length - 1] = { role: "interviewer", content: last.content + t };
          return copy;
        }),
      onError: (m) =>
        setChat((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: "interviewer", content: `⚠️ ${m}` };
          return copy;
        }),
    });
    setAiBusy(false);
  }, []);

  // --- submit for grading ---
  const submit = useCallback(async () => {
    setSubmitting(true);
    const submission = isDebug
      ? { mode: "debug" as const, code, runHistory: runHistory.current }
      : { mode: "review" as const, comments };

    try {
      const res = await fetch("/api/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ problemId: problem.id, sessionId: getSessionId(), submission }),
      });
      if (!res.ok) throw new Error(`Grading failed (${res.status})`);
      const data: { attemptId: string; grade: Grade } = await res.json();
      attemptId.current = data.attemptId;
      setGrade(data.grade);
      setChat([]);
      setPhase("results");
      // Open the Socratic follow-up.
      void streamInterviewer("/api/socratic", { attemptId: data.attemptId, history: [] });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Something went wrong grading your submission.");
    } finally {
      setSubmitting(false);
    }
  }, [isDebug, code, comments, problem.id, streamInterviewer]);

  // --- interviewer input (mode depends on phase) ---
  const onInterviewerSend = useCallback(
    (text: string) => {
      if (phase === "results" && attemptId.current) {
        void streamInterviewer("/api/socratic", { attemptId: attemptId.current, history: chat, userMessage: text }, text);
      } else {
        void streamInterviewer(
          "/api/hint",
          {
            problemId: problem.id,
            code: isDebug ? code : undefined,
            output: runResult?.output,
            diffText: isReview ? diffToText(problem) : undefined,
            history: chat,
            userMessage: text,
          },
          text,
        );
      }
    },
    [phase, chat, problem, isDebug, isReview, code, runResult, streamInterviewer],
  );

  const askHint = useCallback(() => {
    if (aiBusy) return;
    onInterviewerSend("Give me a nudge — not the answer.");
  }, [aiBusy, onInterviewerSend]);

  const canSubmit = useMemo(() => {
    if (submitting) return false;
    if (isReview) return comments.length > 0;
    return true;
  }, [submitting, isReview, comments.length]);

  const crumbType = isDebug ? "Debug" : isReview ? "Code review" : "System design";
  const submitLabel = isReview ? "Submit review" : "Submit for review";
  const interviewerRole =
    phase === "results" ? "Probing the gaps you missed" : "Quiet until you ask · then probes your gaps";
  const interviewerFooter =
    phase === "results" ? "The follow-up is where the learning is" : "Hints on-demand while you solve · full grading on submit";

  return (
    <div className={shell.solve}>
      <div className={shell.subbar}>
        <span className={shell.crumb}>
          Practice / <b>{crumbType}</b>
        </span>
        <span className={shell.title}>{problem.title}</span>
        <span className={shell.timer}>
          <span className={shell.dot} /> {mmss(elapsed)}
        </span>
        <div className={shell.grow} />
        {phase === "solve" && (
          <>
            <button className={shell.hintbtn} onClick={askHint} disabled={aiBusy}>
              Ask for a hint
            </button>
            <button className={shell.submit} onClick={submit} disabled={!canSubmit} title={isReview && comments.length === 0 ? "Leave at least one comment first" : undefined}>
              {submitting ? "Grading…" : submitLabel}
            </button>
          </>
        )}
      </div>

      <div className={shell.stage}>
        <div className={shell.center}>
          {phase === "results" && grade ? (
            <Results grade={grade} onReview={() => setPhase("solve")} />
          ) : isDebug ? (
            <DebugPane code={code} onCodeChange={setCode} onRun={runCode} running={running} result={runResult} />
          ) : isReview ? (
            <ReviewPane
              title={problem.title}
              prompt={problem.prompt}
              prMeta={problem.prMeta}
              diff={problem.diff ?? []}
              comments={comments}
              onAddComment={(line, body) => setComments((c) => [...c, { line, body }])}
              onRemoveComment={(index) => setComments((c) => c.filter((_, i) => i !== index))}
            />
          ) : (
            <div style={{ padding: 40, color: "var(--steel)" }}>System design is a phase-2 mode — not available yet.</div>
          )}
        </div>

        <InterviewerPanel
          role={interviewerRole}
          messages={chat}
          onSend={onInterviewerSend}
          busy={aiBusy}
          footer={interviewerFooter}
        />
      </div>
    </div>
  );
}
