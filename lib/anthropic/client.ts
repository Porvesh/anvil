import Anthropic from "@anthropic-ai/sdk";

/**
 * Anthropic client singleton. Reads ANTHROPIC_API_KEY from the environment
 * (loaded from .env by Next.js). Cached on globalThis so Next.js dev hot-reload
 * doesn't spin up a new client per edit. Server-only — never import from a
 * client component; all model calls are proxied through API routes (spec §7).
 */
const globalForAnthropic = globalThis as unknown as { anthropic?: Anthropic };

export const anthropic = globalForAnthropic.anthropic ?? new Anthropic();

if (process.env.NODE_ENV !== "production") globalForAnthropic.anthropic = anthropic;
