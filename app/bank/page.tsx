import { prisma } from "@/lib/db";
import { toSummary } from "@/lib/problem";
import { wilsonScore } from "@/lib/curation";
import { DIFFICULTIES, PROBLEM_TYPES } from "@/lib/types";
import { TopBar } from "@/components/shell/TopBar";
import { Bank } from "@/components/bank/Bank";

// Newly generated problems must show up without a redeploy or a cache bust.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Problem bank · Anvil",
  description: "Every verified debugging, code-review, and system-design problem in the shared bank.",
};

/** Narrow a query-string value against a known set, ignoring anything else. */
function oneOf<T extends string>(allowed: readonly T[], value: string | string[] | undefined): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const type = oneOf(PROBLEM_TYPES, params.type);
  const difficulty = oneOf(DIFFICULTIES, params.difficulty);
  const sort = params.sort === "new" ? "new" : "top";

  // Filter here, not only in the client component. The client seeds its controls
  // from the same query string, so rendering the unfiltered bank first showed
  // every type for a beat with the Debug segment already lit — and a shared
  // /bank?type=debug link looked broken until the effect caught up.
  const rows = await prisma.problem.findMany({
    where: { retired: false, ...(type ? { type } : {}), ...(difficulty ? { difficulty } : {}) },
    orderBy: { createdAt: "desc" },
  });

  // Match the API's default ordering ("top") so the first paint doesn't reshuffle.
  const rank = new Map(rows.map((r) => [r.id, wilsonScore(r.upvotes, r.downvotes)]));
  const problems = rows.map(toSummary);
  if (sort === "top") problems.sort((a, b) => (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0));

  return (
    <>
      <TopBar />
      <Bank initial={problems} />
    </>
  );
}
