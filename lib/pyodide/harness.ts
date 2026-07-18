/**
 * The Pyodide test harness — the single source of truth for how a debug problem
 * is executed. All Python logic lives here (not in the worker) so it can be unit
 * tested and there is exactly one place that defines the execution contract.
 *
 * Multi-file execution model (real projects, not one script):
 *   1. Every file in FILES_JSON is written to a project root on the virtual FS.
 *   2. The root is put on sys.path, and any modules imported from it on a prior
 *      run are purged so edits actually take effect on re-run (the worker is warm).
 *   3. `setup` runs (typically `from pkg.mod import Thing`, plus fixtures).
 *   4. each test runs in a shallow copy of the shared namespace so cases can't
 *      clobber each other; an AssertionError = fail, clean = pass.
 *
 * Data crosses the JS→Python boundary via Pyodide globals (set by the worker),
 * never by string interpolation — so file contents with quotes/backslashes can
 * never break the harness.
 */
import type { RunRequest, SolutionFile, TestSuite } from "../types";

const PROJECT_ROOT = "/anvil_project";

/**
 * Fixed Python program executed by the worker. Reads FILES_JSON, SETUP_CODE, and
 * TESTS_JSON from its globals and returns a JSON string:
 *   { "tests": [{ "name", "passed", "message"? }], "error": <str|null> }
 */
export const HARNESS = `
import json, os, sys, shutil, importlib, traceback

ROOT = ${JSON.stringify(PROJECT_ROOT)}

def _fmt_exc(e):
    return "".join(traceback.format_exception_only(type(e), e)).strip()

def _write_project():
    # Rewrite the whole tree each run so deleted/renamed files don't linger.
    if os.path.isdir(ROOT):
        shutil.rmtree(ROOT)
    os.makedirs(ROOT, exist_ok=True)
    for f in json.loads(FILES_JSON):
        full = os.path.join(ROOT, f["path"])
        os.makedirs(os.path.dirname(full) or ROOT, exist_ok=True)
        with open(full, "w") as fh:
            fh.write(f["content"])
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)

def _purge_modules():
    # Drop modules imported from ROOT on a previous run so this run sees edits.
    for name in list(sys.modules):
        mod = sys.modules.get(name)
        path = getattr(mod, "__file__", None)
        if path and path.startswith(ROOT):
            del sys.modules[name]
    importlib.invalidate_caches()

def _run():
    out = {"tests": [], "error": None}
    _purge_modules()
    _write_project()
    ns = {}
    # setup imports the project + defines fixtures; an import/syntax error in the
    # user's files surfaces here as a top-level error, not a per-test failure.
    if SETUP_CODE:
        exec(SETUP_CODE, ns)
    for case in json.loads(TESTS_JSON):
        try:
            exec(case["body"], dict(ns))
            out["tests"].append({"name": case["name"], "passed": True})
        except AssertionError as e:
            out["tests"].append({"name": case["name"], "passed": False, "message": str(e) or "assertion failed"})
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
  filesJson: string;
  harness: string;
}

/**
 * Build the worker payload from a problem's test suite + the user's project
 * files. `userCode`/`testCode` are retained for the RunRequest contract; the
 * worker drives execution off `filesJson`/`testsJson`/`harness`.
 */
export function buildRunPayload(suite: TestSuite, files: SolutionFile[]): RunPayload {
  return {
    userCode: "", // legacy field — files carry the code now
    testCode: HARNESS,
    setup: suite.setup ?? "",
    testsJson: JSON.stringify(suite.cases ?? []),
    filesJson: JSON.stringify(files.map((f) => ({ path: f.path, content: f.content }))),
    harness: HARNESS,
  };
}
