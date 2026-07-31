/**
 * Clear pasted job descriptions retained on older problem rows (spec B9).
 *
 * Generation no longer stores the JD, and completed jobs wipe theirs — but rows
 * banked before that still hold one, and a JD can carry a real company's
 * internal role details into a shared bank. This is the one-time cleanup for
 * that history.
 *
 * Destructive and irreversible, so it's a separate opt-in script rather than a
 * migration: dry by default, and it only touches `jdContext`.
 *
 *   npm run purge:jds          # show what would be cleared
 *   npm run purge:jds -- --write
 */
import "../lib/loadEnv";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const WRITE = process.argv.includes("--write");

async function main() {
  const rows = await prisma.problem.findMany({
    where: { NOT: { jdContext: null } },
    select: { id: true, title: true, jdContext: true },
  });

  if (rows.length === 0) {
    console.log("No retained job descriptions. Nothing to do.");
    return;
  }

  console.log(`${rows.length} problem(s) still hold a pasted JD${WRITE ? " [CLEARING]" : " [dry run]"}:\n`);
  for (const row of rows) {
    const preview = (row.jdContext ?? "").replace(/\s+/g, " ").slice(0, 60);
    console.log(`  ${row.title.slice(0, 46).padEnd(46)} ${preview}…`);
  }

  if (!WRITE) {
    console.log("\nDry run — re-run with --write to clear them.");
    return;
  }

  const { count } = await prisma.problem.updateMany({
    where: { NOT: { jdContext: null } },
    data: { jdContext: null },
  });
  console.log(`\nCleared ${count}. The problems themselves are untouched.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
