/**
 * Offline bank-generation CLI (spec §11, §16 v1). Generates problems, runs the
 * self-check, and writes only the ones that pass into the shared bank. This is
 * the amortized one-time cost — run it on your key, benefits every user.
 *
 * Usage:
 *   npm run generate:bank -- --type debug --count 3 --difficulty medium
 *   npm run generate:bank -- --type review --count 2 --topic "rate limiting"
 *   npm run generate:bank -- --type debug --jd-file ./jd.txt
 *
 * Requires ANTHROPIC_API_KEY (from .env). Debug self-check needs python3.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import type { Difficulty } from "../lib/types";
import { generateAndPersist } from "../lib/generation";

const prisma = new PrismaClient();

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const type = (arg("type", "debug") ?? "debug") as "debug" | "review" | "design";
  const count = parseInt(arg("count", "3")!, 10);
  const difficulty = (arg("difficulty", "medium") as Difficulty) ?? "medium";
  const topic = arg("topic");
  const jdFile = arg("jd-file");
  const jd = jdFile ? readFileSync(jdFile, "utf8") : arg("jd");
  const maxAttempts = parseInt(arg("max-attempts", "3")!, 10);

  if (type === "design") {
    console.error("Design generation is phase 2 — not supported yet.");
    process.exit(1);
  }

  console.log(`Generating ${count} ${difficulty} ${type} problem(s)${topic ? ` on "${topic}"` : ""}…\n`);
  let accepted = 0;

  for (let n = 1; n <= count; n++) {
    try {
      const result = await generateAndPersist(prisma, { type, difficulty, topic, jd, maxAttempts });
      if (result) {
        accepted++;
        console.log(`  #${n}: ✓ saved "${result.title}" (q=${result.qualityScore.toFixed(2)}, ${result.attempts} attempt(s))`);
      } else {
        console.log(`  #${n}: gave up after ${maxAttempts} attempts (failed self-check).`);
      }
    } catch (err) {
      console.log(`  #${n}: error — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const total = await prisma.problem.count();
  console.log(`\nAccepted ${accepted}/${count}. Bank now holds ${total} problems.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
