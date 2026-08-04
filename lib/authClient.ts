/**
 * Browser-side account helpers.
 *
 * The account cookie is HttpOnly, so page JavaScript cannot read it — the only
 * way to know who you are is to ask the server. These three calls are that ask,
 * kept in one module so every surface agrees on the shapes and the URLs.
 */
import { getSessionId } from "./session";

export interface AccountState {
  signedIn: boolean;
  email: string | null;
  /**
   * Whether this deployment can actually deliver a sign-in email. False means
   * no mail transport is configured, so the UI offers "coming soon" rather than
   * a form whose link the visitor would never receive.
   */
  signInAvailable: boolean;
}

export const SIGNED_OUT: AccountState = { signedIn: false, email: null, signInAvailable: false };

/** Fired after a sign-out so any mounted account UI re-reads its state. */
export const ACCOUNT_CHANGED_EVENT = "anvil:account-changed";

export function notifyAccountChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ACCOUNT_CHANGED_EVENT));
}

export async function fetchAccount(signal?: AbortSignal): Promise<AccountState> {
  try {
    const response = await fetch("/api/auth/session", { cache: "no-store", signal });
    if (!response.ok) return SIGNED_OUT;
    const data = (await response.json()) as Partial<AccountState>;
    return {
      signedIn: Boolean(data.signedIn),
      email: data.email ?? null,
      signInAvailable: Boolean(data.signInAvailable),
    };
  } catch {
    // Offline or aborted: treat as signed out rather than blocking the UI.
    return SIGNED_OUT;
  }
}

export interface LinkRequested {
  expiresInMinutes: number;
  /**
   * Where the link went — never the link itself. `"log"` means no mail provider
   * is configured and it was written to the server's stdout, which only someone
   * with terminal access can read. The server refuses that path in production.
   */
  delivery: "email" | "log";
}

export async function requestSignInLink(email: string): Promise<LinkRequested> {
  const response = await fetch("/api/auth/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // The anonymous id travels so the server can adopt this browser's existing
    // attempts and votes into the account (lib/auth/merge.ts).
    body: JSON.stringify({ email, sessionId: getSessionId() }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error ?? "Could not send the sign-in link.");
  return { expiresInMinutes: data?.expiresInMinutes ?? 15, delivery: data?.delivery === "log" ? "log" : "email" };
}

export async function signOut(): Promise<void> {
  const response = await fetch("/api/auth/session", { method: "DELETE" });
  if (!response.ok) throw new Error("Could not sign out.");
  notifyAccountChanged();
}
