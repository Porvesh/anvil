/**
 * Retire problems that are too thin to be worth a user's time.
 *
 * The bank's early review problems were one-file, six-line patches — you could
 * take them in at a glance, which is the opposite of the skill the mode trains.
 * Reviewing a real PR means finding a defect inside volume, so a review problem
 * below the size bar isn't a small exercise, it's a different (easier) exercise
 * wearing the same label.
 *
 * Retiring rather than deleting: `retired` is already the flag every read path
 * filters on, the attempt history that references these problems stays intact,
 * and the decision is reversible with `--restore`.
 *
 * Usage:
 *   npm run retire:thin                  # dry run — prints what it would retire
 *   npm run retire:thin -- --apply       # actually retire them
 *   npm run retire:thin -- --restore     # un-retire everything this would pick
 */
import "../lib/loadEnv";
import { PrismaClient } from "@prisma/client";
import type { DiffHunk, SolutionFile } from "../lib/types";

const prisma = new PrismaClient();

/**
 * The bar, per mode.
 *
 * Review is measured in files and added lines because that is the reviewer's
 * workload; generation targets 3-5 files and 150-320 added lines, so this sits
 * deliberately below that to catch only the genuinely thin, not every problem
 * that came in slightly under target.
 */
const MIN_REVIEW_FILES = 3;
const MIN_REVIEW_ADDED = 100;

interface Verdict {
  id: string;
  title: string;
  type: string;
  keep: boolean;
  detail: string;
}

function judge(row: { id: string; title: string; type: string; diff: unknown; files: unknown }): Verdict {
  const base = { id: row.id, title: row.title, type: row.type };

  if (row.type === "review") {
    const diff = (row.diff as DiffHunk[] | null) ?? [];
    const added = diff.reduce((n, h) => n + h.lines.filter((l) => l.kind === "add").length, 0);
    const thin = diff.length < MIN_REVIEW_FILES || added < MIN_REVIEW_ADDED;
    return {
      ...base,
      keep: !thin,
      detail: `${diff.length} file(s), +${added}`,
    };
  }

  // Debug is left alone: a tight single-module bug is a legitimate exercise —
  // the flaw has to be found by reasoning about behaviour, not by reading volume.
  const files = (row.files as SolutionFile[] | null) ?? [];
  return { ...base, keep: true, detail: `${files.length} file(s) — not a review problem, left alone` };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const restore = process.argv.includes("--restore");

  const rows = await prisma.problem.findMany({
    select: { id: true, title: true, type: true, diff: true, files: true, retired: true },
    orderBy: { createdAt: "asc" },
  });

  const verdicts = rows.map((r) => ({ ...judge(r), retired: r.retired }));
  const thin = verdicts.filter((v) => !v.keep);

  if (restore) {
    const ids = thin.map((v) => v.id);
    if (apply) {
      const { count } = await prisma.problem.updateMany({ where: { id: { in: ids } }, data: { retired: false } });
      console.log(`Restored ${count} problem(s).`);
    } else {
      console.log(`Would restore ${ids.length} problem(s). Re-run with --apply.`);
    }
    return;
  }

  console.log(`Review bar: >= ${MIN_REVIEW_FILES} files AND >= ${MIN_REVIEW_ADDED} added lines.\n`);

  const kept = verdicts.filter((v) => v.keep && v.type === "review");
  console.log(`KEEP (${kept.length} review):`);
  for (const v of kept) console.log(`  ✓ ${v.title.slice(0, 56).padEnd(58)} ${v.detail}`);

  console.log(`\nRETIRE (${thin.length}):`);
  for (const v of thin) {
    console.log(`  ✗ ${v.title.slice(0, 56).padEnd(58)} ${v.detail}${v.retired ? "  (already retired)" : ""}`);
  }

  if (!thin.length) {
    console.log("\nNothing below the bar.");
    return;
  }

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to retire these ${thin.length}.`);
    return;
  }

  const { count } = await prisma.problem.updateMany({
    where: { id: { in: thin.map((v) => v.id) } },
    data: { retired: true },
  });
  const remaining = await prisma.problem.count({ where: { retired: false, type: "review" } });
  console.log(`\nRetired ${count} problem(s). ${remaining} review problem(s) still live.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
