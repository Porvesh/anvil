/**
 * The sign-in endpoints, driven in process.
 *
 * The pieces here are the ones that only exist at the HTTP boundary and so are
 * invisible to the token and merge tests: the CSRF origin check, the cookie
 * attributes, where each failure redirects, and the membership-oracle property
 * (an unknown address must be answered exactly like a known one).
 *
 * No server is started — the route handlers are ordinary functions of a
 * `NextRequest`, which is also the cheapest way to assert on `Set-Cookie`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { PrismaClient } from "@prisma/client";
import { POST as requestLink } from "../app/api/auth/request/route";
import { GET as callback } from "../app/api/auth/callback/route";
import { DELETE as signOut, GET as readSession } from "../app/api/auth/session/route";
import { AUTH_COOKIE, sealAuthSession } from "../lib/auth/session";
import { setRateLimitStore } from "../lib/ratelimit";
import { setMailer, type MailMessage } from "../lib/auth/mailer";

const prisma = new PrismaClient();
const ORIGIN = "http://localhost:3000";
const EMAIL = "routes@routes.test";

const previousSecret = process.env.BYOK_ENCRYPTION_KEY;

/**
 * Rate limiting is process-global and these tests share it, so each one gets a
 * fresh counter — otherwise the fortieth request in the file fails for reasons
 * that have nothing to do with what it is testing.
 */
function resetRateLimits() {
  const counters = new Map<string, { count: number; resetAt: number }>();
  setRateLimitStore({
    bump(key, windowMs, now) {
      const existing = counters.get(key);
      if (!existing || now >= existing.resetAt) {
        const fresh = { count: 1, resetAt: now + windowMs };
        counters.set(key, fresh);
        return fresh;
      }
      existing.count += 1;
      return existing;
    },
  });
}

function post(body: unknown, origin: string | null = ORIGIN) {
  return new NextRequest(`${ORIGIN}/api/auth/request`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
      host: "localhost:3000",
    },
    body: JSON.stringify(body),
  });
}

/**
 * Every message the routes "sent" during a test.
 *
 * The link is readable here and nowhere else, which is the point: reading it
 * requires standing where the mail transport stands, exactly as it does in
 * production.
 */
const outbox: MailMessage[] = [];

/** Ask for a link and read it out of the delivered message. */
async function issueLink(email: string, sessionId?: string): Promise<string> {
  const before = outbox.length;
  const response = await requestLink(post({ email, sessionId }));
  const data = await response.json();
  expect(response.status, JSON.stringify(data)).toBe(200);
  expect(outbox.length, "a message should have been delivered").toBe(before + 1);
  const link = outbox[outbox.length - 1].text.match(/https?:\/\/\S+/)?.[0];
  expect(link, "the delivered message should contain a link").toBeTruthy();
  return link!;
}

function visit(url: string) {
  return new NextRequest(url, { headers: { host: "localhost:3000" } });
}

beforeEach(() => {
  process.env.BYOK_ENCRYPTION_KEY = "test-only-byok-encryption-key-at-least-32-chars";
  resetRateLimits();
  outbox.length = 0;
  setMailer({
    transport: "resend",
    async send(message) {
      outbox.push(message);
    },
  });
});

afterEach(async () => {
  await prisma.loginToken.deleteMany({ where: { email: { contains: "@routes.test" } } });
  await prisma.user.deleteMany({ where: { email: { contains: "@routes.test" } } });
});

afterAll(async () => {
  setMailer(null);
  if (previousSecret === undefined) delete process.env.BYOK_ENCRYPTION_KEY;
  else process.env.BYOK_ENCRYPTION_KEY = previousSecret;
  await prisma.$disconnect();
});

describe("POST /api/auth/request", () => {
  it("rejects a cross-origin request before doing any work", async () => {
    const response = await requestLink(post({ email: EMAIL }, "https://evil.test"));
    expect(response.status).toBe(403);
    expect(await prisma.loginToken.count({ where: { email: EMAIL } })).toBe(0);
  });

  it("rejects a request with no origin header at all", async () => {
    expect((await requestLink(post({ email: EMAIL }, null))).status).toBe(403);
  });

  it("rejects a malformed address", async () => {
    expect((await requestLink(post({ email: "not-an-email" }))).status).toBe(400);
  });

  it("answers identically for a known and an unknown address", async () => {
    // Anything that distinguishes the two turns this into a membership oracle.
    const unknown = await requestLink(post({ email: "nobody@routes.test" }));
    const unknownBody = await unknown.json();

    await prisma.user.create({ data: { email: EMAIL } });
    const known = await requestLink(post({ email: EMAIL }));
    const knownBody = await known.json();

    expect(known.status).toBe(unknown.status);
    expect(Object.keys(knownBody).sort()).toEqual(Object.keys(unknownBody).sort());
    expect(knownBody.sent).toBe(unknownBody.sent);
  });

  it("never returns the sign-in credential to the caller", async () => {
    // The bug this pins: an earlier version handed the link back in the body
    // when mail was unconfigured. That makes "prove you own this address"
    // meaningless — request a link for anyone, read it out of your own
    // response, sign in as them — and NODE_ENV is far too weak a thing to hang
    // account security on. The token now leaves the process only by transport.
    const response = await requestLink(post({ email: EMAIL }));
    const raw = await response.text();
    const delivered = outbox[0].text.match(/token=([^\s&]+)/)![1];

    expect(delivered).toBeTruthy();
    expect(raw).not.toContain(delivered);
    expect(raw).not.toContain("token=");
    expect(raw).not.toMatch(/https?:\/\//);
    // What it may say is where to look, which is not a credential.
    expect(JSON.parse(raw)).toEqual({ sent: true, expiresInMinutes: 15, delivery: "email" });
  });

  it("reports log delivery without leaking the link when mail is unconfigured", async () => {
    setMailer({
      transport: "log",
      async send(message) {
        outbox.push(message);
      },
    });

    const response = await requestLink(post({ email: EMAIL }));
    const raw = await response.text();

    expect(JSON.parse(raw).delivery).toBe("log");
    expect(raw).not.toContain(outbox[0].text.match(/token=([^\s&]+)/)![1]);
  });

  it("throttles repeated requests for one address", async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await requestLink(post({ email: EMAIL }))).status).toBe(200);
    }
    expect((await requestLink(post({ email: EMAIL }))).status).toBe(429);
  });
});

describe("GET /api/auth/callback", () => {
  it("signs in, sets a hardened cookie, and lands on history", async () => {
    const link = await issueLink(EMAIL, "browser-session-1");
    const response = await callback(visit(link));

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/history");
    expect(location.searchParams.get("status")).toBe("ok");

    const cookie = response.cookies.get(AUTH_COOKIE)!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("lax");
    expect(cookie.path).toBe("/");
    // The account is identified by an opaque sealed value, not the address.
    expect(cookie.value).not.toContain(EMAIL);

    const user = await prisma.user.findUnique({ where: { email: EMAIL } });
    expect(user?.lastLoginAt).toBeTruthy();
  });

  it("creates the account on first sign-in and reuses it after", async () => {
    await callback(visit(await issueLink(EMAIL)));
    const first = await prisma.user.findUnique({ where: { email: EMAIL } });

    await callback(visit(await issueLink(EMAIL)));
    expect(await prisma.user.count({ where: { email: EMAIL } })).toBe(1);
    expect((await prisma.user.findUnique({ where: { email: EMAIL } }))?.id).toBe(first?.id);
  });

  it("reports each failure distinguishably, and sets no cookie", async () => {
    const cases: [string, string][] = [
      [`${ORIGIN}/api/auth/callback`, "invalid"],
      [`${ORIGIN}/api/auth/callback?token=never-issued`, "invalid"],
    ];
    for (const [url, expected] of cases) {
      const response = await callback(visit(url));
      const location = new URL(response.headers.get("location")!);
      expect(location.pathname).toBe("/signin");
      expect(location.searchParams.get("status")).toBe(expected);
      expect(response.cookies.get(AUTH_COOKIE)).toBeUndefined();
    }

    // A redeemed link is reported as used rather than as unrecognised.
    const link = await issueLink(EMAIL);
    await callback(visit(link));
    const replay = await callback(visit(link));
    expect(new URL(replay.headers.get("location")!).searchParams.get("status")).toBe("used");
    expect(replay.cookies.get(AUTH_COOKIE)).toBeUndefined();
  });

  it("adopts the requesting browser's attempts", async () => {
    const problem = await prisma.problem.create({
      data: { id: "test-routes-problem", type: "debug", difficulty: "easy", title: "t", prompt: "p", answerKey: [], tags: [] },
    });
    await prisma.attempt.create({ data: { problemId: problem.id, sessionId: "browser-session-2", submission: {} } });

    const response = await callback(visit(await issueLink(EMAIL, "browser-session-2")));
    expect(new URL(response.headers.get("location")!).searchParams.get("merged")).toBe("1");

    const user = await prisma.user.findUnique({ where: { email: EMAIL } });
    expect(await prisma.attempt.count({ where: { userId: user!.id } })).toBe(1);

    await prisma.attempt.deleteMany({ where: { problemId: problem.id } });
    await prisma.problem.delete({ where: { id: problem.id } });
  });
});

describe("/api/auth/session", () => {
  function withSession(method: "GET" | "DELETE", cookie?: string, origin: string | null = ORIGIN) {
    return new NextRequest(`${ORIGIN}/api/auth/session`, {
      method,
      headers: {
        host: "localhost:3000",
        ...(origin ? { origin } : {}),
        ...(cookie ? { cookie: `${AUTH_COOKIE}=${cookie}` } : {}),
      },
    });
  }

  it("reports the signed-in account and nothing else", async () => {
    const sealed = sealAuthSession({ userId: "user_1", email: EMAIL });
    // Exhaustive on purpose: the session payload is the one thing every client
    // reads, so a new field has to be added here deliberately rather than
    // slipping out. `userId` in particular stays server-side.
    expect(await (await readSession(withSession("GET", sealed.value))).json()).toEqual({
      signedIn: true,
      email: EMAIL,
      // No mail transport is configured under test, so sign-in is not offered.
      signInAvailable: false,
    });
    expect(await (await readSession(withSession("GET"))).json()).toEqual({
      signedIn: false,
      email: null,
      signInAvailable: false,
    });
  });

  it("offers sign-in once a mail transport is configured", async () => {
    // The UI shows "coming soon" off this flag, so it must follow the transport
    // rather than a separate switch someone has to remember to flip.
    process.env.RESEND_API_KEY = "re_test_key";
    try {
      expect(await (await readSession(withSession("GET"))).json()).toEqual({
        signedIn: false,
        email: null,
        signInAvailable: true,
      });
    } finally {
      delete process.env.RESEND_API_KEY;
    }
  });

  it("expires the cookie on sign-out, and refuses to do so cross-origin", async () => {
    const sealed = sealAuthSession({ userId: "user_1", email: EMAIL });

    const rejected = await signOut(withSession("DELETE", sealed.value, "https://evil.test"));
    expect(rejected.status).toBe(403);
    expect(rejected.cookies.get(AUTH_COOKIE)).toBeUndefined();

    const cleared = await signOut(withSession("DELETE", sealed.value));
    expect(cleared.status).toBe(200);
    expect(cleared.cookies.get(AUTH_COOKIE)).toMatchObject({ value: "", maxAge: 0 });
  });
});
