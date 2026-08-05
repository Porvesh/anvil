import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BYOK_MAX_AGE_SECONDS, sealApiKey, unsealApiKey } from "../lib/anthropic/byok";
import { isSameOrigin, secureCookieFor } from "../lib/http/origin";

const previousSecret = process.env.BYOK_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.BYOK_ENCRYPTION_KEY = "test-only-byok-encryption-key-at-least-32-chars";
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.BYOK_ENCRYPTION_KEY;
  else process.env.BYOK_ENCRYPTION_KEY = previousSecret;
});

describe("BYOK session sealing", () => {
  it("round-trips a key without exposing it in the cookie", () => {
    const now = 1_800_000_000_000;
    const apiKey = "sk-ant-api03-user-owned-secret";
    const sealed = sealApiKey("anthropic", apiKey, now);

    expect(sealed.value).not.toContain(apiKey);
    expect(unsealApiKey(sealed.value, now)).toEqual({
      apiKey,
      provider: "anthropic",
      expiresAt: now + BYOK_MAX_AGE_SECONDS * 1000,
    });
  });

  it("round-trips the selected OpenAI provider with the encrypted key", () => {
    const now = 1_800_000_000_000;
    const apiKey = "sk-proj-user-owned-openai-secret";
    const sealed = sealApiKey("openai", apiKey, now);

    expect(sealed.value).not.toContain(apiKey);
    expect(unsealApiKey(sealed.value, now)).toEqual({
      provider: "openai",
      apiKey,
      expiresAt: now + BYOK_MAX_AGE_SECONDS * 1000,
    });
  });

  it("rejects tampered and expired cookies", () => {
    const now = 1_800_000_000_000;
    const sealed = sealApiKey("anthropic", "sk-ant-api03-user-owned-secret", now);
    const parts = sealed.value.split(".");
    parts[2] = `${parts[2][0] === "a" ? "b" : "a"}${parts[2].slice(1)}`;
    const tampered = parts.join(".");

    expect(unsealApiKey(tampered, now)).toBeNull();
    expect(unsealApiKey(sealed.value, now + BYOK_MAX_AGE_SECONDS * 1000 + 1)).toBeNull();
  });

  it("rejects cookies after an encryption-key rotation", () => {
    const sealed = sealApiKey("anthropic", "sk-ant-api03-user-owned-secret");
    process.env.BYOK_ENCRYPTION_KEY = "a-different-test-encryption-key-at-least-32-chars";
    expect(unsealApiKey(sealed.value)).toBeNull();
  });
});

describe("BYOK request guards", () => {
  it("accepts only the request origin, including trusted forwarding headers", () => {
    expect(isSameOrigin(new Request("https://anvil.test/api/byok", { headers: { origin: "https://anvil.test" } }))).toBe(true);
    expect(isSameOrigin(new Request("https://anvil.test/api/byok", { headers: { origin: "https://evil.test" } }))).toBe(false);
    expect(isSameOrigin(new Request("https://anvil.test/api/byok"))).toBe(false);

    const forwarded = new Request("http://127.0.0.1/api/byok", {
      headers: {
        origin: "https://anvil.example",
        host: "anvil.example",
        "x-forwarded-proto": "https",
      },
    });
    expect(isSameOrigin(forwarded)).toBe(true);
    expect(secureCookieFor(forwarded)).toBe(true);
  });
});
