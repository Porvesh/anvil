import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ZodType } from "zod";
import { callParams, type CallSite } from "../anthropic/models";
import { modelRequestOptions } from "../anthropic/reliability";

const REQUEST_TIMEOUT_MS = 90_000;

export type AiProvider = "anthropic" | "openai";

export type ModelClient =
  | { provider: "anthropic"; sdk: Anthropic }
  | { provider: "openai"; sdk: OpenAI };

export function anthropicModelClient(sdk: Anthropic): ModelClient {
  return { provider: "anthropic", sdk };
}

export function createUserModelClient(provider: AiProvider, apiKey: string): ModelClient {
  if (provider === "openai") {
    return {
      provider,
      sdk: new OpenAI({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 }),
    };
  }
  return {
    provider,
    sdk: new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 }),
  };
}

const OPENAI_MODELS: Record<CallSite, { model: string; effort: "low" | "medium" | "high" }> = {
  generation: { model: "gpt-5.6-sol", effort: "medium" },
  generationDesign: { model: "gpt-5.6-sol", effort: "medium" },
  generationReview: { model: "gpt-5.6-sol", effort: "medium" },
  generationFallback: { model: "gpt-5.6-terra", effort: "medium" },
  verifyGenerated: { model: "gpt-5.6-terra", effort: "high" },
  judgeReview: { model: "gpt-5.6-terra", effort: "medium" },
  judgeDebug: { model: "gpt-5.6-terra", effort: "medium" },
  judgeDesign: { model: "gpt-5.6-sol", effort: "high" },
  socratic: { model: "gpt-5.6-sol", effort: "medium" },
  hint: { model: "gpt-5.6-luna", effort: "low" },
  jdMatch: { model: "gpt-5.6-luna", effort: "low" },
  contributionIntake: { model: "gpt-5.6-terra", effort: "medium" },
  contributionDuplicate: { model: "gpt-5.6-terra", effort: "low" },
};

export function modelFor(client: ModelClient, site: CallSite): string {
  return client.provider === "anthropic" ? callParams(site).model : OPENAI_MODELS[site].model;
}

function openAiParams(site: CallSite) {
  const anthropicConfig = callParams(site);
  const config = OPENAI_MODELS[site];
  return {
    model: config.model,
    max_output_tokens: anthropicConfig.max_tokens,
    reasoning: { effort: config.effort },
    store: false,
  } as const;
}

export async function streamModelText(
  client: ModelClient,
  site: CallSite,
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  let full = "";
  if (client.provider === "anthropic") {
    const stream = client.sdk.messages.stream({
      ...callParams(site),
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages,
    }, modelRequestOptions(site, signal));
    stream.on("text", (delta) => {
      full += delta;
      onDelta(delta);
    });
    await stream.finalMessage();
    return full;
  }

  const stream = await client.sdk.responses.create({
    ...openAiParams(site),
    instructions: system,
    input: messages,
    stream: true,
  }, modelRequestOptions(site, signal));
  for await (const event of stream) {
    if (event.type !== "response.output_text.delta") continue;
    full += event.delta;
    onDelta(event.delta);
  }
  return full;
}

export function structuredModelOutput<T>(
  client: ModelClient,
  site: CallSite,
  schema: ZodType<T>,
  schemaName: string,
  system: string,
  user: string,
  fallback: T,
  signal?: AbortSignal,
): Promise<T>;
export function structuredModelOutput<T>(
  client: ModelClient,
  site: CallSite,
  schema: ZodType<T>,
  schemaName: string,
  system: string,
  user: string,
  fallback: null,
  signal?: AbortSignal,
): Promise<T | null>;
export async function structuredModelOutput<T>(
  client: ModelClient,
  site: CallSite,
  schema: ZodType<T>,
  schemaName: string,
  system: string,
  user: string,
  fallback: T | null,
  signal?: AbortSignal,
): Promise<T | null> {
  if (client.provider === "anthropic") {
    const result = await client.sdk.messages.parse({
      ...callParams(site),
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
      output_config: { format: zodOutputFormat(schema) },
    }, modelRequestOptions(site, signal));
    return result.parsed_output ?? fallback;
  }

  const result = await client.sdk.responses.parse({
    ...openAiParams(site),
    instructions: system,
    input: user,
    text: { format: zodTextFormat(schema, schemaName) },
  }, modelRequestOptions(site, signal));
  return result.output_parsed ?? fallback;
}

export async function validateUserKey(
  provider: AiProvider,
  apiKey: string,
  signal?: AbortSignal,
): Promise<void> {
  const client = createUserModelClient(provider, apiKey);
  const options = { timeout: 10_000, maxRetries: 0, signal };
  if (client.provider === "anthropic") {
    await client.sdk.models.list({ limit: 1 }, options);
  } else {
    await client.sdk.models.list(options);
  }
}
