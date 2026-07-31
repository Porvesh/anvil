/**
 * The generation job queue (spec §10, §14).
 *
 * Postgres is the queue. `SELECT … FOR UPDATE SKIP LOCKED` is a perfectly good
 * queue at this volume and costs zero new services; Redis would buy a push
 * instead of a poll, which isn't worth a dependency yet.
 *
 * Claiming is raw SQL because Prisma's query API can't express SKIP LOCKED —
 * and it's dialect-aware because local dev runs SQLite, where SKIP LOCKED
 * doesn't exist (and isn't needed: SQLite serializes writers anyway). Keeping
 * both paths means the worker is runnable locally instead of only in prod,
 * which is the difference between a tested worker and a hopeful one.
 */
import type { GenerationJob, PrismaClient } from "@prisma/client";

/** A job claimed but not finished within this window is presumed orphaned. */
export const CLAIM_TIMEOUT_MS = 15 * 60_000;

/** How long the worker sleeps when the queue is empty. */
export const IDLE_POLL_MS = 2_000;

/**
 * Backoff before a requeued job may be claimed again, doubling per attempt.
 *
 * Without this a worker draining the queue retries a failing job as fast as it
 * can loop — an upstream blip lasting one second burns the entire attempt
 * budget in milliseconds and the user's job is marked permanently failed for a
 * reason that had already resolved.
 */
export const RETRY_BACKOFF_MS = 30_000;

/** Terminal and in-flight states. Strings, not an enum, for schema portability. */
export type JobStatus = "pending" | "claimed" | "writing" | "verifying" | "done" | "failed";

function isPostgres(): boolean {
  return (process.env.DATABASE_URL ?? "").startsWith("postgres");
}

/**
 * Atomically take the oldest pending job, or null if there's nothing to do.
 *
 * Both dialects mark the row `claimed` in the same statement that selects it,
 * so two workers can never take the same job — on Postgres via row locks that
 * other workers skip rather than block on, on SQLite via the write lock.
 */
export async function claimJob(prisma: PrismaClient): Promise<GenerationJob | null> {
  const staleBefore = new Date(Date.now() - CLAIM_TIMEOUT_MS);

  if (isPostgres()) {
    const rows = await prisma.$queryRaw<GenerationJob[]>`
      UPDATE "GenerationJob"
      SET status = 'claimed', "claimedAt" = NOW(), "updatedAt" = NOW()
      WHERE id = (
        SELECT id FROM "GenerationJob"
        WHERE (
                status = 'pending'
                AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW())
              )
           OR (status IN ('claimed', 'writing', 'verifying') AND "claimedAt" < ${staleBefore})
        ORDER BY "createdAt"
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *`;
    return rows[0] ?? null;
  }

  // SQLite: no SKIP LOCKED, but writers are serialized, so a transaction that
  // reads-then-updates is already exclusive.
  return prisma.$transaction(async (tx) => {
    const next = await tx.generationJob.findFirst({
      where: {
        OR: [
          {
            status: "pending",
            OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
          },
          { status: { in: ["claimed", "writing", "verifying"] }, claimedAt: { lt: staleBefore } },
        ],
      },
      orderBy: { createdAt: "asc" },
    });
    if (!next) return null;
    return tx.generationJob.update({
      where: { id: next.id },
      data: { status: "claimed", claimedAt: new Date() },
    });
  });
}

/** Record a phase transition. `note` is what the SSE stream shows the user. */
export async function setStatus(
  prisma: PrismaClient,
  id: string,
  status: JobStatus,
  data: { note?: string; problemId?: string; error?: string } = {},
): Promise<void> {
  await prisma.generationJob.update({ where: { id }, data: { status, ...data } });
}

/**
 * Finish a job, successfully or not, and drop the pasted JD (INV-12).
 *
 * The JD is the one genuinely sensitive field in the system: it can carry a
 * real company's internal role details, and it has done its job the moment
 * generation finishes. Clearing it here rather than keeping it "just in case"
 * is the retention decision — the problem it produced is already tagged, which
 * is all the bank needs.
 */
export async function completeJob(
  prisma: PrismaClient,
  id: string,
  outcome: { problemId: string } | { error: string },
): Promise<void> {
  await prisma.generationJob.update({
    where: { id },
    data: {
      ...("problemId" in outcome
        ? { status: "done", problemId: outcome.problemId, note: null }
        : { status: "failed", error: outcome.error }),
      jd: null,
    },
  });
}

/** Put a failed-but-retryable job back, or fail it for good once out of budget. */
export async function requeueOrFail(
  prisma: PrismaClient,
  job: GenerationJob,
  error: string,
  maxAttempts = 3,
): Promise<void> {
  const attempts = job.attempts + 1;
  if (attempts >= maxAttempts) {
    await completeJob(prisma, job.id, { error });
    return;
  }
  // Exponential backoff, so a job that fails because something upstream is
  // briefly unavailable gets its remaining attempts spread over minutes rather
  // than spent in a single tight loop.
  const backoff = RETRY_BACKOFF_MS * 2 ** (attempts - 1);
  await prisma.generationJob.update({
    where: { id: job.id },
    data: {
      status: "pending",
      attempts,
      claimedAt: null,
      nextAttemptAt: new Date(Date.now() + backoff),
      note: `retrying in ${Math.round(backoff / 1000)}s after: ${error}`,
    },
  });
}
