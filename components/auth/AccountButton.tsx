"use client";

import { useCallback, useEffect, useState } from "react";
import { Dialog, dialogStyles } from "@/components/shell/Dialog";
import { IconUser } from "@/lib/icons";
import { ACCOUNT_CHANGED_EVENT, fetchAccount, signOut, type AccountState, SIGNED_OUT } from "@/lib/authClient";
import { SignInForm } from "./SignInForm";
import styles from "./AccountButton.module.css";

/**
 * The top bar's account control.
 *
 * Sits beside the provider-key button and reads as its sibling on purpose:
 * they are the two pieces of state a user carries between visits, and both are
 * optional. Anvil works signed out — this only buys history that outlives the
 * browser — so the button never nags and never blocks a flow.
 */
export function AccountButton() {
  const [account, setAccount] = useState<AccountState | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const controller = new AbortController();
    void fetchAccount(controller.signal).then(setAccount);
    return () => controller.abort();
  }, []);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    const onChanged = () => refresh();
    window.addEventListener(ACCOUNT_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(ACCOUNT_CHANGED_EVENT, onChanged);
  }, [refresh]);

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      await signOut();
      setAccount(SIGNED_OUT);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign out.");
    } finally {
      setBusy(false);
    }
  }

  const signedIn = account?.signedIn ?? false;
  // Null until the session read lands, so the dialog never flashes the wrong copy.
  const available = account ? account.signInAvailable : null;

  return (
    <>
      <button
        className={`${styles.account} ${signedIn ? styles.signedIn : ""}`}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        aria-label={signedIn ? `Signed in as ${account?.email}` : "Sign in to Anvil"}
      >
        <IconUser />
        <span className={styles.label}>{signedIn ? "Account" : "Sign in"}</span>
        <span className={styles.dot} aria-hidden="true" />
      </button>

      {open && (
        <Dialog
          title={signedIn ? "Your account" : available === false ? "Accounts" : "Sign in to Anvil"}
          subtitle={
            signedIn
              ? "Your history follows this account across devices."
              : available === false
                ? "Not switched on yet — Anvil works fully without one."
                : "Optional. Keeps your attempts when this browser forgets."
          }
          icon={<IconUser size={18} />}
          busy={busy}
          onClose={() => !busy && setOpen(false)}
        >
          {signedIn ? (
            <>
              <div className={dialogStyles.goodPanel}>
                <span className={dialogStyles.goodDot} />
                <div>
                  <strong>{account?.email}</strong>
                  <span>Attempts, ratings and contributions are saved to this account.</span>
                </div>
              </div>
              {error && (
                <p className={dialogStyles.error} role="alert">
                  {error}
                </p>
              )}
              <div className={dialogStyles.actions}>
                <span>Signing out leaves this browser anonymous again.</span>
                <button className={dialogStyles.danger} onClick={disconnect} disabled={busy}>
                  {busy ? "Signing out…" : "Sign out"}
                </button>
              </div>
            </>
          ) : (
            <SignInForm available={available} onBusyChange={setBusy} />
          )}
        </Dialog>
      )}
    </>
  );
}
