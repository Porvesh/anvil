import type OpenAI from "openai";
import { afterAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { ModelClient } from "../lib/ai/client";
import {
  analyzeContribution,
  containsCredentialLikeText,
  findDuplicate,
  shortlistCandidates,
  type ContributionIntake,
} from "../lib/contribution/intake";

const prisma = new PrismaClient();
afterAll(() => prisma.$disconnect());

function clientWith(output: object): ModelClient {
  return {
    provider: "openai",
    sdk: { responses: { parse: vi.fn().mockResolvedValue({ output_parsed: output }) } } as unknown as OpenAI,
  };
}

const useful = {
  sanitizedBrief:
    "Design a low-latency remote control path for physical devices over unreliable networks, including explicit command and video budgets, safe degradation, observability, and operator takeover behavior.",
  type: "design",
  difficulty: "hard",
  seniority: "senior",
  tags: ["real-time", "latency", "networking", "reliability"],
  signal: 5,
  context: 4,
  specificity: 4,
  verifiability: 4,
  privacyRisk: 0,
  isTriviaOrBehavioral: false,
  containsConfidentialMaterial: false,
} satisfies Omit<ContributionIntake, "qualityScore">;

describe("community contribution intake", () => {
  it("rejects obvious credentials before calling a provider", async () => {
    const parse = vi.fn();
    const client = {
      provider: "openai",
      sdk: { responses: { parse } } as unknown as OpenAI,
    } satisfies ModelClient;
    const decision = await analyzeContribution(client, {
      sessionId: "session",
      question: "Please debug this integration using api_key = sk-proj-this-should-never-be-forwarded",
      attested: true,
    });

    expect(decision.rejectionCode).toBe("unsafe_input");
    expect(parse).not.toHaveBeenCalled();
    expect(containsCredentialLikeText("password: hunter2")).toBe(true);
  });

  it("accepts a useful sanitized brief and honors explicit user selections", async () => {
    const decision = await analyzeContribution(clientWith(useful), {
      sessionId: "session",
      question: "The interviewer asked for a detailed remote-control system with strict latency and safety constraints.",
      requestedType: "review",
      requestedDifficulty: "medium",
      attested: true,
    });

    expect(decision.rejectionCode).toBeNull();
    expect(decision.intake.type).toBe("review");
    expect(decision.intake.difficulty).toBe("medium");
    expect(decision.intake.qualityScore).toBe(85);
  });

  it("rejects confidential or low-context output in code", async () => {
    const sensitive = await analyzeContribution(
      clientWith({ ...useful, privacyRisk: 2, containsConfidentialMaterial: true }),
      { sessionId: "session", question: "A sufficiently detailed technical interview question was pasted here for review.", attested: true },
    );
    expect(sensitive.rejectionCode).toBe("sensitive");

    const vague = await analyzeContribution(
      clientWith({ ...useful, context: 1, specificity: 1 }),
      { sessionId: "session", question: "A sufficiently long but technically vague interview question was provided here.", attested: true },
    );
    expect(vague.rejectionCode).toBe("too_vague");
  });

  it("shortlists duplicate candidates by tag overlap", () => {
    const candidates = [
      { id: "payments", title: "Payments", prompt: "", type: "design" as const, difficulty: "hard" as const, tags: ["payments", "transactions"] as const },
      { id: "robotics", title: "Robotics", prompt: "", type: "design" as const, difficulty: "hard" as const, tags: ["real-time", "latency", "robotics"] as const },
    ];
    expect(shortlistCandidates(["real-time", "latency"], candidates.map((item) => ({ ...item, tags: [...item.tags] })))[0].id).toBe("robotics");
  });

  it("accepts only high-confidence duplicate ids from the supplied shortlist", async () => {
    const intake = { ...useful, qualityScore: 85 };
    const candidates = [
      { id: "robotics", title: "Robot control", prompt: "Design a low-latency robot control path.", type: "design" as const, difficulty: "hard" as const, tags: ["real-time", "latency"] as const },
    ];
    const duplicate = await findDuplicate(
      clientWith({ closestProblemId: "robotics", similarity: 91 }),
      intake,
      candidates.map((item) => ({ ...item, tags: [...item.tags] })),
    );
    expect(duplicate).toEqual({ problemId: "robotics", similarity: 91 });

    const hallucinated = await findDuplicate(
      clientWith({ closestProblemId: "not-supplied", similarity: 99 }),
      intake,
      candidates.map((item) => ({ ...item, tags: [...item.tags] })),
    );
    expect(hallucinated.problemId).toBeNull();
  });

  it("has no database column capable of retaining submitted source text", async () => {
    const columns = await prisma.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info('Contribution')`);
    const names = columns.map((column) => column.name);
    expect(names).not.toEqual(expect.arrayContaining(["question", "roleContext", "followUps", "sanitizedBrief", "rawText", "sourceHash"]));
  });
});
