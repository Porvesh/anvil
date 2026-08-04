/**
 * The account session cookie.
 *
 * Same sealed-cookie mechanism as the BYOK key (lib/crypto/sealed.ts) with a
 * different version tag, so the two are cryptographically separate even though
 * one secret configures both. The payload is deliberately minimal — an id and
 * the email needed to render "signed in as" — because a stateless cookie is a
 * copy of data, and a copy of anything more would have to be kept in sync.
 *
 * Thirty days: long enough that an account is worth creating (the whole point is
 * outliving one browser's localStorage), short enough that an abandoned laptop
 * eventually forgets.
 */
import type { NextRequest } from "next/server";
import { createSealedCodec } from "../crypto/sealed";
import { credentialCookieOptions } from "../http/cookies";

export const AUTH_COOKIE = "anvil_session";
export const AUTH_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface AuthSession {
  userId: string;
  email: string;
}

function isAuthSession(value: unknown): value is AuthSession {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.userId === "string" && typeof payload.email === "string";
}

const codec = createSealedCodec<AuthSession>({
  version: "auth1",
  // AUTH_SECRET is optional: one configured secret is enough for a local or
  // single-service deployment, and the version tag already keeps the derived
  // keys apart. Operators who want independent rotation set both.
  secretEnv: ["AUTH_SECRET", "BYOK_ENCRYPTION_KEY"],
  maxAgeSeconds: AUTH_MAX_AGE_SECONDS,
  isPayload: isAuthSession,
});

export function sealAuthSession(session: AuthSession, now = Date.now()) {
  return codec.seal(session, now);
}

export function unsealAuthSession(value: string, now = Date.now()) {
  return codec.unseal(value, now);
}

/**
 * The signed-in account for this request, or null.
 *
 * Reads the cookie only — no database round trip — because it is called on
 * every write path. The cookie is authenticated, so a forged one is impossible;
 * the worst case is a session that outlives a deleted account, and every route
 * that writes `userId` is protected by the foreign key anyway.
 */
export function readAuthSession(req: NextRequest): AuthSession | null {
  const value = req.cookies.get(AUTH_COOKIE)?.value;
  if (!value) return null;
  const session = unsealAuthSession(value);
  return session ? { userId: session.userId, email: session.email } : null;
}

/** `lax`, so the cookie survives the top-level navigation out of an email client. */
export function authCookieOptions(req: Request, maxAgeSeconds = AUTH_MAX_AGE_SECONDS) {
  return credentialCookieOptions(req, maxAgeSeconds, "lax");
}
