/**
 * Drop spent and expired sign-in tokens.
 *
 * `LoginToken` rows are consumed rather than deleted so a replayed link can be
 * reported as "already used" instead of "never existed", and so a login flow has
 * some operational history. Neither reason outlives the row by much, and the
 * table would otherwise grow forever with dead credentials.
 *
 * Safe to run on a schedule: it only removes rows that can no longer sign
 * anyone in — already consumed, or past their expiry.
 *
 *   npm run purge:tokens          # show what would be removed
 *   npm run purge:tokens -- --write
 */
import "../lib/loadEnv";
import { PrismaClient } from "@prisma/client";
import { purgeExpiredLoginTokens } from "../lib/auth/tokens";

const prisma = new PrismaClient();
const WRITE = process.argv.includes("--write");

async function main() {
  const now = new Date();
  const dead = await prisma.loginToken.count({
    where: { OR: [{ expiresAt: { lt: now } }, { consumedAt: { not: null } }] },
  });
  const live = await prisma.loginToken.count({
    where: { consumedAt: null, expiresAt: { gte: now } },
  });

  if (dead === 0) {
    console.log(`No dead sign-in tokens. ${live} still redeemable.`);
    return;
  }

  if (!WRITE) {
    console.log(`${dead} spent or expired token(s) would be removed; ${live} still redeemable. [dry run]`);
    console.log("Re-run with --write to remove them.");
    return;
  }

  const removed = await purgeExpiredLoginTokens(prisma, now);
  console.log(`Removed ${removed} dead sign-in token(s). ${live} still redeemable.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
