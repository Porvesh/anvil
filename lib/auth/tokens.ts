/**
 * Single-use sign-in tokens (the "magic link").
 *
 * There are no passwords in Anvil, so this is the whole credential story: prove
 * you can read an inbox, get a session. Three properties matter, and each is
 * enforced here rather than by convention at the call site:
 *
 * 1. **Only a hash is stored.** The emailed token is 32 random bytes; the
 *    database holds its SHA-256. A leaked table yields no working links.
 *    (A slow KDF buys nothing here: the input is already high-entropy, so
 *    there is no dictionary to run.)
 * 2. **Consumption is atomic.** `consume` is a conditional update, so two
 *    parallel clicks on the same link produce exactly one session.
 * 3. **Links expire fast.** Fifteen minutes is comfortable for a real inbox and
 *    short enough that a forwarded email stops working.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Callers hand this to the mailer; only its hash is ever persisted. */
export function generateLoginToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashLoginToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Emails are the account identity, so they compare case- and space-insensitively. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface IssuedToken {
  token: string;
  expiresAt: Date;
}

/**
 * Mint a link for `email`, remembering which anonymous browser asked for it.
 *
 * Existing unconsumed tokens for the address are invalidated first: a user who
 * clicks "send again" expects the newest mail to be the one that works, and it
 * keeps at most one live credential per address.
 */
export async function issueLoginToken(
  prisma: PrismaClient,
  { email, claimSessionId, now = new Date() }: { email: string; claimSessionId?: string | null; now?: Date },
): Promise<IssuedToken> {
  const normalized = normalizeEmail(email);
  const token = generateLoginToken();
  const expiresAt = new Date(now.getTime() + LOGIN_TOKEN_TTL_MS);
  const user = await prisma.user.findUnique({ where: { email: normalized }, select: { id: true } });

  await prisma.$transaction([
    prisma.loginToken.deleteMany({ where: { email: normalized, consumedAt: null } }),
    prisma.loginToken.create({
      data: {
        tokenHash: hashLoginToken(token),
        email: normalized,
        userId: user?.id ?? null,
        claimSessionId: claimSessionId ?? null,
        expiresAt,
      },
    }),
  ]);

  return { token, expiresAt };
}

export type ConsumeResult =
  | { ok: true; email: string; userId: string | null; claimSessionId: string | null }
  | { ok: false; reason: "invalid" | "expired" | "used" };

/**
 * Redeem a token exactly once.
 *
 * The conditional `updateMany` is the concurrency control: whichever request
 * flips `consumedAt` from null wins, and the loser is told the link was already
 * used rather than being handed a second session. The follow-up read only
 * distinguishes *why* a miss happened, for the message shown to the user.
 */
export async function consumeLoginToken(
  prisma: PrismaClient,
  token: string,
  now = new Date(),
): Promise<ConsumeResult> {
  const tokenHash = hashLoginToken(token);

  const claimed = await prisma.loginToken.updateMany({
    where: { tokenHash, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });

  const row = await prisma.loginToken.findUnique({ where: { tokenHash } });
  if (claimed.count !== 1 || !row) {
    if (!row) return { ok: false, reason: "invalid" };
    return { ok: false, reason: row.consumedAt ? "used" : "expired" };
  }

  return { ok: true, email: row.email, userId: row.userId, claimSessionId: row.claimSessionId };
}

/**
 * Constant-time equality for tokens compared outside the database.
 *
 * Not used by `consume` (an indexed hash lookup is already constant-ish and the
 * token never leaves this process in plaintext), but exported so any future
 * comparison path cannot accidentally introduce a timing oracle with `===`.
 */
export function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Housekeeping for the maintenance script: drop dead rows. */
export async function purgeExpiredLoginTokens(prisma: PrismaClient, now = new Date()): Promise<number> {
  const { count } = await prisma.loginToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: now } }, { consumedAt: { not: null } }] },
  });
  return count;
}
