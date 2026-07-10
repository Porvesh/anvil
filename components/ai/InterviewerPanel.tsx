"use client";

import { useEffect, useRef, useState, Fragment } from "react";
import type { ChatMessage } from "@/lib/types";
import styles from "./InterviewerPanel.module.css";

/** Render `backtick` spans as <code>. Keeps interviewer text readable. */
function formatContent(text: string) {
  return text.split(/(`[^`]+`)/g).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") ? (
      <code key={i}>{part.slice(1, -1)}</code>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

/**
 * The persistent AI interviewer panel (spec §6) — first-class, shared across
 * modes. Presentational: the parent owns the transcript and streaming; this
 * renders it and emits `onSend`. During solving it carries hints; on the
 * results screen it carries the Socratic follow-up. Shows a typing indicator
 * while a reply streams and quick-suggestion chips to lower the ask barrier.
 */
export function InterviewerPanel({
  role,
  messages,
  onSend,
  busy,
  footer,
  suggestions = [],
  placeholder = "Ask the interviewer…",
}: {
  role: string;
  messages: ChatMessage[];
  onSend: (text: string) => void;
  busy: boolean;
  footer: string;
  suggestions?: string[];
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const chatRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the newest content as it streams in.
  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  function submit(text?: string) {
    const body = (text ?? draft).trim();
    if (!body || busy) return;
    setDraft("");
    onSend(body);
  }

  // The typing indicator shows while a reply is pending but hasn't produced
  // text yet (the last streaming bubble renders the tokens once they arrive).
  const lastMsg = messages[messages.length - 1];
  const showTyping = busy && (!lastMsg || lastMsg.role !== "interviewer" || lastMsg.content === "");

  return (
    <div className={styles.ai}>
      <div className={styles.head}>
        <div className={styles.av}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="#180b03" aria-hidden>
            <path d="M13 2L4 14h6l-1 8 9-12h-6z" />
          </svg>
        </div>
        <div>
          <div className={styles.nm}>Interviewer</div>
          <div className={styles.rl}>{role}</div>
        </div>
      </div>

      <div className={styles.chat} ref={chatRef}>
        {messages
          .filter((m) => !(busy && m === lastMsg && m.role === "interviewer" && m.content === ""))
          .map((m, i) => (
            <div key={i} className={`${styles.msg} ${m.role === "interviewer" ? styles.ai : styles.me}`}>
              {m.role === "interviewer" && <div className={styles.lbl}>Interviewer</div>}
              <div className={styles.bub}>{formatContent(m.content)}</div>
            </div>
          ))}
        {showTyping && (
          <div className={styles.typing} aria-label="Interviewer is typing">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>

      {suggestions.length > 0 && (
        <div className={styles.suggestions}>
          {suggestions.map((s) => (
            <button key={s} className={styles.suggestion} onClick={() => submit(s)} disabled={busy}>
              {s}
            </button>
          ))}
        </div>
      )}

      <div className={styles.chatbox}>
        <div className={styles.inrow}>
          <textarea
            value={draft}
            placeholder={placeholder}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button className={styles.send} onClick={() => submit()} disabled={busy} aria-label="Send">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />
            </svg>
          </button>
        </div>
        <div className={styles.hint}>{footer}</div>
      </div>
    </div>
  );
}
