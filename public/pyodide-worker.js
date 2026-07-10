/*
 * Pyodide Web Worker (spec §9). Intentionally dumb: it loads the pinned Pyodide
 * runtime from the CDN, then executes whatever harness the main thread sends.
 * All Python logic lives in lib/pyodide/harness.ts so there is one source of
 * truth; this file only wires stdin/stdout and the message protocol.
 *
 * Protocol (see lib/pyodide/runner.ts):
 *   in : { type: "boot" }                                  -> { type: "ready" }
 *   in : { type: "run", userCode, setup, testsJson, harness } -> { type: "result", result }
 *
 * The runtime is ~15MB, lazily loaded once and then browser-cached from the CDN.
 */

// Pin the version so a CDN bump can't silently change execution semantics.
const PYODIDE_VERSION = "0.28.0";
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

importScripts(`${PYODIDE_BASE}pyodide.js`);

let pyodidePromise = null;

function loadOnce() {
  // `loadPyodide` is provided by the imported script.
  if (!pyodidePromise) {
    // eslint-disable-next-line no-undef
    pyodidePromise = loadPyodide({ indexURL: PYODIDE_BASE });
  }
  return pyodidePromise;
}

self.onmessage = async (event) => {
  const msg = event.data || {};

  if (msg.type === "boot") {
    // Warm the runtime so the execution timeout later covers only the user's
    // code, not the one-time WASM initialization.
    await loadOnce();
    self.postMessage({ type: "ready" });
    return;
  }

  if (msg.type === "run") {
    let output = "";
    try {
      const pyodide = await loadOnce();
      pyodide.setStdout({ batched: (s) => { output += s + "\n"; } });
      pyodide.setStderr({ batched: (s) => { output += s + "\n"; } });

      pyodide.globals.set("USER_CODE", msg.userCode ?? "");
      pyodide.globals.set("SETUP_CODE", msg.setup ?? "");
      pyodide.globals.set("TESTS_JSON", msg.testsJson ?? "[]");

      const resultJson = pyodide.runPython(msg.harness);
      const parsed = JSON.parse(resultJson);

      self.postMessage({
        type: "result",
        result: {
          ok: !parsed.error,
          output,
          tests: parsed.tests || [],
          error: parsed.error || undefined,
        },
      });
    } catch (err) {
      // Reaching here means the harness itself failed (should be rare) — surface
      // it rather than hanging the UI.
      self.postMessage({
        type: "result",
        result: {
          ok: false,
          output,
          tests: [],
          error: err && err.message ? err.message : String(err),
        },
      });
    }
  }
};
