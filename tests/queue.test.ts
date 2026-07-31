/**
 * Queue semantics against the real database (spec §14).
 *
 * These run against the dev SQLite file rather than a mock, because the whole
 * point of claimJob is what the *database* does under concurrency — a mocked
 * version would only test that the mock returns what it was told to.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { CLAIM_TIMEOUT_MS, claimJob, completeJob, requeueOrFail, setStatus } from "../lib/worker/queue";

const prisma = new PrismaClient();
const SESSION = "test-queue-session";

async function enqueue(overrides: Record<string, unknown> = {}) {
  return prisma.generationJob.create({
    data: { sessionId: SESSION, jd: "CONFIDENTIAL — Acme Corp payments role", type: "debug", ...overrides },
  });
}

beforeEach(async () => {
  await prisma.generationJob.deleteMany({ where: { sessionId: SESSION } });
});

afterAll(async () => {
  await prisma.generationJob.deleteMany({ where: { sessionId: SESSION } });
  await prisma.$disconnect();
});

describe("claimJob", () => {
  it("takes the oldest pending job and marks it claimed", async () => {
    const first = await enqueue();
    await enqueue();

    const claimed = await claimJob(prisma);
    expect(claimed?.id).toBe(first.id);
    expect(claimed?.status).toBe("claimed");
    expect(claimed?.claimedAt).toBeTruthy();
  });

  it("never hands the same job to two workers", async () => {
    await enqueue();

    // Concurrent claims: exactly one should win, the other must get null.
    const [a, b] = await Promise.all([claimJob(prisma), claimJob(prisma)]);
    const ids = [a?.id, b?.id].filter(Boolean);
    expect(ids).toHaveLength(1);
  });

  it("returns null on an empty queue", async () => {
    expect(await claimJob(prisma)).toBeNull();
  });

  it("does not re-claim a job that is already done", async () => {
    const job = await enqueue();
    await completeJob(prisma, job.id, { problemId: "p1" });
    expect(await claimJob(prisma)).toBeNull();
  });

  it("reclaims a job orphaned by a crashed worker", async () => {
    // A worker that dies mid-job leaves the row in `claimed` forever; without
    // reclaim the job is silently lost and the user's toast never resolves.
    const job = await enqueue();
    await prisma.generationJob.update({
      where: { id: job.id },
      data: { status: "writing", claimedAt: new Date(Date.now() - CLAIM_TIMEOUT_MS - 1000) },
    });

    const reclaimed = await claimJob(prisma);
    expect(reclaimed?.id).toBe(job.id);
  });

  it("leaves a freshly claimed job alone", async () => {
    const job = await enqueue();
    await setStatus(prisma, job.id, "writing", { note: "writing the problem" });
    expect(await claimJob(prisma)).toBeNull();
  });
});

describe("job completion", () => {
  it("drops the pasted JD once the job finishes (INV-12)", async () => {
    const job = await enqueue();
    await completeJob(prisma, job.id, { problemId: "p1" });

    const done = await prisma.generationJob.findUnique({ where: { id: job.id } });
    expect(done?.status).toBe("done");
    expect(done?.problemId).toBe("p1");
    expect(done?.jd).toBeNull();
  });

  it("drops the JD on failure too, not just success", async () => {
    const job = await enqueue();
    await completeJob(prisma, job.id, { error: "oracle rejected every attempt" });

    const failed = await prisma.generationJob.findUnique({ where: { id: job.id } });
    expect(failed?.status).toBe("failed");
    expect(failed?.jd).toBeNull();
  });

  it("requeues a retryable failure and counts the attempt", async () => {
    const job = await enqueue();
    const claimed = (await claimJob(prisma))!;
    await requeueOrFail(prisma, claimed, "transient stream error");

    const back = await prisma.generationJob.findUnique({ where: { id: job.id } });
    expect(back?.status).toBe("pending");
    expect(back?.attempts).toBe(1);
    expect(back?.claimedAt).toBeNull();
    // Still retryable, so the JD must survive — clearing it here would make the
    // retry generate something untailored.
    expect(back?.jd).toBeTruthy();
  });

  it("fails for good once the attempt budget is spent", async () => {
    const job = await enqueue({ attempts: 2 });
    const claimed = (await claimJob(prisma))!;
    await requeueOrFail(prisma, claimed, "oracle rejected every attempt", 3);

    const dead = await prisma.generationJob.findUnique({ where: { id: job.id } });
    expect(dead?.status).toBe("failed");
    expect(dead?.error).toContain("oracle");
    expect(dead?.jd).toBeNull();
  });
});

describe("retry backoff", () => {
  it("holds a requeued job back instead of retrying it immediately", async () => {
    // The bug this guards: a worker draining the queue re-claimed a failing job
    // as fast as it could loop, spending all three attempts in ~12ms. A blip
    // that lasted one second permanently failed the job.
    const job = await enqueue();
    const claimed = (await claimJob(prisma))!;
    await requeueOrFail(prisma, claimed, "upstream hiccup");

    expect(await claimJob(prisma)).toBeNull();

    const back = await prisma.generationJob.findUnique({ where: { id: job.id } });
    expect(back?.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("claims it again once the backoff has elapsed", async () => {
    const job = await enqueue();
    const claimed = (await claimJob(prisma))!;
    await requeueOrFail(prisma, claimed, "upstream hiccup");
    await prisma.generationJob.update({
      where: { id: job.id },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });

    expect((await claimJob(prisma))?.id).toBe(job.id);
  });

  it("backs off further on each successive attempt", async () => {
    const first = await enqueue();
    await requeueOrFail(prisma, (await claimJob(prisma))!, "hiccup");
    const afterOne = await prisma.generationJob.findUnique({ where: { id: first.id } });

    await prisma.generationJob.update({
      where: { id: first.id },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    await requeueOrFail(prisma, (await claimJob(prisma))!, "hiccup", 5);
    const afterTwo = await prisma.generationJob.findUnique({ where: { id: first.id } });

    const firstDelay = afterOne!.nextAttemptAt!.getTime() - afterOne!.updatedAt.getTime();
    const secondDelay = afterTwo!.nextAttemptAt!.getTime() - afterTwo!.updatedAt.getTime();
    expect(secondDelay).toBeGreaterThan(firstDelay);
  });
});
