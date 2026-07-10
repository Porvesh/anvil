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
import type { Difficulty, ProblemType } from "../lib/types";
import { generateDebug, generateReview, verifyReview } from "../lib/generation/generate";
import { selfCheckDebug } from "../lib/generation/selfcheck";

const prisma = new PrismaClient();

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const type = (arg("type", "debug") as ProblemType) ?? "debug";
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
    let saved = false;
    for (let attempt = 1; attempt <= maxAttempts && !saved; attempt++) {
      const tag = `#${n} attempt ${attempt}/${maxAttempts}`;
      try {
        if (type === "debug") {
          const p = await generateDebug(difficulty, topic, jd);
          const suite = { setup: p.setup, cases: p.cases };
          const check = await selfCheckDebug(p.correctCode, p.buggyCode, suite);
          if (!check.ok) {
            console.log(`  ${tag}: rejected — ${check.reason}`);
            continue;
          }
          await prisma.problem.create({
            data: {
              type: "debug",
              language: "python",
              difficulty,
              title: p.title,
              prompt: p.prompt,
              jdContext: jd ?? null,
              starterCode: p.buggyCode,
              testSuite: suite as object,
              answerKey: p.answerKey as unknown as object,
              qualityScore: check.qualityScore,
              source: "generated",
            },
          });
          console.log(`  ${tag}: ✓ saved "${p.title}" — ${check.reason} (q=${check.qualityScore.toFixed(2)})`);
          saved = true;
        } else {
          const p = await generateReview(difficulty, topic, jd);
          const check = await verifyReview(p);
          if (!check.ok) {
            console.log(`  ${tag}: rejected — ${check.reason}`);
            continue;
          }
          await prisma.problem.create({
            data: {
              type: "review",
              language: "python",
              difficulty,
              title: p.title,
              prompt: p.prompt,
              jdContext: jd ?? null,
              diff: p.diff as object,
              prMeta: p.prMeta as object,
              answerKey: p.answerKey as unknown as object,
              qualityScore: check.qualityScore,
              source: "generated",
            },
          });
          console.log(`  ${tag}: ✓ saved "${p.title}" — ${check.reason} (q=${check.qualityScore.toFixed(2)})`);
          saved = true;
        }
      } catch (err) {
        console.log(`  ${tag}: error — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (saved) accepted++;
    else console.log(`  #${n}: gave up after ${maxAttempts} attempts.`);
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
