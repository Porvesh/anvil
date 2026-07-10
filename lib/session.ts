/**
 * Anonymous session identity (spec §14 — no login to start). A random id is
 * generated in the browser and persisted in localStorage; it's sent with grade
 * requests so a user's attempt history can be tied together without an account.
 */
const STORAGE_KEY = "anvil.sessionId";

/** Get (or lazily create) this browser's anonymous session id. Client-only. */
export function getSessionId(): string {
  if (typeof window === "undefined") return "server";
  let id = window.localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    window.localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}
