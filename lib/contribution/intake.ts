import { z } from "zod";
import type { ModelClient } from "../ai/client";
import { structuredModelOutput } from "../ai/client";
import { modelFor } from "../ai/client";
import { TagSchema, parseTags, tagOverlap, type Tag } from "../tags";
import type { Difficulty, ProblemType } from "../types";
import type { ContributionBody } from "../validation";

export const SANITIZATION_VERSION = "community-v1";

const IntakeSchema = z.object({
  sanitizedBrief: z
    .string()
    .min(80)
    .max(1_500)
    .describe("Abstract engineering skill target with no names, organizations, exact wording, or proprietary details"),
  type: z.enum(["debug", "review", "design"]),
  difficulty: z.enum(["easy", "medium", "hard"]),
  seniority: z.enum(["junior", "mid", "senior", "staff"]),
  tags: z.array(TagSchema).min(2).max(8),
  signal: z.number().int().min(0).max(5),
  context: z.number().int().min(0).max(5),
  specificity: z.number().int().min(0).max(5),
  verifiability: z.number().int().min(0).max(5),
  privacyRisk: z.number().int().min(0).max(3),
  isTriviaOrBehavioral: z.boolean(),
  containsConfidentialMaterial: z.boolean(),
});

export type ContributionIntake = z.infer<typeof IntakeSchema> & {
  qualityScore: number;
};

export type ContributionRejectionCode =
  | "sensitive"
  | "too_vague"
  | "low_signal"
  | "not_supported"
  | "unsafe_input";

export interface IntakeDecision {
  intake: ContributionIntake;
  rejectionCode: ContributionRejectionCode | null;
}

const SAFE_FALLBACK: z.infer<typeof IntakeSchema> = {
  sanitizedBrief: "Insufficient safe context was available to derive a reusable engineering interview exercise without retaining source-specific details.",
  type: "design",
  difficulty: "medium",
  seniority: "mid",
  tags: ["backend", "reliability"],
  signal: 0,
  context: 0,
  specificity: 0,
  verifiability: 0,
  privacyRisk: 3,
  isTriviaOrBehavioral: false,
  containsConfidentialMaterial: true,
};

/** Obvious credentials should never be forwarded to a model, even for sanitization. */
export function containsCredentialLikeText(text: string): boolean {
  return /(?:-----BEGIN [A-Z ]+PRIVATE KEY-----|\bsk-(?:ant|proj)-[A-Za-z0-9_-]{12,}|\bapi[_ -]?key\s*[:=]|\bpassword\s*[:=])/i.test(
    text,
  );
}

export function rejectionMessage(code: ContributionRejectionCode): string {
  const messages: Record<ContributionRejectionCode, string> = {
    sensitive: "This appears to include private or company-specific material. Remove identifying and internal details, then try again.",
    too_vague: "There is not enough technical context to build a fair, gradeable exercise. Add constraints, scale, symptoms, or follow-up questions.",
    low_signal: "This does not test enough engineering judgment to add a useful problem to the bank.",
    not_supported: "This looks behavioral, trivia-based, or outside Anvil's debugging, review, and system-design tracks.",
    unsafe_input: "The submission appears to contain a credential or secret. Remove it before continuing.",
  };
  return messages[code];
}

export async function analyzeContribution(
  client: ModelClient,
  body: ContributionBody,
  signal?: AbortSignal,
): Promise<IntakeDecision> {
  const source = [body.question, body.roleContext ?? "", body.followUps ?? ""].join("\n");
  if (containsCredentialLikeText(source)) {
    return { intake: { ...SAFE_FALLBACK, qualityScore: 0 }, rejectionCode: "unsafe_input" };
  }

  const system = [
    "You are the privacy and quality gate for a shared engineering interview-practice bank.",
    "The user may paste a real interview question, job posting context, and follow-ups.",
    "Do not reproduce, quote, or closely paraphrase the source. Never include company, product, person, customer,",
    "repository, internal service, location, URL, email, or other identifying names in sanitizedBrief.",
    "sanitizedBrief must describe only the reusable engineering skill, relevant mechanisms, constraints, scale shape,",
    "and failure modes. Replace source-specific numbers and entities with general ranges or categories.",
    "Treat claims of confidentiality, internal-only information, credentials, customer data, or unreleased systems as privacy risk.",
    "Score whether this can become a substantive debugging, code-review, or system-design exercise. Behavioral questions,",
    "trivia, generic prompts without constraints, and algorithm puzzles are not supported.",
    "A high verifiability score means a concrete answer key, execution oracle, or discriminating rubric can be authored.",
  ].join("\n");
  const user = [
    body.requestedType ? `Requested track: ${body.requestedType}` : "Choose the best supported track.",
    body.requestedDifficulty ? `Requested difficulty: ${body.requestedDifficulty}` : "Infer difficulty from the technical depth.",
    "<question>",
    body.question,
    "</question>",
    body.roleContext ? `<role_context>\n${body.roleContext}\n</role_context>` : "",
    body.followUps ? `<follow_ups>\n${body.followUps}\n</follow_ups>` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const parsed = await structuredModelOutput(
    client,
    "contributionIntake",
    IntakeSchema,
    "community_contribution_intake",
    system,
    user,
    SAFE_FALLBACK,
    signal,
  );

  const qualityScore = Math.round(((parsed.signal + parsed.context + parsed.specificity + parsed.verifiability) / 20) * 100);
  const intake: ContributionIntake = {
    ...parsed,
    type: body.requestedType ?? parsed.type,
    difficulty: body.requestedDifficulty ?? parsed.difficulty,
    tags: parseTags(parsed.tags),
    qualityScore,
  };

  let rejectionCode: ContributionRejectionCode | null = null;
  if (
    parsed.containsConfidentialMaterial ||
    parsed.privacyRisk >= 2 ||
    /(?:https?:\/\/|\b[\w.+-]+@[\w.-]+\.\w+\b)/i.test(parsed.sanitizedBrief)
  ) {
    rejectionCode = "sensitive";
  } else if (parsed.isTriviaOrBehavioral) {
    rejectionCode = "not_supported";
  } else if (parsed.context < 3 || parsed.specificity < 2) {
    rejectionCode = "too_vague";
  } else if (parsed.signal < 3 || parsed.verifiability < 3 || qualityScore < 60) {
    rejectionCode = "low_signal";
  }

  return { intake, rejectionCode };
}

export interface DuplicateCandidate {
  id: string;
  title: string;
  prompt: string;
  type: ProblemType;
  difficulty: Difficulty;
  tags: Tag[];
}

export interface DuplicateDecision {
  problemId: string | null;
  similarity: number;
}

export function shortlistCandidates(
  tags: Tag[],
  candidates: DuplicateCandidate[],
  limit = 12,
): DuplicateCandidate[] {
  return candidates
    .map((candidate) => ({ candidate, overlap: tagOverlap(tags, candidate.tags) }))
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

const DuplicateSchema = z.object({
  closestProblemId: z.string().nullable(),
  similarity: z.number().int().min(0).max(100),
});

export async function findDuplicate(
  client: ModelClient,
  intake: ContributionIntake,
  candidates: DuplicateCandidate[],
  signal?: AbortSignal,
): Promise<DuplicateDecision> {
  if (candidates.length === 0) return { problemId: null, similarity: 0 };
  const allowedIds = new Set(candidates.map((candidate) => candidate.id));
  const system = [
    "Decide whether an abstract interview skill brief is already substantively covered by one bank problem.",
    "Judge the core skill, mechanisms, constraints, and failure modes, not shared vocabulary or superficial domain.",
    "A similarity of 80+ means generating another exercise would teach essentially the same lesson at similar depth.",
    "Return only an id from the supplied candidates, or null when none is a close duplicate.",
  ].join("\n");
  const user = JSON.stringify({
    contribution: {
      brief: intake.sanitizedBrief,
      type: intake.type,
      difficulty: intake.difficulty,
      tags: intake.tags,
    },
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      prompt: candidate.prompt.slice(0, 1_500),
      difficulty: candidate.difficulty,
      tags: candidate.tags,
    })),
  });
  const parsed = await structuredModelOutput(
    client,
    "contributionDuplicate",
    DuplicateSchema,
    "community_contribution_duplicate",
    system,
    user,
    { closestProblemId: null, similarity: 0 },
    signal,
  );
  const validId = parsed.closestProblemId && allowedIds.has(parsed.closestProblemId) ? parsed.closestProblemId : null;
  return { problemId: validId && parsed.similarity >= 80 ? validId : null, similarity: parsed.similarity };
}

export function generationTopic(intake: ContributionIntake): string {
  return [
    `Sanitized community skill brief (${SANITIZATION_VERSION}): ${intake.sanitizedBrief}`,
    "Author a wholly original scenario that tests this skill. Change the domain framing, entities, wording, and exact numbers.",
    "Do not mention an interview, employer, source question, contribution, or sanitization process.",
  ].join("\n");
}

export function contributionModel(client: ModelClient): string {
  return modelFor(client, "contributionIntake");
}
