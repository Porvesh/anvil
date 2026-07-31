/**
 * The handle to an in-flight generation job, kept in localStorage.
 *
 * The whole point of the match-first flow is that the user is routed into a
 * problem within ~1s and solves it *while* their tailored one builds. That
 * means the job outlives the page that started it, so the jobId can't live in
 * React state — it has to survive a navigation, and ideally a reload.
 */
const KEY = "anvil.pendingGeneration";

export interface PendingGeneration {
  jobId: string;
  /** What the user asked for, so the toast can say something specific. */
  label: string;
  startedAt: number;
}

/** Jobs older than this are assumed dead; the worker's own cap is 10 minutes. */
const STALE_MS = 12 * 60_000;

export function readPending(): PendingGeneration | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const pending = JSON.parse(raw) as PendingGeneration;
    if (!pending?.jobId || Date.now() - pending.startedAt > STALE_MS) {
      window.localStorage.removeItem(KEY);
      return null;
    }
    return pending;
  } catch {
    return null;
  }
}

export function writePending(pending: PendingGeneration): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(pending));
  // Same-tab listeners don't get a `storage` event, so announce it directly.
  window.dispatchEvent(new CustomEvent(PENDING_EVENT));
}

export function clearPending(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
  window.dispatchEvent(new CustomEvent(PENDING_EVENT));
}

/** Fired when the pending job changes within this tab. */
export const PENDING_EVENT = "anvil:pending-generation";
