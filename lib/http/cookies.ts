/**
 * Attributes for the two credential cookies (the BYOK provider key and the
 * account session).
 *
 * Both must be unreadable by page JavaScript and both are written from more
 * than one route, so the attribute set lives in one place — a cookie that
 * silently loses `httpOnly` because one route spelled its options differently
 * is exactly the bug this prevents.
 */
import { secureCookieFor } from "./origin";

export interface CredentialCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: "strict" | "lax";
  path: "/";
  maxAge: number;
  priority: "high";
}

/**
 * `sameSite` is the one real choice here. The BYOK key uses `strict`: nothing
 * off-site should ever be able to spend a user's provider billing. The account
 * session uses `lax`, because sign-in arrives as a top-level navigation from an
 * email client and a `strict` cookie would not be sent on that first hop, which
 * reads to the user as "the link didn't work".
 *
 * Pass `maxAgeSeconds: 0` to expire the cookie.
 */
export function credentialCookieOptions(
  req: Request,
  maxAgeSeconds: number,
  sameSite: "strict" | "lax",
): CredentialCookieOptions {
  return {
    httpOnly: true,
    secure: secureCookieFor(req),
    sameSite,
    path: "/",
    maxAge: maxAgeSeconds,
    priority: "high",
  };
}
