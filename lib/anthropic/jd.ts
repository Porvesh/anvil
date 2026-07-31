/**
 * Job-description → tag extraction (spec §13).
 *
 * The output is constrained to the closed vocabulary by a zod enum, which is
 * the entire reason this call can use the cheapest model: there is no room for
 * the model to be creative, and creativity here would actively hurt. Two JDs
 * about the same concept must produce the same tag or set-overlap matching
 * silently fails.
 */
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { anthropic } from "./client";
import { callParams } from "./models";
import { FIXED_VOCAB, TagSchema, parseTags, type Tag } from "../tags";

const JdTagsSchema = z.object({
  tags: z
    .array(TagSchema)
    .describe("3-6 tags describing the engineering concerns this role actually involves day to day"),
  seniority: z
    .enum(["junior", "mid", "senior", "staff"])
    .describe("the seniority this role is pitched at, which maps to problem difficulty"),
});

/**
 * The schema we send, minus the SDK's client-side `parse`.
 *
 * The enum stays in the JSON schema because it is what steers the model toward
 * the closed vocabulary. What we drop is the SDK's strict validation of the
 * reply: it throws an AnthropicError on the very slip `parseTags` was written to
 * absorb, so a single out-of-vocabulary tag ("kubernetes" for an SRE posting)
 * took down the whole request instead of being discarded. Narrowing below is the
 * authority on what counts as a tag; the schema is only a hint to the model.
 */
const { parse: _strictParse, ...JD_FORMAT } = zodOutputFormat(JdTagsSchema);

const SENIORITIES = ["junior", "mid", "senior", "staff"] as const;

/** Narrow the model's seniority to a known level, defaulting to the middle. */
function asSeniority(value: unknown): JdAnalysis["seniority"] {
  return typeof value === "string" && (SENIORITIES as readonly string[]).includes(value)
    ? (value as JdAnalysis["seniority"])
    : "mid";
}

export interface JdAnalysis {
  tags: Tag[];
  seniority: "junior" | "mid" | "senior" | "staff";
}

/** Seniority → the difficulty of problem worth serving for it. */
export function difficultyFor(seniority: JdAnalysis["seniority"]): "easy" | "medium" | "hard" {
  if (seniority === "junior") return "easy";
  if (seniority === "staff") return "hard";
  return "medium";
}

/**
 * Extract tags from a pasted job description.
 *
 * Note the JD goes to the model but is never persisted by this path and never
 * returned to any other client (INV-12) — matching reads only the tags it
 * produces.
 */
export async function analyzeJd(jd: string): Promise<JdAnalysis> {
  const result = await anthropic.messages.create({
    ...callParams("jdMatch"),
    system: [
      {
        type: "text",
        text: [
          "You label job descriptions with engineering-concern tags, for matching against a bank of",
          "debugging, code-review, and system-design practice problems.",
          "",
          "Pick tags for what the person will actually spend their time on — the failure modes and systems",
          "the role implies — not for every technology the posting name-drops. A payments role is about",
          "idempotency, retries, and transactions whether or not it uses those words. Ignore benefits,",
          "culture, and location entirely.",
          "",
          `Allowed tags (use ONLY these): ${FIXED_VOCAB.join(", ")}.`,
        ].join("\n"),
        // The vocabulary is a large, byte-stable prefix reused by every JD, so
        // it's worth a cache breakpoint; the pasted JD varies and comes after.
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: `JOB DESCRIPTION:\n\n${jd}` }],
    output_config: { format: JD_FORMAT },
  });

  const text = result.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");

  // An unreadable reply means "the bank has nothing for this JD", not a 500: the
  // caller already renders the no-tags case, and matching is an optimization on
  // top of a bank the user can browse anyway.
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { tags: [], seniority: "mid" };
  }

  const parsed = raw as { tags?: unknown; seniority?: unknown };
  return {
    tags: parseTags(parsed.tags ?? []),
    seniority: asSeniority(parsed.seniority),
  };
}
