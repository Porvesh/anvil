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
  const result = await anthropic.messages.parse({
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
    output_config: { format: zodOutputFormat(JdTagsSchema) },
  });

  return {
    tags: parseTags(result.parsed_output?.tags ?? []),
    seniority: result.parsed_output?.seniority ?? "mid",
  };
}
