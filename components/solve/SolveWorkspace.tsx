"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { ChatMessage, Grade, PublicProblem, ReviewComment, RunRecord, RunResult, SolutionFile } from "@/lib/types";
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

// Greetings deliberately set the *mode* ("here's how we interact") without
// previewing the failure mode or the rubric. Telling the user "the PR
// description is the trap" or "nits cost points" biases them before they've
// even read the problem — that's spoiling the problem in sentence one.
const GREETINGS: Record<"debug" | "review" | "design", string> = {
  debug: "I'm here if you want a nudge — not the answer. Otherwise I'll stay quiet while you work.",
  review: "Comment on any line as you go. Ping me if you want to think out loud.",
  design: "I'll play the interviewer. Draft in the doc; ask me to pressure-test whenever you want.",
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
  // Debug edits a multi-file project (`files`); design edits a doc (`code`);
  // review edits `comments`.
  const [files, setFiles] = useState<SolutionFile[]>(problem.files ?? []);
  const [activePath, setActivePath] = useState(
    () => (problem.files ?? []).find((f) => !f.readOnly)?.path ?? problem.files?.[0]?.path ?? "",
  );
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

  // Solve started at (monotonic) — used to timestamp runs for approach
  // grading. We no longer render a live-ticking clock in the top bar: it
  // was pure pressure with no product signal (didn't feed the grade, was
  // hidden on the results screen) and works against the 'we train
  // judgment, not speed' thesis. If we want timing later, it should show
  // up on results (post-facto), not as a stressor in the chrome.
  const startedAt = useRef(Date.now());
  const readElapsed = () => Math.floor((Date.now() - startedAt.current) / 1000);

  // --- run code (debug) ---
  const runCode = useCallback(async () => {
    if (!problem.testSuite || running) return;
    setRunning(true);
    const result = await getRunner().run(files, problem.testSuite);
    setRunResult(result);
    setRuns((prev) => [
      ...prev,
      {
        passed: result.tests.filter((t) => t.passed).length,
        failed: result.tests.filter((t) => !t.passed).length + (result.error || result.timedOut ? 1 : 0),
        output: result.output,
        at: readElapsed(),
      },
    ]);
    setRunning(false);
  }, [files, problem.testSuite, running]);

  // --- streaming interviewer helper ---
  // Each stream gets a generation id; a newer stream (or the submit flow, which
  // resets the transcript) invalidates older ones so late deltas can't write
  // into the wrong bubble — or into an empty transcript.
  const streamGen = useRef(0);
  const streamInterviewer = useCallback(async (url: string, body: object, userText?: string) => {
    const gen = ++streamGen.current;
    setAiBusy(true);
    // Drop any leftover blank interviewer bubble from a superseded stream, then
    // append this turn's user text + a fresh empty bubble to stream into.
    setChat((prev) => [
      ...prev.filter((m) => !(m.role === "interviewer" && m.content === "")),
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
    try {
      await streamSSE(url, body, {
        onDelta: (t) => patchLast((last) => ({ role: "interviewer", content: last.content + t })),
        onError: (m) => patchLast(() => ({ role: "interviewer", content: `⚠️ ${m}` })),
      });
    } catch (err) {
      // fetch threw or the reader died mid-stream — surface it rather than hang.
      patchLast(() => ({ role: "interviewer", content: `⚠️ ${err instanceof Error ? err.message : "connection lost"}` }));
    } finally {
      // Only the current stream owns cleanup; a superseded one must not reset the
      // newer stream's busy-state. The finally guarantees aiBusy is always cleared.
      if (gen === streamGen.current) {
        setChat((prev) => {
          const last = prev[prev.length - 1];
          return last && last.role === "interviewer" && last.content === "" ? prev.slice(0, -1) : prev;
        });
        setAiBusy(false);
      }
    }
  }, []);

  /** Transcript as sent to the model routes — never includes blank bubbles. */
  const historyFor = (messages: ChatMessage[]) => messages.filter((m) => m.content.trim() !== "");

  // --- submit for grading ---
  const submit = useCallback(async () => {
    setSubmitting(true);
    setSubmitError(null);
    const submission = isDebug
      ? { mode: "debug" as const, files, runHistory: runs }
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
  }, [isDebug, isReview, files, code, comments, runs, problem.id, streamInterviewer]);

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
        <span className={shell.crumb}>{crumbType}</span>
        <span className={shell.title}>{problem.title}</span>
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
              // No top-bar hint button: the interviewer panel already has
              // quick-suggestion chips ('Give me a nudge — not the answer')
              // that do the exact same thing, plus a free-form textarea.
              // One primary action in the top bar keeps focus on Submit.
              <button
                className={shell.submit}
                onClick={submit}
                disabled={!canSubmit}
                title={isReview && comments.length === 0 ? "Leave at least one comment first" : undefined}
              >
                {submitting ? "Grading…" : submitLabel}
              </button>
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
              <ProblemBrief type="debug" difficulty={problem.difficulty} prompt={problem.prompt} />
              <DebugPane
                files={files}
                activePath={activePath}
                onSelectFile={setActivePath}
                onFileChange={(path, content) => {
                  setFiles((prev) => prev.map((f) => (f.path === path ? { ...f, content } : f)));
                  // Edits invalidate the last run — reset the "all green" signal so
                  // the Tests panel doesn't show a stale pass after the code changed.
                  if (runResult) setRunResult(null);
                }}
                onRun={runCode}
                running={running}
                result={runResult}
                runs={runs}
              />
            </>
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
            <>
              <ProblemBrief type="design" difficulty={problem.difficulty} prompt={problem.prompt} />
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
