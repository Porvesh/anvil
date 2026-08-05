/**
 * Sending the sign-in link.
 *
 * One transactional email, three transports, resolved in this order:
 *
 * - **resend** — `RESEND_API_KEY`. Plain `fetch`, no SDK.
 * - **smtp** — `SMTP_URL`. Anything you already have credentials for: a
 *   provider account, a company relay, Mailtrap in development. Exists because
 *   requiring a signup with one specific SaaS to make sign-in work at all is a
 *   bad trade for a self-hostable app.
 * - **log** — the fallback. Writes the link to the server's own stdout, which
 *   a developer with a terminal can read and nobody else can.
 *
 * **A sign-in link leaves this process only through a transport.** It is never
 * returned to an HTTP caller, in any environment, for any reason. An earlier
 * version handed the link back in the response body when mail was unconfigured,
 * which made "verify you own this address" mean nothing: request a link for any
 * address, read it out of your own response, sign in as them. That it was gated
 * on NODE_ENV was not a defence — a container that forgets to set it, or a
 * preview deployment, turns the endpoint into account takeover for any address.
 * Possession of the inbox (or of the server's stdout) is the whole proof, so the
 * credential has to be structurally incapable of travelling any other way.
 */

export type MailTransport = "resend" | "smtp" | "log";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  transport: MailTransport;
  send(message: MailMessage): Promise<void>;
}

const DEFAULT_FROM = "Anvil <onboarding@resend.dev>";

/** Which transport the current environment resolves to (no side effects). */
export function mailTransport(): MailTransport {
  if (process.env.RESEND_API_KEY) return "resend";
  if (process.env.SMTP_URL) return "smtp";
  return "log";
}

/**
 * True when links may be sent at all.
 *
 * Writing a live credential to stdout is a development affordance, so in
 * production an unconfigured mail provider is a hard failure rather than a
 * silent fallback: sign-in is refused until someone configures a real one.
 */
export function canSendMail(): boolean {
  return mailTransport() !== "log" || process.env.NODE_ENV !== "production";
}

async function sendViaResend(message: MailMessage): Promise<void> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.AUTH_EMAIL_FROM || DEFAULT_FROM,
      to: [message.to],
      subject: message.subject,
      text: message.text,
    }),
  });

  if (!response.ok) {
    // The provider's body may echo the recipient; keep it out of the thrown
    // message so it cannot reach a log line that is not already about this user.
    throw new Error(`Mail provider rejected the request (${response.status})`);
  }
}

/**
 * SMTP, via nodemailer.
 *
 * Imported dynamically so the dependency is only loaded by deployments that
 * actually use it — a Resend or log deployment never pays for it. The
 * connection string carries everything, matching how DATABASE_URL already
 * works here, and `secure` is inferred from the scheme so `smtps://` gets
 * implicit TLS and `smtp://` upgrades with STARTTLS where offered.
 */
async function sendViaSmtp(message: MailMessage): Promise<void> {
  const { createTransport } = await import("nodemailer");
  const url = process.env.SMTP_URL!;
  const transport = createTransport(url);
  try {
    await transport.sendMail({
      from: process.env.AUTH_EMAIL_FROM || DEFAULT_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  } finally {
    // Sign-in is bursty and rare; holding a pool open between links buys
    // nothing and keeps a socket alive against the relay.
    transport.close();
  }
}

/**
 * The log transport, banner and all.
 *
 * Loud on purpose. A developer who cannot find the link should not conclude
 * that sign-in is broken, and an operator who sees this in a real deployment
 * should recognise it as a misconfiguration on sight.
 */
function sendViaLog(message: MailMessage): void {
  const banner = "─".repeat(64);
  // eslint-disable-next-line no-console -- this transport IS console output
  console.warn(
    [
      "",
      banner,
      "  ANVIL · no mail provider configured — DEVELOPMENT ONLY",
      `  A sign-in link for ${message.to} was written here instead of sent.`,
      "  Set RESEND_API_KEY or SMTP_URL to deliver real email.",
      banner,
      message.text,
      banner,
      "",
    ].join("\n"),
  );
}

const defaultMailer: Mailer = {
  get transport() {
    return mailTransport();
  },
  async send(message) {
    switch (mailTransport()) {
      case "resend":
        return sendViaResend(message);
      case "smtp":
        return sendViaSmtp(message);
      default:
        return sendViaLog(message);
    }
  },
};

let mailer: Mailer = defaultMailer;

export function getMailer(): Mailer {
  return mailer;
}

/**
 * Swap the transport. Exists for tests, which need to read the link they were
 * sent — the one thing the routes will never hand back.
 */
export function setMailer(next: Mailer | null): void {
  mailer = next ?? defaultMailer;
}

/** The email body. Plain text on purpose: it renders everywhere and cannot phish. */
export function signInEmail(link: string, expiresInMinutes: number): MailMessage["text"] {
  return [
    "Sign in to Anvil",
    "",
    link,
    "",
    `This link works once and expires in ${expiresInMinutes} minutes.`,
    "If you didn't ask for it, you can ignore this email — nothing was changed.",
  ].join("\n");
}
