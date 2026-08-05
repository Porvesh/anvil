import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { prisma } from "@/lib/db";
import { toPublicProblem } from "@/lib/problem";
import { TopBar } from "@/components/shell/TopBar";
import { SolveWorkspace } from "@/components/solve/SolveWorkspace";

export const dynamic = "force-dynamic";

const getProblem = cache((id: string) => prisma.problem.findUnique({ where: { id } }));

export async function generateMetadata({ params }: PageProps<"/solve/[id]">): Promise<Metadata> {
  const { id } = await params;
  const problem = await getProblem(id);
  if (!problem) return { title: "Problem not found · Anvil" };

  return {
    title: `${problem.title} · Anvil`,
    description: problem.prompt.replace(/\s+/g, " ").slice(0, 160),
  };
}

export default async function SolvePage({ params, searchParams }: PageProps<"/solve/[id]">) {
  const { id } = await params;
  const [row, query] = await Promise.all([getProblem(id), searchParams]);
  if (!row) notFound();

  // `?interview=1` arms timed conditions. The workspace still asks before
  // starting the clock, so the link is shareable without ambushing anyone.
  return (
    <>
      <TopBar />
      <SolveWorkspace problem={toPublicProblem(row)} interview={query.interview === "1"} />
    </>
  );
}
