/**
 * Generation self-check (spec §11.5) — the pass that makes generated problems
 * trustworthy. For debug problems it EXECUTES the code so we never seed a
 * hallucinated bug: the correct code must pass every test, and the buggy code
 * must fail at least one. If either fails, the problem is rejected.
 *
 * Offline generation runs in Node (not the browser), so this shells out to the
 * system `python3` — the same execution contract as the Pyodide harness, minus
 * the WASM sandbox. Browser execution stays on Pyodide; this is generation-time
 * verification only.
 */
import { execFile } from "node:child_process";
import type { TestSuite } from "../types";

/** Python program mirroring lib/pyodide/harness.ts, reading inputs from argv-fed JSON on stdin. */
const RUNNER = `
import json, sys, traceback

payload = json.load(sys.stdin)
setup = payload.get("setup", "")
user_code = payload["code"]
cases = payload["cases"]

def fmt(e):
    return "".join(traceback.format_exception_only(type(e), e)).strip()

out = {"tests": [], "error": None}
ns = {}
try:
    if setup:
        exec(setup, ns)
    exec(user_code, ns)
    for c in cases:
        try:
            exec(c["body"], dict(ns))
            out["tests"].append({"name": c["name"], "passed": True})
        except AssertionError as e:
            out["tests"].append({"name": c["name"], "passed": False, "message": str(e) or "assert"})
        except Exception as e:
            out["tests"].append({"name": c["name"], "passed": False, "message": fmt(e)})
except Exception as e:
    out["error"] = fmt(e)

print(json.dumps(out))
`;

interface RunOutput {
  tests: { name: string; passed: boolean; message?: string }[];
  error: string | null;
}

/** Execute `code` against `suite` via python3 with a hard timeout. */
function runPython(code: string, suite: TestSuite, timeoutMs = 5000): Promise<RunOutput> {
  return new Promise((resolve) => {
    const child = execFile(
      "python3",
      ["-c", RUNNER],
      { timeout: timeoutMs },
      (err, stdout) => {
        if (err && !stdout) {
          resolve({ tests: [], error: `python3 failed: ${err.message}` });
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()) as RunOutput);
        } catch {
          resolve({ tests: [], error: `unparseable output: ${stdout.slice(0, 200)}` });
        }
      },
    );
    child.stdin?.end(JSON.stringify({ setup: suite.setup ?? "", code, cases: suite.cases }));
  });
}

export interface SelfCheckResult {
  ok: boolean;
  reason: string;
  /** 0–1 heuristic quality signal derived from how cleanly the check passed. */
  qualityScore: number;
}

/**
 * Verify a generated debug problem: correct code all-green, buggy code fails
 * ≥1 test, and the failure is a plain assertion (a real behavioural bug) rather
 * than a crash/timeout that would just confuse the user.
 */
export async function selfCheckDebug(
  correctCode: string,
  buggyCode: string,
  suite: TestSuite,
): Promise<SelfCheckResult> {
  if (!suite.cases?.length) return { ok: false, reason: "no test cases", qualityScore: 0 };

  const clean = await runPython(correctCode, suite);
  if (clean.error) return { ok: false, reason: `correct code errored: ${clean.error}`, qualityScore: 0 };
  if (!clean.tests.every((t) => t.passed))
    return { ok: false, reason: "correct code does not pass all tests", qualityScore: 0 };

  const buggy = await runPython(buggyCode, suite);
  if (buggy.error)
    return { ok: false, reason: `buggy code crashes before tests (not a clean bug): ${buggy.error}`, qualityScore: 0.2 };

  const failing = buggy.tests.filter((t) => !t.passed);
  if (failing.length === 0)
    return { ok: false, reason: "buggy code still passes all tests — the flaw isn't real", qualityScore: 0 };

  // Quality: reward a bug that fails some (not all) tests — a targeted flaw,
  // not code that's broken everywhere.
  const failRatio = failing.length / buggy.tests.length;
  const qualityScore = failRatio >= 1 ? 0.7 : 1 - Math.abs(0.5 - failRatio);
  return { ok: true, reason: `verified: correct passes, buggy fails ${failing.map((t) => t.name).join(", ")}`, qualityScore };
}
