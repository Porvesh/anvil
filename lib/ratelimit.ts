/**
 * Minimal in-memory fixed-window rate limiter (spec §14 — cap abuse of the
 * subsidized grading tokens). Keyed per client, applied to the model-calling
 * routes only.
 *
 * NOTE: in-memory state is per-process, which is fine for local/single-instance
 * dev. In serverless prod this must move to a shared store (Upstash / Cloudflare
 * KV per the spec) — swap the Map for a KV client without changing callers.
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

interface Window {
  count: number;
  resetAt: number;
}
const windows = new Map<string, Window>();

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetAt: number;
}

export function rateLimit(key: string, now = Date.now()): RateLimitResult {
  const existing = windows.get(key);
  if (!existing || now >= existing.resetAt) {
    const fresh = { count: 1, resetAt: now + WINDOW_MS };
    windows.set(key, fresh);
    return { ok: true, remaining: MAX_PER_WINDOW - 1, resetAt: fresh.resetAt };
  }
  existing.count += 1;
  const remaining = Math.max(0, MAX_PER_WINDOW - existing.count);
  return { ok: existing.count <= MAX_PER_WINDOW, remaining, resetAt: existing.resetAt };
}

/** Derive a client key from the request (IP, best-effort behind proxies). */
export function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
}
