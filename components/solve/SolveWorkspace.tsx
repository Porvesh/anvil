"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, Grade, PublicProblem, ReviewComment, RunRecord, RunResult, SolutionFile } from "@/lib/types";
import { getRunner } from "@/lib/pyodide/runner";
import { getSessionId } from "@/lib/session";
import { streamSSE } from "@/lib/sseClient";
import { clearSolveDraft, readSolveDraft, writeSolveDraft } from "@/lib/solveDraft";
import { notifyByokRequired } from "@/lib/byokClient";
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
  const [mobilePane, setMobilePane] = useState<"workspace" | "interviewer">("workspace");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [grade, setGrade] = useState<Grade | null>(null);
  const attemptId = useRef<string | null>(null);
  const gradingAbort = useRef<AbortController | null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const [draftStatus, setDraftStatus] = useState<string | null>(null);
  const persistDraft = useRef(true);

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

  // Restore after hydration so server and client produce the same first render.
  // Reset first because client navigation between two /solve/[id] pages may reuse
  // this component position; no state from the previous problem may bleed over.
  useEffect(() => {
    persistDraft.current = false;
    setDraftReady(false);
    setFiles(problem.files ?? []);
    setActivePath((problem.files ?? []).find((file) => !file.readOnly)?.path ?? problem.files?.[0]?.path ?? "");
    setCode(problem.starterCode ?? "");
    setComments([]);
    setRunResult(null);
    setRuns([]);
    setChat([{ role: "interviewer", content: GREETINGS[mode] }]);
    setGrade(null);
    setPhase("solve");
    attemptId.current = null;

    const draft = readSolveDraft(problem.id, mode);
    if (draft?.mode === "debug") {
      setFiles(draft.files);
      setActivePath(draft.files.some((file) => file.path === draft.activePath) ? draft.activePath : draft.files[0]?.path ?? "");
      setRuns(draft.runs);
      setRunResult(draft.runResult);
    } else if (draft?.mode === "review") {
      setComments(draft.comments);
    } else if (draft?.mode === "design") {
      setCode(draft.code);
    }
    if (draft?.chat.length) setChat(draft.chat);
    setDraftStatus(draft ? "Draft restored" : null);
    persistDraft.current = true;
    setDraftReady(true);
  }, [mode, problem]);

  const saveDraft = useCallback(() => {
    if (!draftReady || !persistDraft.current || phase !== "solve") return;
    const common = { problemId: problem.id, chat };
    const saved = isDebug
      ? writeSolveDraft({ ...common, mode: "debug", files, activePath, runs, runResult })
      : isReview
        ? writeSolveDraft({ ...common, mode: "review", comments })
        : writeSolveDraft({ ...common, mode: "design", code });
    if (saved) setDraftStatus("Saved locally");
  }, [activePath, chat, code, comments, draftReady, files, isDebug, isReview, phase, problem.id, runResult, runs]);

  useEffect(() => {
    if (!draftReady || !persistDraft.current || phase !== "solve") return;
    const timer = window.setTimeout(saveDraft, 500);
    return () => window.clearTimeout(timer);
  }, [draftReady, phase, saveDraft]);

  useEffect(() => {
    const flush = () => saveDraft();
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [saveDraft]);

  // --- run code (debug) ---
  const runCode = useCallback(async () => {
    if (!problem.testSuite || running) return;
    setRunning(true);
    try {
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
    } catch (error) {
      setRunResult({
        ok: false,
        output: "",
        tests: [],
        error: error instanceof Error ? error.message : "The browser runner stopped unexpectedly.",
      });
    } finally {
      setRunning(false);
    }
  }, [files, problem.testSuite, running]);

  // --- streaming interviewer helper ---
  // Each stream gets a generation id; a newer stream (or the submit flow, which
  // resets the transcript) invalidates older ones so late deltas can't write
  // into the wrong bubble — or into an empty transcript.
  const streamGen = useRef(0);
  const streamAbort = useRef<AbortController | null>(null);
  const streamInterviewer = useCallback(async (url: string, body: object, userText?: string) => {
    streamAbort.current?.abort();
    const abort = new AbortController();
    streamAbort.current = abort;
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
      await streamSSE(
        url,
        body,
        {
          onDelta: (t) => patchLast((last) => ({ role: "interviewer", content: last.content + t })),
          onError: (m) =>
            patchLast((last) => ({
              role: "interviewer",
              content: last.content ? `${last.content}\n\n${m}` : `⚠️ ${m}`,
            })),
        },
        { signal: abort.signal },
      );
    } catch (err) {
      if (!abort.signal.aborted) {
        // Fetch threw or the reader died mid-stream — surface it rather than hang.
        patchLast(() => ({ role: "interviewer", content: `⚠️ ${err instanceof Error ? err.message : "Connection lost. Try again."}` }));
      }
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
      if (streamAbort.current === abort) streamAbort.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      streamAbort.current?.abort();
      gradingAbort.current?.abort();
    };
  }, []);

  /** Transcript as sent to the model routes — never includes blank bubbles. */
  const historyFor = (messages: ChatMessage[]) => messages.filter((m) => m.content.trim() !== "");

  // --- submit for grading ---
  const submit = useCallback(async () => {
    gradingAbort.current?.abort();
    const abort = new AbortController();
    gradingAbort.current = abort;
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
        signal: abort.signal,
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        notifyByokRequired(detail?.code);
        throw new Error(detail?.error ?? `Grading failed (${res.status})`);
      }
      const data: { attemptId: string; grade: Grade } = await res.json();
      attemptId.current = data.attemptId;
      setGrade(data.grade);
      streamAbort.current?.abort();
      streamGen.current++; // invalidate any in-flight hint stream before resetting the transcript
      setAiBusy(false);
      setChat([]);
      setPhase("results");
      setMobilePane("workspace");
      persistDraft.current = false;
      clearSolveDraft(problem.id);
      setDraftStatus(null);
      // Open the Socratic follow-up.
      void streamInterviewer("/api/socratic", { attemptId: data.attemptId, history: [] });
    } catch (err) {
      setSubmitError(
        abort.signal.aborted
          ? "Grading cancelled. Your draft is saved locally."
          : err instanceof Error
            ? err.message
            : "Something went wrong grading your submission. Your draft is saved locally.",
      );
    } finally {
      if (gradingAbort.current === abort) gradingAbort.current = null;
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
        const latestRun = runResult
          ? [
              runResult.output,
              ...runResult.tests
                .filter((test) => !test.passed)
                .map((test) => `FAIL ${test.name}${test.message ? `: ${test.message}` : ""}`),
              runResult.error ? `ERROR: ${runResult.error}` : "",
              runResult.timedOut ? "Execution timed out." : "",
            ]
              .filter(Boolean)
              .join("\n")
          : undefined;
        void streamInterviewer(
          "/api/hint",
          {
            problemId: problem.id,
            files: isDebug ? files : undefined,
            output: isDebug ? latestRun : undefined,
            diffText: isReview ? diffToText(problem) : undefined,
            doc: isDesign ? code : undefined,
            history: historyFor(chat),
            userMessage: text,
          },
          text,
        );
      }
    },
    [chat, problem, isDebug, isReview, isDesign, files, code, runResult, streamInterviewer],
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
        <h1 className={shell.title}>{problem.title}</h1>
        {phase === "solve" && draftStatus && <span className={shell.draftStatus}>{draftStatus}</span>}
        <div className={shell.grow} />
        <div className={shell.mobileNav} role="tablist" aria-label="Solve view">
          <button
            role="tab"
            aria-selected={mobilePane === "workspace"}
            className={mobilePane === "workspace" ? shell.mobileNavOn : ""}
            onClick={() => setMobilePane("workspace")}
          >
            Workspace
          </button>
          <button
            role="tab"
            aria-selected={mobilePane === "interviewer"}
            className={mobilePane === "interviewer" ? shell.mobileNavOn : ""}
            onClick={() => setMobilePane("interviewer")}
          >
            Interviewer{aiBusy ? "…" : ""}
          </button>
        </div>
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
        <div className={`${shell.center} ${mobilePane === "workspace" ? shell.mobileActive : shell.mobileHidden}`}>
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
              onAddComment={(file, line, body) => setComments((c) => [...c, { file, line, body }])}
              onRemoveComment={(index) => setComments((c) => c.filter((_, i) => i !== index))}
            />
          ) : (
            <>
              <ProblemBrief type="design" difficulty={problem.difficulty} prompt={problem.prompt} />
              <DesignPane doc={code} onDocChange={setCode} />
            </>
          )}
          {submitting && <GradingOverlay onCancel={() => gradingAbort.current?.abort()} />}
        </div>

        <InterviewerPanel
          className={mobilePane === "interviewer" ? shell.mobileActive : shell.mobileHidden}
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
