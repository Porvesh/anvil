import { prisma } from "@/lib/db";
import { toSummary } from "@/lib/problem";
import { TopBar } from "@/components/shell/TopBar";
import { Home } from "@/components/home/Home";

// The bank is read at request time so newly-generated problems show up.
export const dynamic = "force-dynamic";

export default async function Page() {
  const rows = await prisma.problem.findMany({ orderBy: { createdAt: "asc" } });
  return (
    <>
      <TopBar />
      <Home problems={rows.map(toSummary)} />
    </>
  );
}
