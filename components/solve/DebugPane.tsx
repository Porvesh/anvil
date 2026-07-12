"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import type { RunResult } from "@/lib/types";
import styles from "./DebugPane.module.css";

// Monaco loads client-side only (it pulls its worker assets in the browser).
const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

/**
 * Debug work surface (spec §6): Monaco editor + Run + a tests/console panel.
 * Editor-centric. Running happens in the Pyodide worker (owned by the parent),
 * so this component just renders the editor, the run button, and results.
 */
export function DebugPane({
  code,
  onCodeChange,
  onRun,
  running,
  result,
  filename = "solution.py",
}: {
  code: string;
  onCodeChange: (value: string) => void;
  onRun: () => void;
  running: boolean;
  result: RunResult | null;
  filename?: string;
}) {
  const [tab, setTab] = useState<"tests" | "console">("tests");

  return (
    <div className={styles.pane}>
      <div className={styles.edtop}>
        <span className={styles.filetab}>{filename}</span>
        <div className={styles.grow} />
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
          theme="vs-dark"
          value={code}
          onChange={(v) => onCodeChange(v ?? "")}
          options={{
            fontSize: 13,
            fontFamily: "var(--mono)",
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            padding: { top: 10 },
            tabSize: 4,
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
        </div>
        <div className={styles.runbody}>{tab === "tests" ? <Tests result={running ? null : result} running={running} /> : <Console result={result} />}</div>
      </div>
    </div>
  );
}

function Tests({ result, running }: { result: RunResult | null; running: boolean }) {
  if (running) return <div className={styles.muted}>Booting Pyodide, executing tests…</div>;
  if (!result)
    return (
      <div className={styles.muted}>
        Press <span style={{ color: "var(--spark)" }}>Run tests</span> to execute in-browser (Pyodide).
      </div>
    );

  if (result.timedOut) return <div className={`${styles.banner} ${styles.bannerFail}`}>{result.error}</div>;
  if (result.error) return <div className={`${styles.banner} ${styles.bannerFail}`}>Error: {result.error}</div>;

  const passed = result.tests.filter((t) => t.passed).length;
  const allPass = result.tests.length > 0 && passed === result.tests.length;

  return (
    <>
      <div className={`${styles.banner} ${allPass ? styles.bannerPass : styles.bannerFail}`}>
        {passed}/{result.tests.length} tests passing{allPass ? " — nice, all green." : ""}
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
  if (!result || !result.output) return <div className={styles.muted}>No output yet.</div>;
  return <>{result.output}</>;
}
