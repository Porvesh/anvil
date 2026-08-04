"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/types";
import { useVoice } from "@/lib/useVoice";
import { renderInline } from "@/lib/richText";
import { IconMic, IconSpeaker, IconSpeakerOff } from "@/lib/icons";
import styles from "./InterviewerPanel.module.css";

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
  className,
  readOnly = false,
}: {
  role: string;
  messages: ChatMessage[];
  onSend: (text: string) => void;
  busy: boolean;
  footer: string;
  suggestions?: string[];
  placeholder?: string;
  className?: string;
  /**
   * Render the transcript without a composer. Used by the recorded demo, where
   * the conversation already happened and an input box would promise a reply
   * that cannot come — the viewer has no API key connected.
   */
  readOnly?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const chatRef = useRef<HTMLDivElement>(null);

  // --- voice: dictate a question (STT) + hear replies (TTS) ---
  const voice = useVoice();
  const [speakReplies, setSpeakReplies] = useState(false);
  const lastSpokenRef = useRef("");

  // Speak each finished interviewer reply aloud when TTS is on.
  useEffect(() => {
    if (!speakReplies || busy) return;
    const last = messages[messages.length - 1];
    if (last?.role === "interviewer" && last.content && last.content !== lastSpokenRef.current) {
      lastSpokenRef.current = last.content;
      voice.speak(last.content.replace(/`/g, "")); // read code identifiers plainly
    }
  }, [messages, busy, speakReplies, voice]);

  // Turning speech off silences anything mid-utterance.
  useEffect(() => {
    if (!speakReplies) voice.cancelSpeak();
  }, [speakReplies, voice]);

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

  function toggleMic() {
    if (busy) return;
    if (voice.listening) {
      voice.stop();
      return;
    }
    // Live transcript fills the box; when you stop talking it sends hands-free.
    voice.start(
      (t) => setDraft(t),
      (final) => {
        if (final) {
          setDraft("");
          onSend(final);
        }
      },
    );
  }

  // The typing indicator shows while a reply is pending but hasn't produced
  // text yet (the last streaming bubble renders the tokens once they arrive).
  const lastMsg = messages[messages.length - 1];
  const showTyping = busy && (!lastMsg || lastMsg.role !== "interviewer" || lastMsg.content === "");

  return (
    <div className={`${styles.ai} ${className ?? ""}`}>
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
              <div className={styles.bub}>{renderInline(m.content)}</div>
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

      {readOnly ? (
        <div className={styles.chatbox}>
          <div className={styles.hint}>{footer}</div>
        </div>
      ) : (
        <>
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
          {voice.support.tts && (
            <button
              className={`${styles.voicebtn} ${speakReplies ? styles.voiceOn : ""}`}
              onClick={() => setSpeakReplies((s) => !s)}
              title={speakReplies ? "Interviewer voice on — click to mute" : "Hear the interviewer's replies aloud"}
              aria-label="Toggle interviewer voice"
            >
              {speakReplies ? <IconSpeaker /> : <IconSpeakerOff />}
            </button>
          )}
          {voice.support.stt && (
            <button
              className={`${styles.voicebtn} ${voice.listening ? styles.listening : ""}`}
              onClick={toggleMic}
              disabled={busy}
              title={voice.listening ? "Listening… click to stop" : "Talk to the interviewer"}
              aria-label="Dictate a question"
            >
              <IconMic />
              {voice.listening && <span className={styles.listenRing} aria-hidden />}
            </button>
          )}
          <textarea
            value={draft}
            placeholder={voice.listening ? "Listening…" : placeholder}
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
        <div className={styles.hint}>{voice.listening ? "Speak now — I'll send when you pause." : footer}</div>
      </div>
        </>
      )}
    </div>
  );
}
