import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createSealedCodec } from "../crypto/sealed";
import { credentialCookieOptions } from "../http/cookies";
import { createUserModelClient, type AiProvider, type ModelClient } from "../ai/client";

export const BYOK_COOKIE = "anvil_byok";
export const BYOK_MAX_AGE_SECONDS = 8 * 60 * 60;

interface ByokPayload {
  provider: AiProvider;
  apiKey: string;
}

function isByokPayload(value: unknown): value is ByokPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Record<string, unknown>;
  return (
    typeof payload.apiKey === "string" &&
    (payload.provider === "anthropic" || payload.provider === "openai")
  );
}

/**
 * The provider key is sealed rather than stored: it is the user's money, so it
 * exists only as ciphertext in their own browser and as plaintext inside the
 * single request that spends it.
 */
const codec = createSealedCodec<ByokPayload>({
  version: "v3",
  secretEnv: ["BYOK_ENCRYPTION_KEY"],
  maxAgeSeconds: BYOK_MAX_AGE_SECONDS,
  isPayload: isByokPayload,
});

/** Seal a key into authenticated ciphertext suitable for an HttpOnly cookie. */
export function sealApiKey(provider: AiProvider, apiKey: string, now = Date.now()) {
  return codec.seal({ provider, apiKey }, now);
}

/** Invalid, tampered, expired, or old-version cookies are treated as absent. */
export function unsealApiKey(value: string, now = Date.now()) {
  return codec.unseal(value, now);
}

export function readByokSession(req: NextRequest) {
  const value = req.cookies.get(BYOK_COOKIE)?.value;
  return value ? unsealApiKey(value) : null;
}

/** User-facing model routes must call this; there is deliberately no platform-key fallback. */
export function userModelFromRequest(req: NextRequest): ModelClient | null {
  const session = readByokSession(req);
  return session ? createUserModelClient(session.provider, session.apiKey) : null;
}

/** Cookie attributes for the key session — `strict` so no other site can spend it. */
export function byokCookieOptions(req: Request, maxAgeSeconds = BYOK_MAX_AGE_SECONDS) {
  return credentialCookieOptions(req, maxAgeSeconds, "strict");
}

export function byokRequiredResponse(): NextResponse {
  return NextResponse.json(
    { error: "Connect an Anthropic or OpenAI API key to use AI features.", code: "byok_required", retryable: false },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}
