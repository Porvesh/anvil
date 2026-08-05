/**
 * Send yourself a test email through whatever transport is configured.
 *
 * "The email doesn't send" has several very different causes — no provider
 * configured, a rejected key, a relay refusing the From address, a message
 * accepted and then filed as spam — and none of them are distinguishable from
 * inside the sign-in form, which can only say that something went wrong. This
 * exercises the transport on its own and prints what actually happened.
 *
 * It deliberately does not create a token or touch the database: this answers
 * "can this deployment send mail at all", nothing else.
 *
 *   npm run mail:test -- you@example.com
 */
import "../lib/loadEnv";
import { getMailer, mailTransport } from "../lib/auth/mailer";

const TRANSPORT_HINT: Record<string, string> = {
  resend: "RESEND_API_KEY is set",
  smtp: "SMTP_URL is set",
  log: "no provider configured — nothing will be delivered",
};

async function main() {
  const to = process.argv.slice(2).find((arg) => arg.includes("@"));
  if (!to) {
    console.error("Usage: npm run mail:test -- you@example.com");
    process.exit(1);
  }

  const transport = mailTransport();
  console.log(`Transport: ${transport} (${TRANSPORT_HINT[transport]})`);
  console.log(`From:      ${process.env.AUTH_EMAIL_FROM || "(default)"}`);
  console.log(`To:        ${to}\n`);

  if (transport === "log") {
    console.log("Sign-in would still work locally — the link goes to the dev server's terminal.");
    console.log("To deliver real email, set one of:\n");
    console.log("  RESEND_API_KEY=re_...                             # https://resend.com/api-keys");
    console.log("  SMTP_URL=smtps://user:pass@smtp.example.com:465   # any account you already have");
    console.log('  AUTH_EMAIL_FROM="Anvil <no-reply@your-domain>"    # required by most relays\n');
  }

  try {
    await getMailer().send({
      to,
      subject: "Anvil mail test",
      text: "If you are reading this, Anvil can deliver sign-in links to this address.",
    });
  } catch (error) {
    console.error(`\n✗ Send failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error("\nCommon causes: an unverified sending domain, a From address the relay");
    console.error("won't accept, or a provider key without send permission.");
    process.exit(1);
  }

  if (transport !== "log") {
    console.log("✓ The transport accepted the message.");
    console.log("  Check the inbox — and the spam folder, which is where a new sending");
    console.log("  domain's first messages usually land.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
