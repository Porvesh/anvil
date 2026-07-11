/**
 * The Pyodide test harness — the single source of truth for how a debug problem
 * is executed. All Python logic lives here (not in the worker) so it can be unit
 * tested and there is exactly one place that defines the execution contract.
 *
 * Execution model:
 *   1. `setup`     — problem-provided fixtures/helpers (e.g. a fake `dispatch`).
 *   2. `USER_CODE` — the user's edited solution.
 *   3. each test   — run in a shallow copy of the shared namespace so cases can't
 *                    clobber each other; an AssertionError = fail, clean = pass.
 *
 * Data crosses the JS→Python boundary via Pyodide globals (set by the worker),
 * never by string interpolation — so user code containing quotes/backslashes
 * can never break the harness.
 */
import type { RunRequest, TestSuite } from "../types";

/**
 * Fixed Python program executed by the worker. Reads USER_CODE, SETUP_CODE, and
 * TESTS_JSON from its globals and returns a JSON string:
 *   { "tests": [{ "name", "passed", "message"? }], "error": <str|null> }
 */
export const HARNESS = `
import json, traceback

def _fmt_exc(e):
    return "".join(traceback.format_exception_only(type(e), e)).strip()

def _run():
    out = {"tests": [], "error": None}
    ns = {}
    if SETUP_CODE:
        exec(SETUP_CODE, ns)
    # A failure to even load the solution (syntax error, NameError at import
    # time) is a top-level error, not a per-test failure.
    exec(USER_CODE, ns)
    for case in json.loads(TESTS_JSON):
        try:
            exec(case["body"], dict(ns))
            out["tests"].append({"name": case["name"], "passed": True})
        except AssertionError as e:
            msg = str(e) or "assertion failed"
            out["tests"].append({"name": case["name"], "passed": False, "message": msg})
        except Exception as e:  # noqa: BLE001 - report any test error to the user
            out["tests"].append({"name": case["name"], "passed": False, "message": _fmt_exc(e)})
    return out

try:
    _result = _run()
except Exception as e:  # noqa: BLE001
    _result = {"tests": [], "error": _fmt_exc(e)}

json.dumps(_result)
`.trim();

/** Everything the worker needs to execute one run. */
export interface RunPayload extends RunRequest {
  setup: string;
  testsJson: string;
  harness: string;
}

/**
 * Build the worker payload from a problem's test suite + the user's code.
 * `testCode` is retained on the payload for the RunRequest contract but the
 * worker drives execution off `testsJson`/`harness`.
 */
export function buildRunPayload(suite: TestSuite, userCode: string): RunPayload {
  const testsJson = JSON.stringify(suite.cases ?? []);
  return {
    userCode,
    testCode: HARNESS,
    setup: suite.setup ?? "",
    testsJson,
    harness: HARNESS,
  };
}
