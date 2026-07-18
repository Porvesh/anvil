/**
 * Main-thread wrapper around the Pyodide worker. Owns the warm-worker lifecycle:
 *
 *  - Keeps ONE worker alive so the ~15MB runtime stays hot between runs (fast
 *    iteration while debugging).
 *  - Applies the watchdog timeout only to *execution* (boot is awaited first),
 *    so a slow first load isn't mistaken for an infinite loop.
 *  - On timeout, `terminate()`s the worker and drops the reference so the next
 *    run spins up a fresh one — this is how a runaway loop actually gets killed
 *    (spec §9). A timeout is itself a signal: the infinite loop may be the bug.
 *
 * Browser-only (uses `Worker`). Import lazily from client components.
 */
import type { RunResult, SolutionFile, TestSuite } from "../types";
import { buildRunPayload } from "./harness";

const DEFAULT_TIMEOUT_MS = 5000;
const WORKER_URL = "/pyodide-worker.js";

function timedOutResult(): RunResult {
  return {
    ok: false,
    output: "",
    tests: [],
    error: "Execution timed out after 5s — likely an infinite loop.",
    timedOut: true,
  };
}

export class PyodideRunner {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;

  /** Create the worker (if needed) and begin loading Pyodide. */
  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const worker = new Worker(WORKER_URL);
    this.worker = worker;
    this.ready = new Promise<void>((resolve, reject) => {
      const onReady = (e: MessageEvent) => {
        if (e.data?.type === "ready") {
          worker.removeEventListener("message", onReady);
          resolve();
        }
      };
      worker.addEventListener("message", onReady);
      worker.addEventListener("error", (e) => reject(e.error ?? new Error(e.message)), { once: true });
    });
    worker.postMessage({ type: "boot" });
    return worker;
  }

  /** Kick off Pyodide loading ahead of the first run (e.g. on editor mount).
   *  Resolves when the runtime is warm — lets the UI show a boot indicator. */
  preload(): Promise<void> {
    this.ensureWorker();
    return this.ready ?? Promise.resolve();
  }

  /** Run the user's code against a test suite; resolves (never rejects). */
  async run(
    files: SolutionFile[],
    suite: TestSuite,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<RunResult> {
    const worker = this.ensureWorker();
    try {
      await this.ready;
    } catch (err) {
      this.dispose();
      return { ok: false, output: "", tests: [], error: `Failed to load Pyodide: ${String(err)}` };
    }

    const payload = { type: "run" as const, ...buildRunPayload(suite, files) };

    return new Promise<RunResult>((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        // Hard-kill the worker so the runaway loop stops; force a fresh one next run.
        this.dispose();
        resolve(timedOutResult());
      }, timeoutMs);

      const onMessage = (e: MessageEvent) => {
        if (e.data?.type !== "result") return;
        cleanup();
        resolve(e.data.result as RunResult);
      };
      const onError = (e: ErrorEvent) => {
        cleanup();
        this.dispose();
        resolve({ ok: false, output: "", tests: [], error: e.message || "Worker crashed" });
      };
      const cleanup = () => {
        clearTimeout(timer);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
      };

      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.postMessage(payload);
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
  }
}

/**
 * App-wide singleton — one warm runtime shared across the solve session.
 * Exported as a getter so it's only constructed in the browser.
 */
let singleton: PyodideRunner | null = null;
export function getRunner(): PyodideRunner {
  if (!singleton) singleton = new PyodideRunner();
  return singleton;
}
