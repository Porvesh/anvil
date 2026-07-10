"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { RunRecord, RunResult } from "@/lib/types";
import { getRunner } from "@/lib/pyodide/runner";
import styles from "./DebugPane.module.css";

// Monaco loads client-side only (it pulls its worker assets in the browser).
const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

/** Forge-palette Monaco theme so the editor matches the rest of the app. */
const FORGE_THEME = {
  base: "vs-dark" as const,
  inherit: true,
  rules: [
    { token: "keyword", foreground: "c98fe0" },
    { token: "string", foreground: "9ccf7a" },
    { token: "string.escape", foreground: "9ccf7a" },
    { token: "number", foreground: "e8b53d" },
    { token: "comment", foreground: "5c6472", fontStyle: "italic" },
    { token: "type", foreground: "6cb6e8" },
    { token: "function", foreground: "6cb6e8" },
  ],
  colors: {
    "editor.background": "#14161a",
    "editor.foreground": "#e9e7e2",
    "editor.lineHighlightBackground": "#1b1e24",
    "editorLineNumber.foreground": "#454b56",
    "editorLineNumber.activeForeground": "#8a93a3",
    "editor.selectionBackground": "#31363f",
    "editorCursor.foreground": "#ff7a3c",
    "editorIndentGuide.background1": "#22262e",
    "editorWidget.background": "#1b1e24",
  },
};

/**
 * Debug work surface (spec §6): Monaco editor + Run + a tests/console panel.
 * Editor-centric. Also owns the small quality-of-life layer: the forge theme,
 * a Python-engine boot indicator, ⌘↵ to run, and the run-history strip that
 * shows iteration progress (which also feeds approach grading).
 */
export function DebugPane({
  code,
  onCodeChange,
  onRun,
  running,
  result,
  runs,
  filename = "solution.py",
}: {
  code: string;
  onCodeChange: (value: string) => void;
  onRun: () => void;
  running: boolean;
  result: RunResult | null;
  runs: RunRecord[];
  filename?: string;
}) {
  const [tab, setTab] = useState<"tests" | "console">("tests");
  const [engineReady, setEngineReady] = useState(false);

  // Keep a live ref so the Monaco keybinding always triggers the latest run.
  const runRef = useRef(onRun);
  runRef.current = onRun;

  // Warm Pyodide as soon as the pane mounts; flip the chip when it's hot.
  useEffect(() => {
    let alive = true;
    getRunner()
      .preload()
      .then(() => alive && setEngineReady(true))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className={styles.pane}>
      <div className={styles.edtop}>
        <span className={styles.filetab}>{filename}</span>
        <span className={styles.engine} title="Python runs entirely in your browser (Pyodide/WebAssembly) — nothing is sent to a server">
          <span className={`${styles.engineDot} ${engineReady ? styles.ready : ""}`} />
          {engineReady ? "python ready · in-browser" : "warming python engine…"}
        </span>
        <div className={styles.grow} />
        <span className={styles.kbd}>⌘↵</span>
        <button className={`${styles.run} ${running ? styles.running : ""}`} onClick={onRun} disabled={running}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M8 5v14l11-7z" />
          </svg>
          {running ? "Running…" : "Run tests"}
        </button>
      </div>

      <div className={styles.editor}>
        <MonacoEditor
          height="100%"
          language="python"
          theme="anvil-forge"
          value={code}
          onChange={(v) => onCodeChange(v ?? "")}
          beforeMount={(monaco) => {
            monaco.editor.defineTheme("anvil-forge", FORGE_THEME);
          }}
          onMount={(editor, monaco) => {
            // ⌘/Ctrl+Enter runs the suite without leaving the keyboard.
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());
          }}
          options={{
            fontSize: 13.5,
            fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
            fontLigatures: false,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            padding: { top: 12 },
            tabSize: 4,
            renderLineHighlight: "all",
            smoothScrolling: true,
            cursorBlinking: "smooth",
          }}
        />
      </div>

      <div className={styles.runpanel}>
        <div className={styles.runtabs}>
          <button className={tab === "tests" ? styles.on : ""} onClick={() => setTab("tests")}>
            Tests
          </button>
          <button className={tab === "console" ? styles.on : ""} onClick={() => setTab("console")}>
            Console
          </button>
          {runs.length > 0 && (
            <div className={styles.history}>
              <span className={styles.historyLabel}>runs</span>
              {runs.slice(-6).map((r, i) => (
                <span
                  key={i}
                  className={`${styles.runChip} ${r.failed === 0 && r.passed > 0 ? styles.runChipPass : styles.runChipFail}`}
                  title={`Run ${runs.length - Math.min(runs.length, 6) + i + 1}: ${r.passed} passed, ${r.failed} failed`}
                >
                  {r.passed}/{r.passed + r.failed}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className={styles.runbody}>
          {tab === "tests" ? <Tests result={running ? null : result} running={running} engineReady={engineReady} /> : <Console result={result} />}
        </div>
      </div>
    </div>
  );
}

function Tests({ result, running, engineReady }: { result: RunResult | null; running: boolean; engineReady: boolean }) {
  if (running)
    return <div className={styles.muted}>{engineReady ? "Executing test suite in your browser…" : "Booting the Python engine (first run only, ~10s), then executing…"}</div>;
  if (!result)
    return (
      <div className={styles.muted}>
        Press <span style={{ color: "var(--spark)" }}>Run tests</span> (or ⌘↵) to execute the suite — it runs entirely in your browser via
        WebAssembly. Iterate until everything is green, then submit.
      </div>
    );

  if (result.timedOut) return <div className={`${styles.summary} ${styles.summaryFail}`}>{result.error} That timeout is a clue — is something looping forever?</div>;
  if (result.error) return <div className={`${styles.summary} ${styles.summaryFail}`}>Error: {result.error}</div>;

  const passed = result.tests.filter((t) => t.passed).length;
  const total = result.tests.length;
  const allPass = total > 0 && passed === total;

  return (
    <>
      <div className={`${styles.summary} ${allPass ? styles.summaryPass : styles.summaryFail}`}>
        <span>
          {passed}/{total} tests passing{allPass ? " — all green. Submit when you're confident it's the root cause." : ""}
        </span>
        <span className={styles.bar}>
          <span className={styles.barFill} style={{ width: `${total ? (passed / total) * 100 : 0}%` }} />
        </span>
      </div>
      {result.tests.map((t) => (
        <div key={t.name}>
          <div className={`${styles.tcase} ${t.passed ? styles.pass : styles.fail}`}>
            <span className={styles.st}>{t.passed ? "✓ PASS" : "✗ FAIL"}</span>
            <span className={styles.nm}>{t.name}</span>
          </div>
          {!t.passed && t.message && <div className={styles.assert}>{t.message}</div>}
        </div>
      ))}
    </>
  );
}

function Console({ result }: { result: RunResult | null }) {
  if (!result || !result.output) return <div className={styles.muted}>No output yet — print() from your code shows up here.</div>;
  return <>{result.output}</>;
}
