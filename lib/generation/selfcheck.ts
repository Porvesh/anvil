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
import type { SolutionFile, TestSuite } from "../types";

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
