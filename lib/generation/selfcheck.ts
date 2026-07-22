/**
 * Generation self-check (spec §11.5) — the pass that makes generated problems
 * trustworthy. For debug problems it EXECUTES the multi-file project so we never
 * seed a hallucinated bug: the correct project must pass every test, and the
 * buggy project must fail at least one. If either fails, the problem is rejected.
 *
 * Offline generation runs in Node (not the browser), so this shells out to the
 * system `python3` using the SAME multi-file execution contract as the Pyodide
 * harness (write the package to a temp dir, put it on sys.path, import, test).
 */
import { execFile } from "node:child_process";
import type { AnswerKeyIssue, DiffHunk, Problem, SolutionFile, TestSuite } from "../types";
import { gradeDesign } from "../grading";

/** Python program mirroring lib/pyodide/harness.ts (multi-file), reading a JSON
 *  payload {files, setup, cases} on stdin. */
const RUNNER = `
import json, os, sys, shutil, importlib, tempfile, traceback

payload = json.load(sys.stdin)
files = payload["files"]
setup = payload.get("setup", "")
cases = payload["cases"]

def fmt(e):
    return "".join(traceback.format_exception_only(type(e), e)).strip()

ROOT = tempfile.mkdtemp(prefix="anvil_gen_")
out = {"tests": [], "error": None}
try:
    for f in files:
        full = os.path.join(ROOT, f["path"])
        os.makedirs(os.path.dirname(full) or ROOT, exist_ok=True)
        with open(full, "w") as fh:
            fh.write(f["content"])
    sys.path.insert(0, ROOT)
    importlib.invalidate_caches()
    ns = {}
    if setup:
        exec(setup, ns)
    for c in cases:
        try:
            exec(c["body"], dict(ns))
            out["tests"].append({"name": c["name"], "passed": True, "assertion": False})
        except AssertionError as e:
            # a behavioural failure — the intended kind of bug
            out["tests"].append({"name": c["name"], "passed": False, "assertion": True, "message": str(e) or "assert"})
        except Exception as e:
            # a crash (TypeError/KeyError/...) — not a clean behavioural mismatch
            out["tests"].append({"name": c["name"], "passed": False, "assertion": False, "message": fmt(e)})
except Exception as e:
    out["error"] = fmt(e)
finally:
    shutil.rmtree(ROOT, ignore_errors=True)

print(json.dumps(out))
`;

interface RunOutput {
  tests: { name: string; passed: boolean; assertion?: boolean; message?: string }[];
  error: string | null;
}

/** A project path is unsafe if it could escape the temp root when written
 *  server-side (absolute, parent traversal, or empty). Reject such problems. */
function unsafePath(p: string): boolean {
  return !p || p.trim() === "" || p.startsWith("/") || p.split(/[\\/]/).includes("..");
}

/** Execute a multi-file project against `suite` via python3 with a hard timeout.
 *  Each run uses a fresh process, so module caches never leak between correct/buggy. */
function runPython(files: SolutionFile[], suite: TestSuite, timeoutMs = 5000): Promise<RunOutput> {
  return new Promise((resolve) => {
    const child = execFile("python3", ["-c", RUNNER], { timeout: timeoutMs }, (err, stdout) => {
      if (err && !stdout) {
        resolve({ tests: [], error: `python3 failed: ${err.message}` });
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as RunOutput);
      } catch {
        resolve({ tests: [], error: `unparseable output: ${stdout.slice(0, 200)}` });
      }
    });
    child.stdin?.end(
      JSON.stringify({ files: files.map((f) => ({ path: f.path, content: f.content })), setup: suite.setup ?? "", cases: suite.cases }),
    );
  });
}

export interface SelfCheckResult {
  ok: boolean;
  reason: string;
  /** 0–1 heuristic quality signal derived from how cleanly the check passed. */
  qualityScore: number;
}

/**
 * Verify a generated debug problem: correct project all-green, buggy project
 * fails ≥1 test, and the failure is a plain assertion (a real behavioural bug)
 * rather than a crash that would just confuse the user.
 */
export async function selfCheckDebug(
  correctFiles: SolutionFile[],
  buggyFiles: SolutionFile[],
  suite: TestSuite,
): Promise<SelfCheckResult> {
  return runOracle(correctFiles, buggyFiles, suite);
}

/**
 * Verify a generated review problem.
 *
 * A review problem is a correct/buggy pair too — the PR's post-merge state is
 * the buggy code — so it gets the *same execution oracle* as debug rather than
 * a model asking itself whether it did a good job. This is what B7 buys: review
 * problems were previously banked on a model's say-so, which is why the bank
 * skewed 13 debug / 4 review.
 *
 * It adds one gate debug doesn't need: the answer key's line numbers are diff
 * coordinates, and the matcher credits a catch within ±1 line of them. If the
 * key says line 42 and the flaw is really at 47, every reviewer who spots it
 * scores as having missed it. So the cited lines are checked against the diff
 * *and* the buggy file content — deterministically, since this is exactly the
 * kind of coordinate bookkeeping a model is worst at and the matcher is most
 * sensitive to.
 */
export async function selfCheckReview(problem: {
  diff: DiffHunk[];
  answerKey: AnswerKeyIssue[];
  correctFiles: SolutionFile[];
  buggyFiles: SolutionFile[];
  setup: string;
  cases: { name: string; body: string }[];
}): Promise<SelfCheckResult> {
  const anchors = checkDiffAnchors(problem.diff, problem.buggyFiles, problem.answerKey);
  if (!anchors.ok) return { ok: false, reason: anchors.reason, qualityScore: 0 };

  const exec = await runOracle(problem.correctFiles, problem.buggyFiles, {
    setup: problem.setup,
    cases: problem.cases,
  });
  if (!exec.ok) return exec;

  return {
    ok: true,
    reason: `${exec.reason}; ${anchors.reason}`,
    qualityScore: exec.qualityScore,
  };
}

/**
 * The minimum gap, in points, between a strong and a deliberately weak answer
 * for a design rubric to count as discriminating.
 */
const MIN_SEPARATION = 25;

/**
 * Verify a generated design problem by checking that its rubric *discriminates*.
 *
 * Debug and review prove a flaw is real by executing it. Design has nothing to
 * execute, and the model owns the whole score, so the failure mode is a rubric
 * so vague that any fluent answer scores well — the design equivalent of a bug
 * that doesn't break a test. The gate: grade a strong answer and a plausible-
 * but-shallow one through the *real* grading path, and require a wide gap. If
 * the rubric can't separate answers the generator itself wrote to be different,
 * it certainly can't separate two users.
 */
export async function selfCheckDesign(problem: {
  title: string;
  prompt: string;
  rubric: AnswerKeyIssue[];
  strongAnswer: string;
  weakAnswer: string;
}): Promise<SelfCheckResult> {
  if (problem.rubric.length < 3) {
    return { ok: false, reason: `rubric has only ${problem.rubric.length} dimensions`, qualityScore: 0 };
  }

  // Graded through gradeDesign, not a bespoke check, so the gate measures the
  // scoring users will actually receive — including its ensemble averaging.
  const asProblem = {
    title: problem.title,
    prompt: problem.prompt,
    answerKey: problem.rubric,
    type: "design",
  } as unknown as Problem;

  const [strong, weak] = await Promise.all([
    gradeDesign(asProblem, problem.strongAnswer),
    gradeDesign(asProblem, problem.weakAnswer),
  ]);

  const separation = strong.score - weak.score;
  if (separation < MIN_SEPARATION) {
    return {
      ok: false,
      reason: `rubric does not discriminate: strong ${strong.score} vs weak ${weak.score} (gap ${separation}, need ${MIN_SEPARATION})`,
      qualityScore: Math.max(0, separation / 100),
    };
  }
  if (strong.score < 70) {
    // If the reference answer can't clear the bar, the rubric is asking for
    // something the brief doesn't support and every real user will fail it.
    return { ok: false, reason: `strong reference answer only scored ${strong.score}`, qualityScore: 0.3 };
  }

  return {
    ok: true,
    reason: `rubric discriminates: strong ${strong.score} vs weak ${weak.score} (gap ${separation})`,
    // Wider separation is a better rubric, saturating at a 60-point gap.
    qualityScore: Math.min(1, separation / 60),
  };
}

/**
 * Every answer-key line range must land on a real diff line whose content
 * matches the buggy file at that line number. Guards the matcher's coordinate
 * assumption (see selfCheckReview).
 */
function checkDiffAnchors(
  diff: DiffHunk[],
  buggyFiles: SolutionFile[],
  answerKey: AnswerKeyIssue[],
): { ok: boolean; reason: string } {
  if (!answerKey.length) return { ok: false, reason: "empty answer key" };

  const fileContent = new Map(buggyFiles.map((f) => [f.path, f.content.split("\n")]));

  for (const issue of answerKey) {
    const hunk = diff.find((h) => h.file === issue.file);
    if (!hunk) return { ok: false, reason: `answer key cites ${issue.file}, which the diff doesn't touch` };

    // Only add/context lines carry new-file numbering; deleted lines have none,
    // and a flaw can't live on a line the PR removed.
    const numbered = new Map(
      hunk.lines.filter((l) => l.lineNo !== null && l.kind !== "del").map((l) => [l.lineNo as number, l.content]),
    );

    for (let line = issue.lineStart; line <= issue.lineEnd; line++) {
      const diffLine = numbered.get(line);
      if (diffLine === undefined) {
        return { ok: false, reason: `answer key ${issue.id} cites ${issue.file}:${line}, absent from the diff` };
      }
      const source = fileContent.get(issue.file ?? "");
      // The diff is the coordinate system the user comments in; the file is what
      // the oracle executed. If they disagree, the key can't point at both.
      if (source && source[line - 1] !== undefined && source[line - 1].trim() !== diffLine.trim()) {
        return {
          ok: false,
          reason: `answer key ${issue.id}: diff and buggy file disagree at ${issue.file}:${line}`,
        };
      }
    }
  }
  return { ok: true, reason: `${answerKey.length} answer-key anchors verified against the diff` };
}

/** The shared correct-passes / buggy-fails execution gate. */
async function runOracle(
  correctFiles: SolutionFile[],
  buggyFiles: SolutionFile[],
  suite: TestSuite,
): Promise<SelfCheckResult> {
  if (!suite.cases?.length) return { ok: false, reason: "no test cases", qualityScore: 0 };

  // Reject unsafe paths before ever writing to disk server-side.
  const badPath = [...correctFiles, ...buggyFiles].map((f) => f.path).find(unsafePath);
  if (badPath) return { ok: false, reason: `unsafe file path: ${badPath}`, qualityScore: 0 };

  // Correct and buggy must describe the SAME project (same file set), or the
  // "buggy fails" signal isn't comparable to "correct passes".
  const correctPaths = correctFiles.map((f) => f.path).sort().join("|");
  const buggyPaths = buggyFiles.map((f) => f.path).sort().join("|");
  if (correctPaths !== buggyPaths) return { ok: false, reason: "correct/buggy file sets differ", qualityScore: 0 };

  const clean = await runPython(correctFiles, suite);
  if (clean.error) return { ok: false, reason: `correct project errored: ${clean.error}`, qualityScore: 0 };
  if (!clean.tests.every((t) => t.passed))
    return { ok: false, reason: "correct project does not pass all tests", qualityScore: 0 };

  const buggy = await runPython(buggyFiles, suite);
  if (buggy.error)
    return { ok: false, reason: `buggy project crashes before tests (not a clean bug): ${buggy.error}`, qualityScore: 0.2 };

  const failing = buggy.tests.filter((t) => !t.passed);
  if (failing.length === 0)
    return { ok: false, reason: "buggy project still passes all tests — the flaw isn't real", qualityScore: 0 };
  // At least one failure must be behavioural (an assertion), not just a crash —
  // otherwise the user gets a confusing stack trace instead of a real bug.
  if (!failing.some((t) => t.assertion))
    return { ok: false, reason: "buggy project only crashes tests (no behavioural/assertion failure)", qualityScore: 0.2 };

  const failRatio = failing.length / buggy.tests.length;
  const qualityScore = failRatio >= 1 ? 0.7 : 1 - Math.abs(0.5 - failRatio);
  return { ok: true, reason: `verified: correct passes, buggy fails ${failing.map((t) => t.name).join(", ")}`, qualityScore };
}
