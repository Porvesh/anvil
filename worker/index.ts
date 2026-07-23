/**
 * The generation worker (spec §14).
 *
 * No HTTP surface — it polls the job queue, generates, and writes results back.
 * It exists because generation needs two things a serverless request handler
 * can't give it: local `python3` for the execution oracle, and 200-300s to emit
 * a project twice. The tempting shortcut is to drop the oracle so generation
 * fits in a request; that would put unverified problems in front of a live
 * user, which is the worst possible place to drop a gate (INV-8).
 *
 * Deploy anywhere that runs a container with python3 on PATH. Run one or many —
 * claiming is atomic, so workers never collide (lib/worker/queue.ts).
 *
 *   npm run worker
 *   npm run worker -- --once     # drain the queue and exit (CI, local checks)
 */
import { PrismaClient } from "@prisma/client";
import { generateAndPersist } from "../lib/generation";
import { CLAIM_TIMEOUT_MS, IDLE_POLL_MS, claimJob, completeJob, requeueOrFail, setStatus } from "../lib/worker/queue";
import type { Difficulty, ProblemType } from "../lib/types";

const prisma = new PrismaClient();
const ONCE = process.argv.includes("--once");

let shuttingDown = false;

function log(msg: string) {
  console.log(`[worker ${new Date().toISOString()}] ${msg}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runOne(): Promise<boolean> {
  const job = await claimJob(prisma);
  if (!job) return false;

  log(`claimed ${job.id} (${job.type}/${job.difficulty}, attempt ${job.attempts + 1})`);

  // generateAndPersist reports null for every kind of giving-up, so the last
  // progress note is the only record of *why*. Without it the queue blames the
  // oracle for what may have been an auth error or an upstream outage, and the
  // reject-rate numbers from a batch run become fiction.
  let lastNote = "";

  try {
    await setStatus(prisma, job.id, "writing", { note: "writing the problem" });

    const result = await generateAndPersist(prisma, {
      type: job.type as ProblemType,
      difficulty: job.difficulty as Difficulty,
      jd: job.jd ?? undefined,
      jobId: job.id,
      // Progress notes double as the SSE payload: the stream route reads the
      // job row, so anything written here is what the waiting user sees.
      onProgress: (note) => {
        lastNote = note;
        void setStatus(prisma, job.id, "verifying", { note }).catch(() => {});
      },
    });

    if (!result) {
      const why = lastNote || "every attempt failed the oracle";
      await requeueOrFail(prisma, job, why);
      log(`${job.id}: gave up — ${why}`);
      return true;
    }

    await completeJob(prisma, job.id, { problemId: result.id });
    log(`${job.id}: banked "${result.title}" (${result.attempts} attempt(s), ${result.generatorModel})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await requeueOrFail(prisma, job, message);
    log(`${job.id}: ${message}`);
  }
  return true;
}

async function main() {
  log(`started (claim timeout ${CLAIM_TIMEOUT_MS / 60000}min, poll ${IDLE_POLL_MS}ms)${ONCE ? " [--once]" : ""}`);

  while (!shuttingDown) {
    const didWork = await runOne();
    if (didWork) continue;
    if (ONCE) break;
    await sleep(IDLE_POLL_MS);
  }

  log("stopped");
}

// Finish the job in flight rather than orphaning it — an abrupt exit leaves a
// row in `claimed` that nothing touches until the reclaim timeout expires.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(1);
    log(`${signal} — finishing current job, then exiting`);
    shuttingDown = true;
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
