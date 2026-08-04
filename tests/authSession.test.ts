/**
 * The sealed-cookie primitive and the account session built on it.
 *
 * The properties under test are the ones a forged cookie would exploit:
 * tampering must fail closed, an expired cookie must read as absent, and two
 * codecs sharing one configured secret must not be able to read each other.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createSealedCodec } from "../lib/crypto/sealed";
import { AUTH_COOKIE, AUTH_MAX_AGE_SECONDS, sealAuthSession, unsealAuthSession } from "../lib/auth/session";
import { ownerColumns, ownerFilter, resolveOwner } from "../lib/auth/identity";
import { sealApiKey, unsealApiKey } from "../lib/anthropic/byok";

const previousByok = process.env.BYOK_ENCRYPTION_KEY;
const previousAuth = process.env.AUTH_SECRET;

beforeEach(() => {
  process.env.BYOK_ENCRYPTION_KEY = "test-only-byok-encryption-key-at-least-32-chars";
  delete process.env.AUTH_SECRET;
});

afterAll(() => {
  if (previousByok === undefined) delete process.env.BYOK_ENCRYPTION_KEY;
  else process.env.BYOK_ENCRYPTION_KEY = previousByok;
  if (previousAuth === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = previousAuth;
});

const NOW = 1_800_000_000_000;

describe("account session cookie", () => {
  it("round-trips the account and stamps an expiry", () => {
    const sealed = sealAuthSession({ userId: "user_1", email: "dev@anvil.test" }, NOW);

    expect(sealed.expiresAt).toBe(NOW + AUTH_MAX_AGE_SECONDS * 1000);
    expect(sealed.value).not.toContain("dev@anvil.test");
    expect(unsealAuthSession(sealed.value, NOW)).toEqual({
      userId: "user_1",
      email: "dev@anvil.test",
      expiresAt: sealed.expiresAt,
    });
  });

  it("rejects tampering, expiry, and secret rotation", () => {
    const sealed = sealAuthSession({ userId: "user_1", email: "dev@anvil.test" }, NOW);

    const parts = sealed.value.split(".");
    parts[2] = `${parts[2][0] === "a" ? "b" : "a"}${parts[2].slice(1)}`;
    expect(unsealAuthSession(parts.join("."), NOW)).toBeNull();

    expect(unsealAuthSession(sealed.value, NOW + AUTH_MAX_AGE_SECONDS * 1000 + 1)).toBeNull();

    process.env.BYOK_ENCRYPTION_KEY = "a-different-test-encryption-key-at-least-32-chars";
    expect(unsealAuthSession(sealed.value, NOW)).toBeNull();
  });

  it("prefers AUTH_SECRET when both secrets are configured", () => {
    process.env.AUTH_SECRET = "a-dedicated-auth-secret-at-least-32-characters-long";
    const sealed = sealAuthSession({ userId: "user_1", email: "dev@anvil.test" }, NOW);

    // Rotating only the shared fallback must not disturb a session sealed with
    // the dedicated secret — that is the whole point of allowing both.
    process.env.BYOK_ENCRYPTION_KEY = "a-different-test-encryption-key-at-least-32-chars";
    expect(unsealAuthSession(sealed.value, NOW)?.userId).toBe("user_1");

    delete process.env.AUTH_SECRET;
    expect(unsealAuthSession(sealed.value, NOW)).toBeNull();
  });

  it("keeps the key cookie and the account cookie mutually unreadable", () => {
    // Both codecs read BYOK_ENCRYPTION_KEY here, so this is the case that would
    // break if the version tag were only a label and not part of the key.
    const auth = sealAuthSession({ userId: "user_1", email: "dev@anvil.test" }, NOW);
    const byok = sealApiKey("anthropic", "sk-ant-api03-user-owned-secret", NOW);

    expect(unsealApiKey(auth.value, NOW)).toBeNull();
    expect(unsealAuthSession(byok.value, NOW)).toBeNull();
  });
});

describe("row ownership", () => {
  /** A request carrying (or not carrying) the account cookie. */
  function request(cookie?: string): NextRequest {
    return new NextRequest("https://anvil.test/api/history", {
      headers: cookie ? { cookie: `${AUTH_COOKIE}=${cookie}` } : {},
    });
  }

  it("reads as the account when signed in, and as the browser otherwise", () => {
    const sealed = sealAuthSession({ userId: "user_1", email: "dev@anvil.test" });

    expect(ownerFilter(resolveOwner(request(sealed.value), "browser-1"))).toEqual({ userId: "user_1" });
    expect(ownerColumns(resolveOwner(request(sealed.value), "browser-1"))).toEqual({
      sessionId: "browser-1",
      userId: "user_1",
    });

    expect(ownerFilter(resolveOwner(request(), "browser-1"))).toEqual({ sessionId: "browser-1", userId: null });
  });

  it("hides claimed rows from an anonymous caller with the same browser id", () => {
    // After a merge the browser's rows carry a userId. Signing out must not
    // leave them readable to whoever uses the browser next, and the `userId:
    // null` clause is what enforces that.
    expect(ownerFilter(resolveOwner(request(), "browser-1"))).toMatchObject({ userId: null });
  });

  it("ignores a forged cookie", () => {
    expect(resolveOwner(request("not-a-real-session"), "browser-1").userId).toBeNull();
  });
});

describe("sealed codec", () => {
  const codec = createSealedCodec<{ note: string }>({
    version: "test1",
    secretEnv: ["BYOK_ENCRYPTION_KEY"],
    maxAgeSeconds: 60,
    isPayload: (value): value is { note: string } =>
      typeof value === "object" && value !== null && typeof (value as { note?: unknown }).note === "string",
  });

  it("rejects a payload whose shape no longer parses", () => {
    const wrongShape = createSealedCodec<{ other: number }>({
      version: "test1",
      secretEnv: ["BYOK_ENCRYPTION_KEY"],
      maxAgeSeconds: 60,
      isPayload: (value): value is { other: number } =>
        typeof value === "object" && value !== null && typeof (value as { other?: unknown }).other === "number",
    });

    // Same version and secret, so it decrypts and authenticates — and is still
    // refused, because the guard is what decides whether it is usable.
    const sealed = wrongShape.seal({ other: 7 }, NOW);
    expect(codec.unseal(sealed.value, NOW)).toBeNull();
  });

  it("refuses to seal without a long enough secret", () => {
    process.env.BYOK_ENCRYPTION_KEY = "too-short";
    expect(() => codec.seal({ note: "hi" }, NOW)).toThrow(/at least 32 characters/);
  });

  it("treats a value sealed under another version as absent", () => {
    const other = createSealedCodec<{ note: string }>({
      version: "test2",
      secretEnv: ["BYOK_ENCRYPTION_KEY"],
      maxAgeSeconds: 60,
      isPayload: (value): value is { note: string } =>
        typeof value === "object" && value !== null && typeof (value as { note?: unknown }).note === "string",
    });
    expect(codec.unseal(other.seal({ note: "hi" }, NOW).value, NOW)).toBeNull();
  });
});
