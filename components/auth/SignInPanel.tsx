"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SIGN_IN_MESSAGES, type SignInStatus } from "@/lib/authStatus";
import { fetchAccount, type AccountState } from "@/lib/authClient";
import { SignInForm } from "./SignInForm";
import styles from "./SignInPanel.module.css";

/**
 * The standalone sign-in surface.
 *
 * Shows the outcome of a magic link when the callback sent one, then either the
 * signed-in state or the request form. It re-reads the session on mount rather
 * than trusting `status=ok`, so a stale bookmarked URL can't claim you are
 * signed in when the cookie has since expired.
 */
export function SignInPanel({ status }: { status: SignInStatus | null }) {
  const [account, setAccount] = useState<AccountState | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchAccount(controller.signal).then(setAccount);
    return () => controller.abort();
  }, []);

  const message = status ? SIGN_IN_MESSAGES[status] : null;
  const signedIn = account?.signedIn ?? false;
  const available = account ? account.signInAvailable : null;

  return (
    <div className={styles.wrap}>
      <section className={styles.card}>
        <div className="eyebrow">Account</div>
        <h1>{signedIn ? "You're signed in" : available === false ? "Accounts are coming" : "Keep your history"}</h1>
        <p className={styles.lead}>
          Anvil works without an account. Signing in {available === false ? "will mean" : "only means"} your attempts,
          ratings, and contributions survive a cleared browser and follow you to another machine.
        </p>

        {message && !(status === "ok" && !signedIn) && (
          <div className={`${styles.status} ${message.tone === "good" ? styles.good : styles.bad}`} role="status">
            <strong>{message.title}</strong>
            <span>{message.detail}</span>
          </div>
        )}

        {signedIn ? (
          <div className={styles.next}>
            <p>
              Signed in as <strong>{account?.email}</strong>.
            </p>
            <div className={styles.links}>
              <Link className="btn-primary" href="/history">
                See your history →
              </Link>
              <Link href="/">Back to practice</Link>
            </div>
          </div>
        ) : (
          <SignInForm available={available} />
        )}
      </section>
    </div>
  );
}
