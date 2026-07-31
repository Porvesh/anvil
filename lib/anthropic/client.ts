import Anthropic from "@anthropic-ai/sdk";

/**
 * Anthropic client singleton. Reads ANTHROPIC_API_KEY from the environment
 * (loaded from .env by Next.js). Cached on globalThis so Next.js dev hot-reload
 * doesn't spin up a new client per edit. Server-only — never import from a
 * client component; all model calls are proxied through API routes (spec §7).
 */
const globalForAnthropic = globalThis as unknown as { anthropic?: Anthropic };

/**
 * Cap a single call at 8 minutes.
 *
 * The SDK scales its default timeout with `max_tokens`, which for a large
 * generation means a stuck request can hang for ~25 minutes before anyone finds
 * out — long enough that three retries burn over an hour and the worker looks
 * wedged. Generation that hasn't finished in 8 minutes is not going to produce
 * something worth waiting for; failing fast lets the retry (or the fallback
 * model) actually happen.
 */
const REQUEST_TIMEOUT_MS = 8 * 60_000;

export const anthropic = globalForAnthropic.anthropic ?? new Anthropic({ timeout: REQUEST_TIMEOUT_MS });

if (process.env.NODE_ENV !== "production") globalForAnthropic.anthropic = anthropic;
