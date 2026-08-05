import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { toProblem, toPublicProblem } from "@/lib/problem";
import { DEMO_COMMENTS, DEMO_PROBLEM_TITLE, DEMO_TRANSCRIPT, buildDemoGrade } from "@/lib/demo/recordedAttempt";
import { TopBar } from "@/components/shell/TopBar";
import { DemoWalkthrough } from "@/components/demo/DemoWalkthrough";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "A graded example · Anvil",
  description: "See a real code review graded against its planted flaws — no API key needed.",
};

/**
 * The keyless first run.
 *
 * Everything AI-powered in Anvil spends the visitor's own provider key, which
 * means an evaluator cannot see a graded result without first going to get an
 * API key. Rather than weaken that rule with an operator-funded trial — the
 * no-platform-key-fallback invariant is load-bearing for both cost and trust —
 * this shows a recorded attempt against a live bank problem.
 *
 * The score is computed on this request by the real matcher and the real
 * scoring code (lib/demo/recordedAttempt.ts explains exactly which parts are
 * recorded), so what the visitor sees is what the product does.
 */
export default async function DemoPage() {
  // Prefer the authored problem the recording was written against; fall back to
  // any review problem so a bank that has been re-seeded still has a demo.
  const row =
    (await prisma.problem.findFirst({ where: { title: DEMO_PROBLEM_TITLE, type: "review" } })) ??
    (await prisma.problem.findFirst({ where: { type: "review", retired: false }, orderBy: { createdAt: "asc" } }));

  if (!row) {
    return (
      <>
        <TopBar />
        <main className="demo-missing">
          <p>
            The example needs a review problem in the bank. Run <code>npm run seed</code>, then{" "}
            <Link href="/demo">reload</Link>.
          </p>
        </main>
      </>
    );
  }

  const problem = toProblem(row);
  const isRecordedProblem = problem.title === DEMO_PROBLEM_TITLE;

  return (
    <>
      <TopBar />
      <DemoWalkthrough
        problem={toPublicProblem(row)}
        comments={DEMO_COMMENTS}
        grade={buildDemoGrade(problem)}
        transcript={DEMO_TRANSCRIPT}
        // The recorded comments only line up with the problem they were written
        // against. Against a substitute they still demonstrate the flow, but the
        // walkthrough should not narrate catches it cannot vouch for.
        narrated={isRecordedProblem}
      />
    </>
  );
}
