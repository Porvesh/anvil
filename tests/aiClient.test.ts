import type OpenAI from "openai";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { modelFor, streamModelText, structuredModelOutput, type ModelClient } from "../lib/ai/client";

const openai = { provider: "openai", sdk: {} as OpenAI } satisfies ModelClient;

describe("provider model routing", () => {
  it("uses high-quality OpenAI models for grading and the cost-sensitive tier for hints", () => {
    expect(modelFor(openai, "judgeReview")).toBe("gpt-5.6-terra");
    expect(modelFor(openai, "judgeDesign")).toBe("gpt-5.6-sol");
    expect(modelFor(openai, "hint")).toBe("gpt-5.6-luna");
    expect(modelFor(openai, "jdMatch")).toBe("gpt-5.6-luna");
  });

  it("uses non-stored Responses API structured output for OpenAI grading", async () => {
    const parse = vi.fn().mockResolvedValue({ output_parsed: { verdict: "ok" } });
    const client = {
      provider: "openai",
      sdk: { responses: { parse } } as unknown as OpenAI,
    } satisfies ModelClient;

    const result = await structuredModelOutput(
      client,
      "judgeReview",
      z.object({ verdict: z.string() }),
      "verdict",
      "system context",
      "submission",
      { verdict: "fallback" },
    );

    expect(result).toEqual({ verdict: "ok" });
    expect(parse.mock.calls[0][0]).toMatchObject({
      model: "gpt-5.6-terra",
      store: false,
      instructions: "system context",
      input: "submission",
    });
  });

  it("translates OpenAI response deltas into the shared streaming contract", async () => {
    async function* events() {
      yield { type: "response.created" };
      yield { type: "response.output_text.delta", delta: "first " };
      yield { type: "response.output_text.delta", delta: "second" };
      yield { type: "response.completed" };
    }
    const create = vi.fn().mockResolvedValue(events());
    const client = {
      provider: "openai",
      sdk: { responses: { create } } as unknown as OpenAI,
    } satisfies ModelClient;
    const deltas: string[] = [];

    const full = await streamModelText(
      client,
      "hint",
      "hint rules",
      [{ role: "user", content: "help" }],
      (delta) => deltas.push(delta),
    );

    expect(full).toBe("first second");
    expect(deltas).toEqual(["first ", "second"]);
    expect(create.mock.calls[0][0]).toMatchObject({
      model: "gpt-5.6-luna",
      store: false,
      stream: true,
    });
  });
});
