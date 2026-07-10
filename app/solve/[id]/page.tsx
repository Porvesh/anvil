import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { toPublicProblem } from "@/lib/problem";
import { TopBar } from "@/components/shell/TopBar";
import { SolveWorkspace } from "@/components/solve/SolveWorkspace";

export const dynamic = "force-dynamic";

export default async function SolvePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = await prisma.problem.findUnique({ where: { id } });
  if (!row) notFound();

  return (
    <>
      <TopBar />
      <SolveWorkspace problem={toPublicProblem(row)} />
    </>
  );
}
