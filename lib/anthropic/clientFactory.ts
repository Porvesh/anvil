import Anthropic from "@anthropic-ai/sdk";

export const REQUEST_TIMEOUT_MS = 8 * 60_000;

/** Create an uncached client for a credential whose ownership is request-scoped. */
export function createAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 });
}
