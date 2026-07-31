/**
 * Offline bank-generation CLI (spec B2). Generates problems, runs the oracle,
 * and writes only the ones that pass into the shared bank. This is the
 * amortized cost — run it on your key, benefits every user.
 *
 * Usage:
 *   npm run generate:bank -- --type debug --count 3 --difficulty medium
 *   npm run generate:bank -- --type review --count 2 --topic "rate limiting"
 *   npm run generate:bank -- --type design --count 1
 *   npm run generate:bank -- --mix 20            # spread across type/difficulty
 *   npm run generate:bank -- --type debug --jd-file ./jd.txt
 *
 * Requires ANTHROPIC_API_KEY (loaded from .env by the npm script). The oracle
 * needs python3 on PATH.
 *
 * Cost: generation emits a whole project twice plus tests plus the key, so a
 * banked problem is roughly $1.50-3 at the current routing once rejected
 * attempts are counted. `--mix 60` is therefore a real spend — the run prints a
 * measured cost-per-banked-problem at the end so the next one can be estimated
 * rather than guessed.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import type { Difficulty, ProblemType } from "../lib/types";
import { generateAndPersist } from "../lib/generation";

const prisma = new PrismaClient();

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/**
 * A spread worth banking: debug-heavy because it's the mode with the strongest
 * oracle, but with enough review and design that the bank isn't one-note.
 * Difficulty skews medium — easy problems don't teach and hard ones discourage.
 */
const MIX: { type: ProblemType; difficulty: Difficulty }[] = [
  { type: "debug", difficulty: "easy" },
  { type: "debug", difficulty: "medium" },
  { type: "debug", difficulty: "medium" },
  { type: "debug", difficulty: "hard" },
  { type: "review", difficulty: "medium" },
  { type: "review", difficulty: "hard" },
  { type: "design", difficulty: "medium" },
];

interface Job {
  type: ProblemType;
  difficulty: Difficulty;
}

function plan(): Job[] {
  const mix = arg("mix");
  if (mix) {
    const total = parseInt(mix, 10);
    return Array.from({ length: total }, (_, i) => MIX[i % MIX.length]);
  }
  const type = (arg("type", "debug") ?? "debug") as ProblemType;
  const difficulty = (arg("difficulty", "medium") as Difficulty) ?? "medium";
  const count = parseInt(arg("count", "3")!, 10);
  return Array.from({ length: count }, () => ({ type, difficulty }));
}

async function main() {
  const topic = arg("topic");
  const jdFile = arg("jd-file");
  const jd = jdFile ? readFileSync(jdFile, "utf8") : arg("jd");
  const maxAttempts = parseInt(arg("max-attempts", "3")!, 10);
  const jobs = plan();

  const before = await prisma.problem.count();
  console.log(`Generating ${jobs.length} problem(s)${topic ? ` on "${topic}"` : ""}. Bank holds ${before}.\n`);

  let accepted = 0;
  let totalAttempts = 0;
  const startedAt = Date.now();

  for (const [i, job] of jobs.entries()) {
    const label = `#${String(i + 1).padStart(2)} ${job.type}/${job.difficulty}`;
    try {
      const result = await generateAndPersist(prisma, {
        ...job,
        topic,
        jd,
        maxAttempts,
        // Rejections are the interesting output of a batch run: they're how you
        // learn the oracle's real reject rate, and therefore the true cost per
        // *banked* problem rather than per generation call.
        onProgress: (msg) => console.log(`   ${label}  ${msg}`),
      });
      if (result) {
        accepted++;
        totalAttempts += result.attempts;
        console.log(
          `${label}  ✓ "${result.title.slice(0, 52)}" (q=${result.qualityScore.toFixed(2)}, ${result.attempts} attempt(s), ${result.generatorModel})`,
        );
      } else {
        totalAttempts += maxAttempts;
        console.log(`${label}  ✗ gave up after ${maxAttempts} attempts`);
      }
    } catch (err) {
      totalAttempts += 1;
      console.log(`${label}  ✗ error — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const total = await prisma.problem.count();
  const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(`\nAccepted ${accepted}/${jobs.length} in ${mins} min. Bank now holds ${total} problems.`);
  if (accepted > 0) {
    console.log(`Oracle reject rate: ${(1 - accepted / totalAttempts).toFixed(2)} — ${(totalAttempts / accepted).toFixed(1)} generation calls per banked problem.`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
