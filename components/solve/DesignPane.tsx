"use client";

import dynamic from "next/dynamic";
import styles from "./DesignPane.module.css";

// Monaco loads client-side only (it pulls its worker assets in the browser).
const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

/** Same forge palette as the debug editor so the app reads as one surface. */
const FORGE_THEME = {
  base: "vs-dark" as const,
  inherit: true,
  rules: [
    { token: "keyword", foreground: "c98fe0" },
    { token: "string", foreground: "9ccf7a" },
    { token: "number", foreground: "e8b53d" },
    { token: "comment", foreground: "5c6472", fontStyle: "italic" },
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

const CHECKPOINTS = ["requirements & scale assumptions", "API / data model", "core architecture", "failure modes", "trade-offs you rejected"];

/**
 * Design work surface: a markdown design doc the candidate writes while the
 * interviewer panel probes alongside. The starter doc seeds section headings so
 * the exercise trains structure, not blank-page paralysis. Submitting grades
 * the doc against a seeded rubric — same engine as debug/review.
 */
export function DesignPane({ doc, onDocChange }: { doc: string; onDocChange: (value: string) => void }) {
  const words = doc.trim() === "" ? 0 : doc.trim().split(/\s+/).length;

  return (
    <div className={styles.pane}>
      <div className={styles.top}>
        <span className={styles.filetab}>design.md</span>
        <span className={styles.meta}>{words} words</span>
        <div className={styles.grow} />
        <span className={styles.nudge}>graded on substance — numbers, mechanisms, trade-offs</span>
      </div>

      <div className={styles.editor}>
        <MonacoEditor
          height="100%"
          language="markdown"
          theme="anvil-forge"
          value={doc}
          onChange={(v) => onDocChange(v ?? "")}
          beforeMount={(monaco) => {
            monaco.editor.defineTheme("anvil-forge", FORGE_THEME);
          }}
          options={{
            fontSize: 13.5,
            fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
            fontLigatures: false,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            padding: { top: 12 },
            wordWrap: "on",
            lineNumbers: "off",
            renderLineHighlight: "none",
            smoothScrolling: true,
            cursorBlinking: "smooth",
            quickSuggestions: false,
          }}
        />
      </div>

      <div className={styles.footer}>
        <span className={styles.footerLabel}>a strong doc covers</span>
        {CHECKPOINTS.map((c) => (
          <span key={c} className={styles.check}>
            {c}
          </span>
        ))}
      </div>
    </div>
  );
}
