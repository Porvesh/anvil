"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, Grade, PublicProblem, ReviewComment, RunRecord, RunResult } from "@/lib/types";
import { getRunner } from "@/lib/pyodide/runner";
import { getSessionId } from "@/lib/session";
import { streamSSE } from "@/lib/sseClient";
import { DebugPane } from "./DebugPane";
import { ReviewPane } from "./ReviewPane";
import { DesignPane } from "./DesignPane";
import { ProblemBrief } from "./ProblemBrief";
import { GradingOverlay } from "./GradingOverlay";
import { InterviewerPanel } from "@/components/ai/InterviewerPanel";
import { Results } from "@/components/results/Results";
import shell from "./Solve.module.css";

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

const SOLVE_SUGGESTIONS: Record<"debug" | "review" | "design", string[]> = {
  debug: ["Where should I start?", "Give me a nudge — not the answer", "Why would this matter in prod?"],
  review: ["Where should I start?", "Give me a nudge — not the answer", "What would you block a PR over?"],
  design: ["What should I pin down first?", "Poke a hole in my current draft", "Is my capacity math sane?"],
};
const RESULTS_SUGGESTIONS = ["Walk me through what I missed", "How would I catch this next time?"];

const GREETINGS: Record<"debug" | "review" | "design", string> = {
  debug:
    "Read the bug report above, then trace the code before changing anything. Run early, run often — the failing tests are your map. Ping me for a nudge.",
  review:
    "Read the PR like you'd review a teammate's — the description sounds reasonable, which is exactly the trap. Click a line to comment. I'm here if you want a nudge.",
  design:
    "Treat me as the interviewer in the room: state your assumptions, do the capacity math out loud, and argue trade-offs in the doc. Ask me to poke holes whenever you want pressure.",
};

/**
 * The solve workspace (spec §6): the shared shell whose center pane morphs by
 * mode, plus the persistent interviewer panel. Owns the whole loop —
 * edit/run/comment/write → submit → grade → Socratic follow-up — as a small
 * phase machine, mirroring the single-surface flow of the v1.html prototype.
 */
export function SolveWorkspace({ problem }: { problem: PublicProblem }) {
  const isDebug = problem.type === "debug";
  const isReview = problem.type === "review";
  const isDesign = problem.type === "design";
  const mode: "debug" | "review" | "design" = isDebug ? "debug" : isReview ? "review" : "design";

  // --- solve state ---
  // `code` is the editable artifact for the mode: Python for debug, the design
  // doc (markdown) for design. Review mode edits `comments` instead.
  const [code, setCode] = useState(problem.starterCode ?? "");
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);

  // --- flow state ---
  const [phase, setPhase] = useState<Phase>("solve");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [grade, setGrade] = useState<Grade | null>(null);
  const attemptId = useRef<string | null>(null);

  // --- interviewer chat ---
  const [chat, setChat] = useState<ChatMessage[]>([{ role: "interviewer", content: GREETINGS[mode] }]);
  const [aiBusy, setAiBusy] = useState(false);

  // --- timer (paused while the results screen is up) ---
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (phase !== "solve") return;
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [phase]);

  const elapsedRef = useRef(elapsed);
  elapsedRef.current = elapsed;

  // --- run code (debug) ---
  const runCode = useCallback(async () => {
    if (!problem.testSuite || running) return;
    setRunning(true);
    const result = await getRunner().run(code, problem.testSuite);
    setRunResult(result);
    setRuns((prev) => [
      ...prev,
      {
        passed: result.tests.filter((t) => t.passed).length,
        failed: result.tests.filter((t) => !t.passed).length + (result.error || result.timedOut ? 1 : 0),
        output: result.output,
        at: elapsedRef.current,
      },
    ]);
    setRunning(false);
  }, [code, problem.testSuite, running]);

  // --- streaming interviewer helper ---
  // Each stream gets a generation id; a newer stream (or the submit flow, which
  // resets the transcript) invalidates older ones so late deltas can't write
  // into the wrong bubble — or into an empty transcript.
  const streamGen = useRef(0);
  const streamInterviewer = useCallback(async (url: string, body: object, userText?: string) => {
    const gen = ++streamGen.current;
    setAiBusy(true);
    setChat((prev) => [
      ...prev,
      ...(userText ? [{ role: "user" as const, content: userText }] : []),
      { role: "interviewer" as const, content: "" },
    ]);
    const patchLast = (patch: (last: ChatMessage) => ChatMessage) =>
      setChat((prev) => {
        if (gen !== streamGen.current || prev.length === 0) return prev;
        const copy = [...prev];
        copy[copy.length - 1] = patch(copy[copy.length - 1]);
        return copy;
      });
    await streamSSE(url, body, {
      onDelta: (t) => patchLast((last) => ({ role: "interviewer", content: last.content + t })),
      onError: (m) => patchLast(() => ({ role: "interviewer", content: `⚠️ ${m}` })),
    });
    if (gen !== streamGen.current) return; // superseded — the newer stream owns busy-state + cleanup
    // A reply that streamed zero tokens would linger as a blank bubble (and
    // poison later History payloads with empty assistant turns) — drop it.
    setChat((prev) => {
      const last = prev[prev.length - 1];
      return last && last.role === "interviewer" && last.content === "" ? prev.slice(0, -1) : prev;
    });
    setAiBusy(false);
  }, []);

  /** Transcript as sent to the model routes — never includes blank bubbles. */
  const historyFor = (messages: ChatMessage[]) => messages.filter((m) => m.content.trim() !== "");

  // --- submit for grading ---
  const submit = useCallback(async () => {
    setSubmitting(true);
    setSubmitError(null);
    const submission = isDebug
      ? { mode: "debug" as const, code, runHistory: runs }
      : isReview
        ? { mode: "review" as const, comments }
        : { mode: "design" as const, doc: code };

    try {
      const res = await fetch("/api/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ problemId: problem.id, sessionId: getSessionId(), submission }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error(detail?.error ?? `Grading failed (${res.status})`);
      }
      const data: { attemptId: string; grade: Grade } = await res.json();
      attemptId.current = data.attemptId;
      setGrade(data.grade);
      streamGen.current++; // invalidate any in-flight hint stream before resetting the transcript
      setAiBusy(false);
      setChat([]);
      setPhase("results");
      // Open the Socratic follow-up.
      void streamInterviewer("/api/socratic", { attemptId: data.attemptId, history: [] });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Something went wrong grading your submission.");
    } finally {
      setSubmitting(false);
    }
  }, [isDebug, isReview, code, comments, runs, problem.id, streamInterviewer]);

  // --- interviewer input ---
  // Once an attempt is graded the conversation stays Socratic (even if the user
  // pops back to the solve surface via "Review my answer") — the interviewer is
  // probing the graded attempt, not hinting a fresh solve.
  const onInterviewerSend = useCallback(
    (text: string) => {
      if (attemptId.current) {
        void streamInterviewer("/api/socratic", { attemptId: attemptId.current, history: historyFor(chat), userMessage: text }, text);
      } else {
        void streamInterviewer(
          "/api/hint",
          {
            problemId: problem.id,
            code: isDebug ? code : undefined,
            output: runResult?.output,
            diffText: isReview ? diffToText(problem) : undefined,
            doc: isDesign ? code : undefined,
            history: historyFor(chat),
            userMessage: text,
          },
          text,
        );
      }
    },
    [chat, problem, isDebug, isReview, isDesign, code, runResult, streamInterviewer],
  );

  const askHint = useCallback(() => {
    if (aiBusy) return;
    onInterviewerSend("Give me a nudge — not the answer.");
  }, [aiBusy, onInterviewerSend]);

  const canSubmit = useMemo(() => {
    if (submitting) return false;
    if (isReview) return comments.length > 0;
    if (isDesign) return code.trim().length > 0;
    return true;
  }, [submitting, isReview, isDesign, comments.length, code]);

  const crumbType = isDebug ? "Debug" : isReview ? "Code review" : "System design";
  const submitLabel = isReview ? "Submit review" : isDesign ? "Submit design" : "Submit for review";
  const interviewerRole =
    phase === "results" ? "Probing the gaps you missed" : isDesign ? "In the room — probes as you design" : "Quiet until you ask · then probes your gaps";
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
            {submitError && <span className={shell.error}>{submitError}</span>}
            {grade ? (
              // Post-grade "Review my answer" state: the attempt is already
              // graded, so the actions become navigation, not re-submission.
              <button className={shell.hintbtn} onClick={() => setPhase("results")}>
                Back to results
              </button>
            ) : (
              <>
                <button className={shell.hintbtn} onClick={askHint} disabled={aiBusy}>
                  Ask for a hint
                </button>
                <button
                  className={shell.submit}
                  onClick={submit}
                  disabled={!canSubmit}
                  title={isReview && comments.length === 0 ? "Leave at least one comment first" : undefined}
                >
                  {submitting ? "Grading…" : submitLabel}
                </button>
              </>
            )}
          </>
        )}
      </div>

      <div className={shell.stage}>
        <div className={shell.center}>
          {phase === "results" && grade ? (
            <Results grade={grade} mode={mode} problemId={problem.id} problemType={problem.type} onReview={() => setPhase("solve")} />
          ) : isDebug ? (
            <>
              <ProblemBrief type="debug" difficulty={problem.difficulty} prompt={problem.prompt} issueCount={problem.answerKeyCount} />
              <DebugPane code={code} onCodeChange={setCode} onRun={runCode} running={running} result={runResult} runs={runs} />
            </>
          ) : isReview ? (
            <ReviewPane
              title={problem.title}
              prompt={problem.prompt}
              prMeta={problem.prMeta}
              diff={problem.diff ?? []}
              issueCount={problem.answerKeyCount}
              comments={comments}
              onAddComment={(line, body) => setComments((c) => [...c, { line, body }])}
              onRemoveComment={(index) => setComments((c) => c.filter((_, i) => i !== index))}
            />
          ) : (
            <>
              <ProblemBrief type="design" difficulty={problem.difficulty} prompt={problem.prompt} issueCount={problem.answerKeyCount} />
              <DesignPane doc={code} onDocChange={setCode} />
            </>
          )}
          {submitting && <GradingOverlay />}
        </div>

        <InterviewerPanel
          role={interviewerRole}
          messages={chat}
          onSend={onInterviewerSend}
          busy={aiBusy}
          footer={interviewerFooter}
          suggestions={phase === "results" ? RESULTS_SUGGESTIONS : SOLVE_SUGGESTIONS[mode]}
        />
      </div>
    </div>
  );
}
