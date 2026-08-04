/**
 * Outcomes of clicking a sign-in link, and how each is explained.
 *
 * The callback route can only redirect with a short code, so the wording lives
 * here — shared by the sign-in page and the history banner, and typed so a
 * route cannot redirect with a status nothing knows how to render.
 */

export const SIGN_IN_STATUSES = ["ok", "invalid", "expired", "used", "throttled"] as const;
export type SignInStatus = (typeof SIGN_IN_STATUSES)[number];

export function isSignInStatus(value: unknown): value is SignInStatus {
  return typeof value === "string" && (SIGN_IN_STATUSES as readonly string[]).includes(value);
}

export interface StatusMessage {
  tone: "good" | "bad";
  title: string;
  detail: string;
}

/**
 * Every failure says what to do next, because every one of them is recoverable
 * by requesting another link — the user does not need to know which of the four
 * it was, only that the form below them fixes it.
 */
export const SIGN_IN_MESSAGES: Record<SignInStatus, StatusMessage> = {
  ok: {
    tone: "good",
    title: "You're signed in",
    detail: "This browser's existing attempts and ratings have been added to your account.",
  },
  invalid: {
    tone: "bad",
    title: "That sign-in link isn't valid",
    detail: "It may have been truncated by your mail client, or replaced by a newer one. Request another below.",
  },
  expired: {
    tone: "bad",
    title: "That link has expired",
    detail: "Sign-in links last fifteen minutes. Request a fresh one below.",
  },
  used: {
    tone: "bad",
    title: "That link has already been used",
    detail: "Each link signs in once. If this isn't your browser, request a new link below.",
  },
  throttled: {
    tone: "bad",
    title: "Too many attempts",
    detail: "Wait a minute, then try the link again or request a new one.",
  },
};
