/**
 * Fixed-window rate limiting (spec §12).
 *
 * Two buckets with different jobs:
 *  - `rateLimit` is a burst guard on every model-calling route — 20/60s, keyed
 *    by IP. It stops a runaway client, nothing more.
 *  - `dailyLimit` is a *budget* on generation, keyed by session. Generation is
 *    the only endpoint that can produce a real bill (a banked problem costs a
 *    couple of dollars once rejected attempts are counted), so it's the only
 *    one that needs a ceiling rather than a throttle.
 *
 * NOTE: the backing store is an in-process Map, which is per-instance and
 * therefore meaningless across a serverless fleet — two instances give you two
 * full budgets. `Store` exists so this swaps for KV/Redis at deploy time
 * without touching a single caller; see `setRateLimitStore`.
 */

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

/** Generations per session per day. Small on purpose — the bank is the product. */
const DAILY_GENERATIONS = 5;

interface Counter {
  count: number;
  resetAt: number;
}

/**
 * The minimum surface a shared store has to implement. Deliberately narrow:
 * "increment this key, tell me the count, expire it at this time" is expressible
 * in Upstash/Redis (INCR + EXPIRE) and Cloudflare KV alike.
 */
export interface Store {
  bump(key: string, windowMs: number, now: number): Counter;
}

/** Per-process default. Correct for local dev and single-instance deploys. */
const memory = new Map<string, Counter>();

const memoryStore: Store = {
  bump(key, windowMs, now) {
    const existing = memory.get(key);
    if (!existing || now >= existing.resetAt) {
      const fresh = { count: 1, resetAt: now + windowMs };
      memory.set(key, fresh);
      return fresh;
    }
    existing.count += 1;
    return existing;
  },
};

let store: Store = memoryStore;

/** Swap in a shared store (KV, Redis) before serving from more than one instance. */
export function setRateLimitStore(next: Store): void {
  store = next;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
}

/**
 * The primitive: count one request against `key` and say whether it fits.
 *
 * Exported because not every bucket is a burst guard or a daily budget — sign-in
 * email, for one, needs a slow per-address window that neither preset describes.
 * Callers that fit a preset should use it rather than restating the numbers.
 */
export function limitRequests(key: string, max: number, windowMs: number, now = Date.now()): RateLimitResult {
  const counter = store.bump(key, windowMs, now);
  return {
    ok: counter.count <= max,
    remaining: Math.max(0, max - counter.count),
    resetAt: counter.resetAt,
    limit: max,
  };
}

/** Burst guard: 20 requests per minute per client. */
export function rateLimit(key: string, now = Date.now()): RateLimitResult {
  return limitRequests(key, MAX_PER_WINDOW, WINDOW_MS, now);
}

/**
 * Spend budget: N per calendar day.
 *
 * Keyed by day so the window resets at midnight UTC rather than sliding — a
 * user who hits the cap gets it back on a predictable schedule instead of at an
 * arbitrary moment they can't reason about.
 */
export function dailyLimit(key: string, now = Date.now()): RateLimitResult {
  const day = new Date(now).toISOString().slice(0, 10);
  const endOfDay = Date.parse(`${day}T23:59:59.999Z`);
  return limitRequests(`${key}:${day}`, DAILY_GENERATIONS, endOfDay - now + 1, now);
}

/**
 * Sign-in emails per address per hour.
 *
 * A different shape of abuse from the burst guard: the cost here is someone
 * else's inbox, not our CPU, so the window is long and the ceiling low. Keyed by
 * address rather than IP because the target of the nuisance is the address.
 */
export const SIGNIN_EMAILS_PER_HOUR = 5;

export function signInEmailLimit(email: string, now = Date.now()): RateLimitResult {
  return limitRequests(`signin:${email}`, SIGNIN_EMAILS_PER_HOUR, 60 * 60 * 1000, now);
}

/** Derive a client key from the request (IP, best-effort behind proxies). */
export function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
}
