/**
 * Load `.env` into `process.env` for the CLI entrypoints.
 *
 * Next.js does this itself for the app, and Prisma does it for `DATABASE_URL`,
 * which is why the standalone scripts were the only place missing an API key —
 * a confusing failure mode, since `npm run dev` worked fine. Doing it in-process
 * (rather than relying on `node --env-file`) keeps the scripts working across
 * Node versions and shells.
 *
 * Import it first, before anything that reads a variable at module scope:
 *
 *   import "../lib/loadEnv";
 *   import { PrismaClient } from "@prisma/client";
 *
 * Existing environment variables always win, so CI secrets aren't overwritten
 * by a stray local file.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function parse(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip one matching pair of surrounding quotes, as dotenv does.
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadEnv(file = ".env"): void {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return;
  for (const [key, value] of Object.entries(parse(readFileSync(path, "utf8")))) {
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
    }
  }
}

loadEnv();
