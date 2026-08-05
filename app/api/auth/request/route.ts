import { type NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { canSendMail, getMailer, signInEmail } from "@/lib/auth/mailer";
import { LOGIN_TOKEN_TTL_MS, issueLoginToken, normalizeEmail } from "@/lib/auth/tokens";
import { appOrigin, isSameOrigin } from "@/lib/http/origin";
import { clientKey, rateLimit, signInEmailLimit } from "@/lib/ratelimit";
import { signInRequestSchema } from "@/lib/validation";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * POST /api/auth/request — email a single-use sign-in link.
 *
 * Always answers the same way whether or not the address has an account. A
 * different response for "no such user" turns this endpoint into a membership
 * oracle, and there is nothing to gain from one: accounts are created on first
 * successful sign-in, so both cases genuinely do the same thing.
 *
 * The anonymous `sessionId` travels with the request and is stored on the token
 * so that consuming it can adopt this browser's existing attempts and votes
 * (lib/auth/merge.ts). It is the caller's own localStorage uuid.
 */
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403, headers: NO_STORE });
  }
  if (!rateLimit(`auth:${clientKey(req)}`).ok) {
    return NextResponse.json({ error: "Too many sign-in attempts. Try again shortly." }, { status: 429, headers: NO_STORE });
  }

  const parsed = signInRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400, headers: NO_STORE });
  }
  const email = normalizeEmail(parsed.data.email);

  if (!canSendMail()) {
    return NextResponse.json(
      { error: "Sign-in email is not configured on this deployment.", code: "mail_unconfigured" },
      { status: 503, headers: NO_STORE },
    );
  }
  if (!signInEmailLimit(email).ok) {
    // Deliberately not silent: the person being emailed is the one protected,
    // and the requester needs to know why no new mail arrived.
    return NextResponse.json(
      { error: "That address has been sent several links recently. Check your inbox, or try again later." },
      { status: 429, headers: NO_STORE },
    );
  }

  const mailer = getMailer();
  try {
    const { token } = await issueLoginToken(prisma, { email, claimSessionId: parsed.data.sessionId ?? null });
    await mailer.send({
      to: email,
      subject: "Your Anvil sign-in link",
      // The only exit this token has. It is deliberately not held in a variable
      // that outlives this call, and never reaches the response below.
      text: signInEmail(
        `${appOrigin(req)}/api/auth/callback?token=${encodeURIComponent(token)}`,
        Math.round(LOGIN_TOKEN_TTL_MS / 60_000),
      ),
    });
  } catch {
    return NextResponse.json(
      { error: "Could not send the sign-in email. Try again shortly.", retryable: true },
      { status: 503, headers: NO_STORE },
    );
  }

  return NextResponse.json(
    {
      sent: true,
      expiresInMinutes: Math.round(LOGIN_TOKEN_TTL_MS / 60_000),
      // Where to go looking, not what to use. `delivery: "log"` says the link
      // went to the server's stdout — which only someone with the terminal can
      // read — and `canSendMail()` above makes that unreachable in production.
      // The link itself is never in this body: see lib/auth/mailer.ts.
      delivery: mailer.transport === "log" ? "log" : "email",
    },
    { headers: NO_STORE },
  );
}
