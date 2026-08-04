/**
 * Sign-in tokens and the anonymous->account merge, against the real database.
 *
 * Both are only meaningful as database behaviour: single-use redemption is a
 * conditional update racing itself, and the merge's whole job is to satisfy two
 * unique constraints while keeping denormalized tallies true. A mocked Prisma
 * would test the mock. Runs on the disposable SQLite file (tests/setup/testDb.ts).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  LOGIN_TOKEN_TTL_MS,
  consumeLoginToken,
  hashLoginToken,
  issueLoginToken,
  normalizeEmail,
  purgeExpiredLoginTokens,
} from "../lib/auth/tokens";
import { mergeAnonymousWork } from "../lib/auth/merge";

const prisma = new PrismaClient();

const EMAIL = "candidate@account.test";
const SESSION = "test-auth-session";
const OTHER_SESSION = "test-auth-other-session";

async function resetFixtures() {
  await prisma.loginToken.deleteMany({ where: { email: { contains: "@account.test" } } });
  await prisma.attempt.deleteMany({ where: { sessionId: { in: [SESSION, OTHER_SESSION] } } });
  await prisma.vote.deleteMany({ where: { sessionId: { in: [SESSION, OTHER_SESSION] } } });
  await prisma.contribution.deleteMany({ where: { sessionId: { in: [SESSION, OTHER_SESSION] } } });
  await prisma.user.deleteMany({ where: { email: { contains: "@account.test" } } });
  await prisma.problem.deleteMany({ where: { id: { startsWith: "test-auth-problem" } } });
}

/** A minimal bank row; the merge only cares about its id and tallies. */
async function seedProblem(id: string) {
  return prisma.problem.create({
    data: {
      id,
      type: "debug",
      difficulty: "easy",
      title: `Fixture ${id}`,
      prompt: "fixture",
      answerKey: [],
      tags: [],
    },
  });
}

async function seedAttempt(sessionId: string, problemId: string) {
  return prisma.attempt.create({ data: { problemId, sessionId, submission: {} } });
}

beforeEach(resetFixtures);

afterAll(async () => {
  await resetFixtures();
  await prisma.$disconnect();
});

describe("login tokens", () => {
  it("stores only the hash and redeems exactly once", async () => {
    const { token } = await issueLoginToken(prisma, { email: EMAIL, claimSessionId: SESSION });

    const row = await prisma.loginToken.findUnique({ where: { tokenHash: hashLoginToken(token) } });
    expect(row).not.toBeNull();
    // The plaintext token must not be recoverable from the table.
    expect(JSON.stringify(row)).not.toContain(token);

    const first = await consumeLoginToken(prisma, token);
    expect(first).toMatchObject({ ok: true, email: EMAIL, claimSessionId: SESSION });

    const second = await consumeLoginToken(prisma, token);
    expect(second).toEqual({ ok: false, reason: "used" });
  });

  it("hands exactly one session to parallel clicks on the same link", async () => {
    const { token } = await issueLoginToken(prisma, { email: EMAIL });

    const results = await Promise.all(Array.from({ length: 5 }, () => consumeLoginToken(prisma, token)));

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(4);
  });

  it("rejects unknown and expired tokens distinguishably", async () => {
    expect(await consumeLoginToken(prisma, "never-issued")).toEqual({ ok: false, reason: "invalid" });

    const issuedAt = new Date(Date.now() - LOGIN_TOKEN_TTL_MS - 1000);
    const { token } = await issueLoginToken(prisma, { email: EMAIL, now: issuedAt });
    expect(await consumeLoginToken(prisma, token)).toEqual({ ok: false, reason: "expired" });
  });

  it("invalidates a previous unconsumed link when a new one is requested", async () => {
    const first = await issueLoginToken(prisma, { email: EMAIL });
    const second = await issueLoginToken(prisma, { email: EMAIL });

    expect(await consumeLoginToken(prisma, first.token)).toEqual({ ok: false, reason: "invalid" });
    expect((await consumeLoginToken(prisma, second.token)).ok).toBe(true);
  });

  it("normalizes the address so casing cannot fork an account", async () => {
    expect(normalizeEmail("  Candidate@Account.TEST ")).toBe(EMAIL);
    const { token } = await issueLoginToken(prisma, { email: "  Candidate@Account.TEST " });
    const consumed = await consumeLoginToken(prisma, token);
    expect(consumed).toMatchObject({ ok: true, email: EMAIL });
  });

  it("purges dead rows and keeps redeemable ones", async () => {
    const { token: spent } = await issueLoginToken(prisma, { email: EMAIL });
    await consumeLoginToken(prisma, spent);
    await issueLoginToken(prisma, {
      email: "other@account.test",
      now: new Date(Date.now() - LOGIN_TOKEN_TTL_MS - 1),
    });
    const live = await issueLoginToken(prisma, { email: "live@account.test" });

    // Asserted over this suite's own rows rather than the global count: purging
    // is deliberately table-wide, so a total would depend on what else ran.
    expect(await purgeExpiredLoginTokens(prisma)).toBeGreaterThanOrEqual(2);
    const remaining = await prisma.loginToken.findMany({ where: { email: { contains: "@account.test" } } });
    expect(remaining).toHaveLength(1);
    expect((await consumeLoginToken(prisma, live.token)).ok).toBe(true);
  });
});

describe("anonymous work merge", () => {
  it("adopts this browser's attempts, votes, and contributions", async () => {
    const user = await prisma.user.create({ data: { email: EMAIL } });
    const problem = await seedProblem("test-auth-problem-1");
    await seedAttempt(SESSION, problem.id);
    await seedAttempt(SESSION, problem.id);
    await prisma.vote.create({ data: { problemId: problem.id, sessionId: SESSION, value: 1 } });
    await prisma.contribution.create({ data: { sessionId: SESSION, status: "accepted", provider: "anthropic" } });

    const summary = await mergeAnonymousWork(prisma, { userId: user.id, sessionId: SESSION });

    expect(summary).toEqual({ attempts: 2, votes: 1, contributions: 1, discardedVotes: 0 });
    expect(await prisma.attempt.count({ where: { userId: user.id } })).toBe(2);
    expect(await prisma.vote.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.contribution.count({ where: { userId: user.id } })).toBe(1);
  });

  it("never claims another browser's or another account's work", async () => {
    const user = await prisma.user.create({ data: { email: EMAIL } });
    const other = await prisma.user.create({ data: { email: "other@account.test" } });
    const problem = await seedProblem("test-auth-problem-2");

    await seedAttempt(OTHER_SESSION, problem.id);
    const owned = await prisma.attempt.create({
      data: { problemId: problem.id, sessionId: SESSION, userId: other.id, submission: {} },
    });

    const summary = await mergeAnonymousWork(prisma, { userId: user.id, sessionId: SESSION });

    expect(summary.attempts).toBe(0);
    expect((await prisma.attempt.findUnique({ where: { id: owned.id } }))?.userId).toBe(other.id);
    expect(await prisma.attempt.count({ where: { userId: user.id } })).toBe(0);
  });

  it("keeps the account's own vote on a conflict and recounts the tally", async () => {
    const user = await prisma.user.create({ data: { email: EMAIL } });
    const problem = await seedProblem("test-auth-problem-3");

    // The account already downvoted from another device; this browser upvoted
    // anonymously. Adopting the anonymous row would double-count the problem.
    await prisma.vote.create({ data: { problemId: problem.id, sessionId: OTHER_SESSION, userId: user.id, value: -1 } });
    await prisma.vote.create({ data: { problemId: problem.id, sessionId: SESSION, value: 1 } });
    await prisma.problem.update({ where: { id: problem.id }, data: { upvotes: 1, downvotes: 1 } });

    const summary = await mergeAnonymousWork(prisma, { userId: user.id, sessionId: SESSION });

    expect(summary).toMatchObject({ votes: 0, discardedVotes: 1 });
    const votes = await prisma.vote.findMany({ where: { problemId: problem.id } });
    expect(votes).toHaveLength(1);
    expect(votes[0]).toMatchObject({ userId: user.id, value: -1 });

    // The stale upvote must not survive in the denormalized tallies.
    const after = await prisma.problem.findUnique({ where: { id: problem.id } });
    expect(after).toMatchObject({ upvotes: 0, downvotes: 1 });
  });

  it("is idempotent, so a second sign-in changes nothing", async () => {
    const user = await prisma.user.create({ data: { email: EMAIL } });
    const problem = await seedProblem("test-auth-problem-4");
    await seedAttempt(SESSION, problem.id);
    await prisma.vote.create({ data: { problemId: problem.id, sessionId: SESSION, value: 1 } });

    await mergeAnonymousWork(prisma, { userId: user.id, sessionId: SESSION });
    const second = await mergeAnonymousWork(prisma, { userId: user.id, sessionId: SESSION });

    expect(second).toEqual({ attempts: 0, votes: 0, contributions: 0, discardedVotes: 0 });
    expect(await prisma.vote.count({ where: { problemId: problem.id } })).toBe(1);
  });

  it("does nothing without an anonymous session to claim", async () => {
    const user = await prisma.user.create({ data: { email: EMAIL } });
    expect(await mergeAnonymousWork(prisma, { userId: user.id, sessionId: null })).toEqual({
      attempts: 0,
      votes: 0,
      contributions: 0,
      discardedVotes: 0,
    });
  });
});
