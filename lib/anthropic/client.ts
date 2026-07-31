import Anthropic from "@anthropic-ai/sdk";
import { REQUEST_TIMEOUT_MS } from "./clientFactory";

/**
 * Operator client for generation and maintenance work. Interactive routes do
 * not import this singleton: they construct an uncached client from the user's
 * sealed BYOK session. Cached only to avoid dev hot-reload churn.
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
// Call sites opt into their own retry/deadline policy through reliability.ts.
// Keeping the singleton at zero retries prevents a new call from silently using
// the SDK default and turning one user action into three unbounded requests.
export const anthropic = globalForAnthropic.anthropic ?? new Anthropic({ timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 });

if (process.env.NODE_ENV !== "production") globalForAnthropic.anthropic = anthropic;
