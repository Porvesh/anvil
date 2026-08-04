"use client";

import { useEffect, useRef, type ReactNode } from "react";
import styles from "./Dialog.module.css";

/**
 * The app's one modal.
 *
 * Owns the behaviour that is easy to get subtly wrong and pointless to write
 * twice: Escape closes, a backdrop click closes but a drag out of the panel does
 * not, the first field takes focus on open, and a busy dialog refuses to close
 * so a request can't be abandoned halfway.
 *
 * Presentational beyond that — callers own their own content and state.
 */
export function Dialog({
  title,
  subtitle,
  icon,
  busy = false,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  icon: ReactNode;
  /** While true, Escape and backdrop clicks are ignored. */
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const titleId = `dialog-${title.replace(/\W+/g, "-").toLowerCase()}`;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    // Focus the first real control so the dialog is usable from the keyboard
    // immediately. Deferred a tick: the panel is not laid out on this frame.
    const focusTimer = window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLElement>("input, textarea, button:not([aria-label='Close'])")?.focus();
    }, 0);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [busy, onClose]);

  return (
    <div
      className={styles.backdrop}
      // mousedown on the backdrop itself, so releasing a text selection that
      // started inside the panel doesn't dismiss it.
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}
    >
      <section ref={panelRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className={styles.head}>
          <div className={styles.mark}>{icon}</div>
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className={styles.close} onClick={onClose} disabled={busy} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

/** Shared content pieces, so callers don't reach into the stylesheet by hand. */
export const dialogStyles = styles;
