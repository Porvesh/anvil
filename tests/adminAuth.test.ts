import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { isGenerationAdmin } from "../lib/adminAuth";

const previous = process.env.GENERATION_ADMIN_TOKEN;

beforeEach(() => {
  process.env.GENERATION_ADMIN_TOKEN = "operator-test-token";
});

afterAll(() => {
  if (previous === undefined) delete process.env.GENERATION_ADMIN_TOKEN;
  else process.env.GENERATION_ADMIN_TOKEN = previous;
});

describe("generation operator authentication", () => {
  it("accepts only the configured bearer token", () => {
    expect(
      isGenerationAdmin(
        new Request("https://anvil.test/api/generate", {
          headers: { authorization: "Bearer operator-test-token" },
        }),
      ),
    ).toBe(true);
    expect(
      isGenerationAdmin(
        new Request("https://anvil.test/api/generate", {
          headers: { authorization: "Bearer attacker-test-token" },
        }),
      ),
    ).toBe(false);
  });

  it("fails closed when either side is absent", () => {
    expect(isGenerationAdmin(new Request("https://anvil.test/api/generate"))).toBe(false);
    delete process.env.GENERATION_ADMIN_TOKEN;
    expect(
      isGenerationAdmin(
        new Request("https://anvil.test/api/generate", {
          headers: { authorization: "Bearer operator-test-token" },
        }),
      ),
    ).toBe(false);
  });
});
