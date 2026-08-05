"use client";

import { type FormEvent, useState } from "react";
import { requestSignInLink, type LinkRequested } from "@/lib/authClient";
import { dialogStyles } from "@/components/shell/Dialog";
import styles from "./SignInForm.module.css";

type Phase = "idle" | "sending" | "sent";

/**
 * Ask for a sign-in link.
 *
 * Deliberately the whole of sign-in: there is no password to choose and no
 * account to create first, so the form is one field and the success state is
 * "go read your email". Shared by the top-bar dialog and the /signin page so
 * both describe the flow identically.
 */
export function SignInForm({
  available,
  onBusyChange,
}: {
  /** Null while the parent is still reading session state. */
  available: boolean | null;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<LinkRequested | null>(null);

  // Hold the space rather than flashing a form that is about to be replaced.
  if (available === null) return <p className={styles.pending} aria-hidden />;

  if (!available) {
    // No mail transport is configured, so a link would go to a server log the
    // visitor cannot read. Offering the form anyway would be asking for an
    // address in exchange for nothing.
    return (
      <>
        <div className={styles.soon}>
          <strong>Coming soon</strong>
          <span>
            Accounts aren&rsquo;t switched on yet. Anvil works fully without one — your attempts, ratings and drafts are
            already saved in this browser.
          </span>
        </div>
        <div className={dialogStyles.actions}>
          <span>Nothing is lost in the meantime: this browser&rsquo;s work is adopted when sign-in opens.</span>
        </div>
      </>
    );
  }

  function setBusy(busy: boolean) {
    onBusyChange?.(busy);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPhase("sending");
    setBusy(true);
    setError(null);
    try {
      const result = await requestSignInLink(email.trim());
      setSent(result);
      setPhase("sent");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send the sign-in link.");
      setPhase("idle");
    } finally {
      setBusy(false);
    }
  }

  if (phase === "sent" && sent) {
    return (
      <>
        <div className={dialogStyles.goodPanel}>
          <span className={dialogStyles.goodDot} />
          <div>
            <strong>Link sent to {email.trim()}</strong>
            <span>It works once and expires in {sent.expiresInMinutes} minutes.</span>
          </div>
        </div>
        {sent.delivery === "log" && (
          // Deliberately not a clickable link. Handing the credential back to
          // whoever asked for it would mean anyone could sign in as any address,
          // which is the one thing this flow exists to prevent. Reading the
          // server's own stdout is the proof of access in local development.
          <p className={styles.logNotice}>
            <strong>No mail provider is configured.</strong>
            <span>
              The link was written to the server log instead of sent — check the terminal running{" "}
              <code>npm run dev</code>. Set <code>RESEND_API_KEY</code> to deliver real email.
            </span>
          </p>
        )}
        <div className={dialogStyles.actions}>
          <span>Wrong address, or nothing arrived?</span>
          <button
            onClick={() => {
              setPhase("idle");
              setSent(null);
            }}
          >
            Try again
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <form className="form-fields" onSubmit={submit}>
        <label htmlFor="signin-email">Email address</label>
        <input
          id="signin-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          spellCheck={false}
          required
          disabled={phase === "sending"}
        />
        <p className={styles.explainer}>
          No password. We email a link that signs you in and carries this browser&rsquo;s existing attempts and ratings
          over to the account.
        </p>
        {error && (
          <p className={dialogStyles.error} role="alert">
            {error}
          </p>
        )}
        <button className="btn-primary" type="submit" disabled={phase === "sending" || !email.includes("@")}>
          {phase === "sending" ? "Sending…" : "Email me a link"}
        </button>
      </form>
      <div className={dialogStyles.actions}>
        <span>An account is optional — it only exists so your history outlives this browser.</span>
      </div>
    </>
  );
}
