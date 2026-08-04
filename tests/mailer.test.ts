/**
 * Transport selection and the production guard.
 *
 * Small surface, but it decides whether a live credential gets written to
 * stdout, so the rules are worth pinning: an explicitly configured provider
 * always wins, and falling back to stdout is a development-only behaviour that
 * a production deployment must refuse rather than do quietly.
 */
import { afterEach, describe, expect, it } from "vitest";
import { canSendMail, mailTransport, signInEmail } from "../lib/auth/mailer";

const KEYS = ["RESEND_API_KEY", "SMTP_URL", "NODE_ENV"] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

/**
 * `process.env.NODE_ENV` is declared read-only, so the whole environment is
 * written through one widened view rather than casting at each call site.
 */
const env = process.env as Record<string, string | undefined>;

function set(patch: Partial<Record<(typeof KEYS)[number], string | undefined>>) {
  for (const key of KEYS) {
    if (!(key in patch)) continue;
    if (patch[key] === undefined) delete env[key];
    else env[key] = patch[key];
  }
}

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete env[key];
    else env[key] = saved[key];
  }
});

describe("transport selection", () => {
  it("prefers an explicitly configured provider over the fallback", () => {
    set({ RESEND_API_KEY: undefined, SMTP_URL: undefined });
    expect(mailTransport()).toBe("log");

    set({ SMTP_URL: "smtps://user:pass@smtp.example.com:465" });
    expect(mailTransport()).toBe("smtp");

    // Both configured: the API provider wins, so adding SMTP for a one-off
    // test cannot silently take over a working deployment.
    set({ RESEND_API_KEY: "re_test" });
    expect(mailTransport()).toBe("resend");
  });
});

describe("production guard", () => {
  it("refuses to fall back to stdout in production", () => {
    set({ RESEND_API_KEY: undefined, SMTP_URL: undefined, NODE_ENV: "production" });
    expect(canSendMail()).toBe(false);

    // With a real transport configured, production is fine.
    set({ SMTP_URL: "smtps://user:pass@smtp.example.com:465" });
    expect(canSendMail()).toBe(true);
  });

  it("allows the stdout fallback outside production", () => {
    set({ RESEND_API_KEY: undefined, SMTP_URL: undefined, NODE_ENV: "development" });
    expect(canSendMail()).toBe(true);
  });
});

describe("message body", () => {
  it("states the link's single use and lifetime, and reassures a non-requester", () => {
    const body = signInEmail("https://anvil.example/api/auth/callback?token=abc", 15);
    expect(body).toContain("https://anvil.example/api/auth/callback?token=abc");
    expect(body).toContain("works once");
    expect(body).toContain("15 minutes");
    expect(body).toMatch(/didn't ask for it/);
  });
});
