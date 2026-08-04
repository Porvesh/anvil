import { type NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { mergeAnonymousWork } from "@/lib/auth/merge";
import { AUTH_COOKIE, authCookieOptions, sealAuthSession } from "@/lib/auth/session";
import { consumeLoginToken } from "@/lib/auth/tokens";
import { requestOrigin } from "@/lib/http/origin";
import { clientKey, rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

/** Where a completed sign-in lands. History is the payoff: it is the surface an
 *  account exists to preserve. */
const SUCCESS_PATH = "/history";
const FAILURE_PATH = "/signin";

/**
 * GET /api/auth/callback?token=… — redeem a sign-in link.
 *
 * A GET that mutates, which is normally wrong, but the request is a human
 * clicking a link in their mail client and nothing else can produce a valid
 * token. The mitigations that matter are that the token is single-use, expires
 * in fifteen minutes, and is destroyed by this call.
 *
 * The response is always a redirect: the user arrived by navigation, so an error
 * has to be a page they can read, not a JSON body.
 */
export async function GET(req: NextRequest) {
  const origin = requestOrigin(req);
  const redirect = (path: string, params: Record<string, string>) =>
    NextResponse.redirect(new URL(`${path}?${new URLSearchParams(params)}`, origin), {
      // 303: turn the redeemed GET into a plain GET of the destination, and keep
      // the redirect itself out of any cache.
      status: 303,
      headers: { "Cache-Control": "no-store" },
    });

  if (!rateLimit(`auth-callback:${clientKey(req)}`).ok) {
    return redirect(FAILURE_PATH, { status: "throttled" });
  }

  const token = new URL(req.url).searchParams.get("token");
  if (!token) return redirect(FAILURE_PATH, { status: "invalid" });

  const consumed = await consumeLoginToken(prisma, token);
  if (!consumed.ok) return redirect(FAILURE_PATH, { status: consumed.reason });

  // First successful sign-in for an address creates the account. `upsert` also
  // covers the race where two links for a brand-new address are redeemed at
  // once: the unique email index makes the second a no-op update.
  const user = await prisma.user.upsert({
    where: { email: consumed.email },
    create: { email: consumed.email, lastLoginAt: new Date() },
    update: { lastLoginAt: new Date() },
    select: { id: true, email: true },
  });

  // Adopt whatever the requesting browser had already done anonymously. A
  // failure here must not cost the user their session — they are legitimately
  // signed in either way — so it is reported, not thrown.
  let merged = 0;
  try {
    const summary = await mergeAnonymousWork(prisma, { userId: user.id, sessionId: consumed.claimSessionId });
    merged = summary.attempts;
  } catch {
    merged = -1;
  }

  const sealed = sealAuthSession({ userId: user.id, email: user.email });
  const response = redirect(SUCCESS_PATH, {
    status: "ok",
    ...(merged > 0 ? { merged: String(merged) } : {}),
    ...(merged < 0 ? { merge: "failed" } : {}),
  });
  response.cookies.set(AUTH_COOKIE, sealed.value, authCookieOptions(req));
  return response;
}
