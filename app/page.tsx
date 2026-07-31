import { prisma } from "@/lib/db";
import { toSummary } from "@/lib/problem";
import { TopBar } from "@/components/shell/TopBar";
import { Home } from "@/components/home/Home";

// The bank is read at request time so newly-generated problems show up.
export const dynamic = "force-dynamic";

export default async function Page() {
  // Newest first. Read oldest-first, the home page's "from the bank" list showed
  // the six original seed problems forever and a freshly generated one never
  // surfaced there — the opposite of what that panel is for.
  //
  // `retired: false` matters as much: this was the one surface that ignored it,
  // so a problem retired for being weak still turned up in the teaser and in the
  // track counts, which made retiring it pointless on the busiest page.
  const rows = await prisma.problem.findMany({
    where: { retired: false },
    orderBy: { createdAt: "desc" },
  });
  return (
    <>
      <TopBar />
      <Home problems={rows.map(toSummary)} />
    </>
  );
}
