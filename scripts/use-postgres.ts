/**
 * Flip the Prisma datasource between SQLite and Postgres (spec B6).
 *
 * Prisma won't take `provider` from an env var, and keeping two schema files
 * would mean maintaining every model twice — so this rewrites the datasource
 * block in place, leaving the models as the single source of truth.
 *
 *   npm run db:postgres        # switch to postgresql
 *   npm run db:postgres -- --sqlite
 *
 * After switching to Postgres:
 *   1. point DATABASE_URL at the database (pooled URL for the app, DIRECT_URL
 *      for migrations — Prisma + serverless exhausts pools fast)
 *   2. rm -rf prisma/migrations   (the SQL is dialect-specific; regenerate it)
 *   3. npx prisma migrate dev --name init
 *   4. npm run seed
 *
 * Two things stop being problems on Postgres: `DEFAULT '[]'` on a Json column
 * is emitted correctly (see migrations/20260731013500_fix_tags_default), and
 * the worker's claim switches to FOR UPDATE SKIP LOCKED automatically, keyed
 * off the DATABASE_URL scheme (lib/worker/queue.ts).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SCHEMA = resolve(process.cwd(), "prisma/schema.prisma");
const toSqlite = process.argv.includes("--sqlite");
const provider = toSqlite ? "sqlite" : "postgresql";

const schema = readFileSync(SCHEMA, "utf8");
const datasource = /datasource\s+db\s*\{[^}]*\}/m;

if (!datasource.test(schema)) {
  console.error("Could not find the datasource block in prisma/schema.prisma.");
  process.exit(1);
}

const current = schema.match(/provider\s*=\s*"(\w+)"/)?.[1];
if (current === provider) {
  console.log(`Already on ${provider}. Nothing to do.`);
  process.exit(0);
}

const block = toSqlite
  ? `datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}`
  : `datasource db {
  provider  = "postgresql"
  // Pooled connection for the app. Prisma + serverless exhausts a direct
  // connection pool quickly, so everything except migrations goes through it.
  url       = env("DATABASE_URL")
  // Direct connection, used by \`prisma migrate\` only.
  directUrl = env("DIRECT_URL")
}`;

writeFileSync(SCHEMA, schema.replace(datasource, block));

console.log(`Switched prisma/schema.prisma to ${provider}.`);
if (!toSqlite) {
  console.log(
    [
      "",
      "Next:",
      "  1. set DATABASE_URL (pooled) and DIRECT_URL in .env",
      "  2. rm -rf prisma/migrations      # SQL is dialect-specific",
      "  3. npx prisma migrate dev --name init",
      "  4. npm run seed",
    ].join("\n"),
  );
}
