/**
 * The closed topic vocabulary (spec §13).
 *
 * JD matching is set-overlap between the tags extracted from a pasted job
 * description and the tags on banked problems. That only works if both sides
 * draw from the *same* fixed list — free-form tagging produces richer, more
 * varied labels, which is precisely what makes overlap matching worse ("async
 * messaging" vs "message queues" vs "pub/sub" are three misses on one concept).
 *
 * So the vocabulary is closed, the extractor is constrained to it by a zod
 * enum, and this file is the single place it's defined. Adding a tag means
 * re-tagging the bank (scripts/backfill-tags.ts), so add deliberately.
 */
import { z } from "zod";

/** Every tag the system recognises. Order is irrelevant; membership is not. */
export const FIXED_VOCAB = [
  // failure modes / correctness concerns
  "idempotency",
  "concurrency",
  "race-conditions",
  "locking",
  "retry",
  "backpressure",
  "error-handling",
  "validation",
  "edge-cases",
  "state-management",
  // data
  "caching",
  "database",
  "sql-injection",
  "transactions",
  "pagination",
  "data-modeling",
  "migrations",
  "serialization",
  // systems
  "distributed",
  "queueing",
  "streaming",
  "rate-limiting",
  "scaling",
  "performance",
  "real-time",
  "latency",
  "networking",
  "video",
  "memory",
  "observability",
  "profiling",
  "reliability",
  // domains
  "payments",
  "billing",
  "webhooks",
  "auth",
  "security",
  "api-design",
  "inventory",
  "notifications",
  "search",
  "analytics",
  "robotics",
  // stack
  "python",
  "typescript",
  "backend",
  "frontend",
] as const;

export type Tag = (typeof FIXED_VOCAB)[number];

/** zod enum used to constrain the extractor's structured output to the vocabulary. */
export const TagSchema = z.enum(FIXED_VOCAB);

const VOCAB_SET = new Set<string>(FIXED_VOCAB);

/** Narrow an unknown string to a Tag, or null if it's outside the vocabulary. */
export function asTag(value: string): Tag | null {
  const normalized = value.trim().toLowerCase();
  return VOCAB_SET.has(normalized) ? (normalized as Tag) : null;
}

/**
 * Coerce a stored `tags` Json column (or a model's output) into clean Tags.
 * Drops anything outside the vocabulary and de-duplicates — a stray tag from an
 * older vocabulary version should degrade matching, never throw.
 */
export function parseTags(value: unknown): Tag[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<Tag>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const tag = asTag(entry);
    if (tag) out.add(tag);
  }
  return [...out];
}

/**
 * How well a problem's tags cover what the JD asked for.
 *
 * Denominator is the JD's tag count, not the union: a problem that covers every
 * concept the JD named is a great match even if it also teaches three things
 * the JD never mentioned. Jaccard would penalise that richness.
 */
export function tagOverlap(jdTags: Tag[], problemTags: Tag[]): number {
  if (jdTags.length === 0) return 0;
  const problemSet = new Set(problemTags);
  const hits = jdTags.filter((t) => problemSet.has(t)).length;
  return hits / jdTags.length;
}

/** Overlap at or above this counts as "the bank already has this" (spec §13). */
export const MATCH_THRESHOLD = 0.4;

/**
 * Domain tags are intent gates, not just extra overlap points. A robotics JD
 * should not match a generic distributed-systems problem merely because both
 * mention performance and backend work.
 */
const DOMAIN_TAGS = new Set<Tag>([
  "payments",
  "billing",
  "webhooks",
  "auth",
  "security",
  "inventory",
  "notifications",
  "search",
  "analytics",
  "video",
  "robotics",
]);

export function isRelevantTagMatch(jdTags: Tag[], problemTags: Tag[]): boolean {
  if (tagOverlap(jdTags, problemTags) < MATCH_THRESHOLD) return false;
  const requiredDomains = jdTags.filter((tag) => DOMAIN_TAGS.has(tag));
  if (requiredDomains.length === 0) return true;
  const problemSet = new Set(problemTags);
  return requiredDomains.some((tag) => problemSet.has(tag));
}
