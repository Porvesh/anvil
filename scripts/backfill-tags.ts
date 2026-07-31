/**
 * Tag existing bank problems against the fixed vocabulary (spec B5).
 *
 * Problems generated from now on are born tagged, but everything banked before
 * that carries an empty tag list — and an untagged problem is invisible to JD
 * matching. Until this runs, match-first has nothing to match, so this is a
 * prerequisite for /api/jd/match doing anything at all rather than an
 * optimization.
 *
 * Cheap (Haiku, one small call per problem) and idempotent: already-tagged
 * problems are skipped unless --force.
 *
 *   npm run backfill:tags
 *   npm run backfill:tags -- --force     # re-tag everything
 *   npm run backfill:tags -- --dry       # print, don't write
 */
import "../lib/loadEnv";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { anthropic } from "../lib/anthropic/client";
import { callParams } from "../lib/anthropic/models";
import { FIXED_VOCAB, TagSchema, parseTags } from "../lib/tags";
import { toProblem } from "../lib/problem";

const prisma = new PrismaClient();
const FORCE = process.argv.includes("--force");
const DRY = process.argv.includes("--dry");

const TagsSchema = z.object({
  tags: z.array(TagSchema).describe("2-5 tags describing what this problem teaches"),
});

async function tagsFor(title: string, prompt: string, answerKeySummary: string) {
  const result = await anthropic.messages.parse({
    ...callParams("jdMatch"),
    system: [
      {
        type: "text",
        text: [
          "You label practice problems with engineering-concern tags so they can be matched to job descriptions.",
          "Tag what the problem actually teaches — the failure mode a solver has to understand — not the surface domain.",
          `Allowed tags (use ONLY these): ${FIXED_VOCAB.join(", ")}.`,
        ].join("\n"),
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `TITLE: ${title}\n\nBRIEF: ${prompt}\n\nWHAT THE PROBLEM HIDES:\n${answerKeySummary}`,
      },
    ],
    output_config: { format: zodOutputFormat(TagsSchema) },
  });
  return parseTags(result.parsed_output?.tags ?? []);
}

async function main() {
  const rows = await prisma.problem.findMany({ orderBy: { createdAt: "asc" } });
  const todo = rows.filter((r) => FORCE || parseTags(r.tags).length === 0);

  console.log(`${rows.length} problems, ${todo.length} to tag${DRY ? " [dry run]" : ""}${FORCE ? " [forced]" : ""}\n`);
  if (todo.length === 0) return;

  let tagged = 0;
  for (const row of todo) {
    const problem = toProblem(row);
    // The answer key is the most informative signal about what a problem
    // teaches, and this runs server-side where reading it is exactly right.
    const summary = problem.answerKey.map((i) => `- ${i.failure}: ${i.explanation}`).join("\n") || "(none)";

    try {
      const tags = await tagsFor(problem.title, problem.prompt, summary);
      if (tags.length === 0) {
        console.log(`· ${problem.title.slice(0, 56).padEnd(56)} no tags returned`);
        continue;
      }
      if (!DRY) {
        await prisma.problem.update({ where: { id: row.id }, data: { tags } });
      }
      tagged++;
      console.log(`✓ ${problem.title.slice(0, 56).padEnd(56)} ${tags.join(", ")}`);
    } catch (err) {
      console.log(`✗ ${problem.title.slice(0, 56).padEnd(56)} ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\nTagged ${tagged}/${todo.length}${DRY ? " (dry run — nothing written)" : ""}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
