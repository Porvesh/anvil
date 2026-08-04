import { type NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, authCookieOptions, readAuthSession } from "@/lib/auth/session";
import { mailTransport } from "@/lib/auth/mailer";
import { isSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/auth/session — who, if anyone, this browser is signed in as.
 *
 * Also reports whether sign-in is offered at all. Accounts depend on delivering
 * an email, so a deployment with no mail transport configured cannot honestly
 * present the form: the link would go to a server log the visitor cannot read.
 * The UI shows "coming soon" instead, and starts working the moment a transport
 * is configured — there is no separate flag to remember to flip.
 */
export async function GET(req: NextRequest) {
  const session = readAuthSession(req);
  return NextResponse.json(
    {
      signedIn: Boolean(session),
      email: session?.email ?? null,
      signInAvailable: mailTransport() !== "log",
    },
    { headers: NO_STORE },
  );
}

/**
 * DELETE /api/auth/session — sign out.
 *
 * Clears the cookie only. The anonymous `sessionId` in localStorage is left
 * alone so the browser keeps working, but it no longer reaches the account's
 * rows: reads by an anonymous caller filter on `userId: null` (lib/auth/identity.ts).
 */
export async function DELETE(req: NextRequest) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403, headers: NO_STORE });
  }
  const response = NextResponse.json({ signedIn: false, email: null }, { headers: NO_STORE });
  response.cookies.set(AUTH_COOKIE, "", authCookieOptions(req, 0));
  return response;
}
