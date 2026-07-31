"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Logo } from "./Logo";
import { IconKey, IconLock } from "@/lib/icons";
import { BYOK_REQUIRED_EVENT } from "@/lib/byokClient";
import styles from "./TopBar.module.css";

/**
 * Every entry here resolves to a real page. They used to all point at `/`, which
 * made the nav read as three links that silently did nothing.
 *
 * `exact` matters for Practice: `/` is a prefix of every route, so a
 * startsWith test would light it up on all of them.
 */
const NAV = [
  { href: "/", label: "Practice", exact: true },
  { href: "/bank", label: "Problem bank" },
  { href: "/history", label: "History" },
];

type AiProvider = "anthropic" | "openai";

const PROVIDERS: Record<AiProvider, { label: string; placeholder: string; keyUrl: string }> = {
  anthropic: {
    label: "Anthropic",
    placeholder: "sk-ant-...",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  openai: {
    label: "OpenAI",
    placeholder: "sk-...",
    keyUrl: "https://platform.openai.com/api-keys",
  },
};

/** Constant app chrome (spec §6). Present on every view. */
export function TopBar() {
  const pathname = usePathname();
  const [connected, setConnected] = useState<boolean | null>(null);
  const [provider, setProvider] = useState<AiProvider>("anthropic");
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function closeDialog() {
    if (busy) return;
    setOpen(false);
    setApiKey("");
    setShowKey(false);
    setError(null);
  }

  useEffect(() => {
    void fetch("/api/byok", { cache: "no-store" })
      .then((response) => response.json())
      .then((status) => {
        setConnected(Boolean(status.connected));
        if (status.provider === "anthropic" || status.provider === "openai") setProvider(status.provider);
      })
      .catch(() => setConnected(false));
  }, []);

  useEffect(() => {
    const requireKey = () => {
      setConnected(false);
      setError(null);
      setOpen(true);
    };
    window.addEventListener(BYOK_REQUIRED_EVENT, requireKey);
    return () => window.removeEventListener(BYOK_REQUIRED_EVENT, requireKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDialog();
    };
    window.addEventListener("keydown", onKeyDown);
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [busy, open]);

  async function connect(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/byok", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error ?? "Could not connect this key.");
      setApiKey("");
      setShowKey(false);
      setConnected(true);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect this key.");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/byok", { method: "DELETE" });
      if (!response.ok) throw new Error("Could not remove the key.");
      setConnected(false);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove the key.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <header className={styles.topbar}>
      <Link href="/" className={styles.brand}>
        <Logo />
        <b>Anvil</b>
      </Link>
      <div className={styles.grow} />
      <nav className={styles.nav}>
        {NAV.map(({ href, label, exact }) => {
          // A solve page is reached from the bank, so keep that entry lit while
          // the user is inside a problem rather than showing no location at all.
          const active = exact
            ? pathname === href
            : pathname.startsWith(href) || (href === "/bank" && pathname.startsWith("/solve"));
          return (
            <Link key={href} href={href} className={active ? styles.active : ""} aria-current={active ? "page" : undefined}>
              {label}
            </Link>
          );
        })}
      </nav>
      <button
        className={`${styles.keyButton} ${connected ? styles.keyConnected : ""}`}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        aria-label={connected ? `${PROVIDERS[provider].label} API key connected` : "Connect an AI provider key"}
      >
        <IconKey />
        <span className={styles.keyLabel}>{connected ? "Key connected" : "Connect key"}</span>
        <span className={styles.keyDot} aria-hidden="true" />
      </button>

      {open && (
        <div
          className={styles.backdrop}
          onMouseDown={(event) => event.target === event.currentTarget && closeDialog()}
        >
          <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="byok-title">
            <div className={styles.dialogHead}>
              <div className={styles.keyMark}><IconKey size={18} /></div>
              <div>
                <h2 id="byok-title">Connect an AI provider</h2>
                <p>{connected ? "This browser is ready for AI grading." : "Use your own API billing for AI features."}</p>
              </div>
              <button className={styles.close} onClick={closeDialog} disabled={busy} aria-label="Close">×</button>
            </div>

            {connected ? (
              <div className={styles.connectedPanel}>
                <span className={styles.connectedDot} />
                <div><strong>{PROVIDERS[provider].label} connected</strong><span>Session expires automatically after 8 hours.</span></div>
              </div>
            ) : (
              <form onSubmit={connect}>
                <div className={styles.providerPicker} role="group" aria-label="AI provider">
                  {(Object.keys(PROVIDERS) as AiProvider[]).map((id) => (
                    <button
                      key={id}
                      type="button"
                      className={provider === id ? styles.providerActive : ""}
                      aria-pressed={provider === id}
                      onClick={() => {
                        setProvider(id);
                        setApiKey("");
                        setError(null);
                      }}
                      disabled={busy}
                    >
                      {PROVIDERS[id].label}
                    </button>
                  ))}
                </div>
                <label htmlFor="provider-key">{PROVIDERS[provider].label} API key</label>
                <input
                  ref={inputRef}
                  id="provider-key"
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={PROVIDERS[provider].placeholder}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
                <label className={styles.showKey}>
                  <input type="checkbox" checked={showKey} onChange={(event) => setShowKey(event.target.checked)} />
                  Show key
                </label>
                {error && <p className={styles.keyError} role="alert">{error}</p>}
                <button className="btn-primary" type="submit" disabled={busy || apiKey.trim().length < 24}>
                  {busy ? "Verifying…" : "Connect key"}
                </button>
              </form>
            )}

            {connected && error && <p className={styles.keyError} role="alert">{error}</p>}
            <div className={styles.securityPanel} aria-label="API key security">
              <div className={styles.securityTitle}><IconLock size={14} /><strong>How your key is protected</strong></div>
              <ul>
                <li><strong>Encrypted:</strong> Sealed with AES-256-GCM before the browser stores the session cookie.</li>
                <li><strong>Not saved:</strong> Never written to Anvil&rsquo;s database, localStorage, sessionStorage, or app logs.</li>
                <li><strong>Browser-isolated:</strong> The HttpOnly cookie cannot be read by page JavaScript and is Secure on HTTPS.</li>
                <li><strong>Short-lived:</strong> Used only with your selected provider and removed automatically after eight hours.</li>
              </ul>
            </div>
            <div className={styles.securityActions}>
              <span>You can remove access at any time.</span>
              {connected ? (
                <button onClick={disconnect} disabled={busy}>{busy ? "Removing…" : "Remove key"}</button>
              ) : (
                <a href={PROVIDERS[provider].keyUrl} target="_blank" rel="noreferrer">Create a key ↗</a>
              )}
            </div>
          </section>
        </div>
      )}
    </header>
  );
}
