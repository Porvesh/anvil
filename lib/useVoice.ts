"use client";

/**
 * Browser-native voice I/O for the interviewer — speech-to-text (dictate a
 * question) and text-to-speech (hear the reply). Uses the Web Speech API, so
 * it's zero-infra and on-device, matching Anvil's "browser is the compute
 * layer" model. Especially useful for system design, where thinking out loud
 * *is* the skill: talk through your design and the interviewer talks back.
 *
 * Web Speech types aren't in the TS DOM lib (SpeechRecognition is vendor-
 * prefixed), so recognition is accessed loosely; TTS uses the typed API.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/* eslint-disable @typescript-eslint/no-explicit-any */
export function useVoice() {
  const [support, setSupport] = useState({ stt: false, tts: false });
  const [listening, setListening] = useState(false);
  const recRef = useRef<any>(null);

  useEffect(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const supportTimer = window.setTimeout(() => {
      setSupport({ stt: !!SR, tts: !!window.speechSynthesis });
    }, 0);
    // Stop any in-flight speech/recognition if the panel unmounts.
    return () => {
      window.clearTimeout(supportTimer);
      recRef.current?.stop?.();
      window.speechSynthesis?.cancel();
    };
  }, []);

  /** Start dictation. `onInterim` gets the live transcript; `onFinal` fires once
   *  recognition ends with the finalized text (empty string if nothing heard). */
  const start = useCallback((onInterim: (t: string) => void, onFinal: (t: string) => void) => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR || recRef.current) return;
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = "";
    rec.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interim += t;
      }
      onInterim((finalText + interim).trim());
    };
    rec.onend = () => {
      recRef.current = null;
      setListening(false);
      onFinal(finalText.trim());
    };
    rec.onerror = () => {
      recRef.current = null;
      setListening(false);
    };
    recRef.current = rec;
    setListening(true);
    rec.start();
  }, []);

  const stop = useCallback(() => recRef.current?.stop?.(), []);

  const speak = useCallback((text: string) => {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }, []);

  const cancelSpeak = useCallback(() => window.speechSynthesis?.cancel(), []);

  return { support, listening, start, stop, speak, cancelSpeak };
}
