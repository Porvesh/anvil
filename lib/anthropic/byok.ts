import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createAnthropicClient } from "./clientFactory";

export const BYOK_COOKIE = "anvil_byok";
export const BYOK_MAX_AGE_SECONDS = 8 * 60 * 60;
const VERSION = "v1";

interface ByokPayload {
  apiKey: string;
  expiresAt: number;
}

function encryptionKey(): Buffer {
  const secret = process.env.BYOK_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error("BYOK_ENCRYPTION_KEY must be at least 32 characters");
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

function encode(value: Buffer): string {
  return value.toString("base64url");
}

function decode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

/** Seal a key into authenticated ciphertext suitable for an HttpOnly cookie. */
export function sealApiKey(apiKey: string, now = Date.now()): { value: string; expiresAt: number } {
  const expiresAt = now + BYOK_MAX_AGE_SECONDS * 1000;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(VERSION));
  const plaintext = Buffer.from(JSON.stringify({ apiKey, expiresAt } satisfies ByokPayload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    value: [VERSION, encode(iv), encode(ciphertext), encode(cipher.getAuthTag())].join("."),
    expiresAt,
  };
}

/** Invalid, tampered, expired, or old-version cookies are treated as absent. */
export function unsealApiKey(value: string, now = Date.now()): ByokPayload | null {
  try {
    const [version, ivText, ciphertextText, tagText, extra] = value.split(".");
    if (version !== VERSION || !ivText || !ciphertextText || !tagText || extra) return null;
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), decode(ivText));
    decipher.setAAD(Buffer.from(VERSION));
    decipher.setAuthTag(decode(tagText));
    const plaintext = Buffer.concat([decipher.update(decode(ciphertextText)), decipher.final()]).toString("utf8");
    const payload = JSON.parse(plaintext) as Partial<ByokPayload>;
    if (
      typeof payload.apiKey !== "string" ||
      typeof payload.expiresAt !== "number" ||
      payload.expiresAt <= now ||
      payload.expiresAt > now + BYOK_MAX_AGE_SECONDS * 1000 + 60_000
    ) {
      return null;
    }
    return payload as ByokPayload;
  } catch {
    return null;
  }
}

export function readByokSession(req: NextRequest): ByokPayload | null {
  const value = req.cookies.get(BYOK_COOKIE)?.value;
  return value ? unsealApiKey(value) : null;
}

/** User-facing model routes must call this; there is deliberately no platform-key fallback. */
export function userAnthropicFromRequest(req: NextRequest): Anthropic | null {
  const session = readByokSession(req);
  return session ? createAnthropicClient(session.apiKey) : null;
}

export function byokRequiredResponse(): NextResponse {
  return NextResponse.json(
    { error: "Connect your Anthropic API key to use AI features.", code: "byok_required", retryable: false },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

/** Prevent another origin from setting or clearing the credential cookie. */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const url = new URL(req.url);
  const host = req.headers.get("host");
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const expected = host ? `${forwardedProto || url.protocol.slice(0, -1)}://${host}` : url.origin;
  return origin === expected;
}

export function secureCookieFor(req: Request): boolean {
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return forwardedProto ? forwardedProto === "https" : new URL(req.url).protocol === "https:";
}

/** Validate ownership without consuming model tokens. */
export async function validateAnthropicKey(apiKey: string, signal?: AbortSignal): Promise<void> {
  await createAnthropicClient(apiKey).models.list(
    { limit: 1 },
    { timeout: 10_000, maxRetries: 0, signal },
  );
}
