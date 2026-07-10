"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Difficulty, ProblemSummary, ProblemType } from "@/lib/types";
import styles from "./Home.module.css";

const TYPE_PILL: Record<ProblemType, string> = {
  debug: "pill-dbg",
  review: "pill-rev",
  design: "pill-sys",
};
const TYPE_LABEL: Record<ProblemType, string> = {
  debug: "Debug",
  review: "Review",
  design: "Design",
};

type TypeFilter = "any" | ProblemType;

/**
 * Landing page (spec §6). Ports the v1.html home: hero, JD-tailoring card,
 * "pick up where the bank left off" list, and the three-track grid. Since v1
 * generation is offline, "Generate a problem" selects a matching problem from
 * the seeded bank rather than generating live.
 */
export function Home({ problems }: { problems: ProblemSummary[] }) {
  const router = useRouter();
  const [type, setType] = useState<TypeFilter>("any");
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");

  const firstOfType = useMemo(() => {
    const map = {} as Record<ProblemType, string | undefined>;
    for (const p of problems) if (!map[p.type]) map[p.type] = p.id;
    return map;
  }, [problems]);

  /** Pick a bank problem matching the current filters (best-effort) and open it. */
  function generate() {
    const byBoth = problems.find((p) => (type === "any" || p.type === type) && p.difficulty === difficulty);
    const byType = problems.find((p) => type === "any" || p.type === type);
    const target = byBoth ?? byType ?? problems[0];
    if (target) router.push(`/solve/${target.id}`);
  }

  const recent = problems.slice(0, 4);

  return (
    <div className={styles.wrap}>
      <section className={styles.hero}>
        <div className="eyebrow">Interview practice for the skills that actually break people</div>
        <h1>
          Drill the hard part. <em>Not</em> inverted binary trees.
        </h1>
        <p>
          Anvil generates realistic problems in the areas modern interviews and real jobs turn on — reading unfamiliar
          code under pressure, catching the bug in a plausible AI-written PR, and reasoning through a system design out
          loud.
        </p>
      </section>

      <div className={styles.starter}>
        <div className={`${styles.card} ${styles.jd}`}>
          <h3>Tailor it to a job</h3>
          <p className={styles.lead}>
            Paste a job description — Anvil pulls the stack, domain, and seniority to pick problems that match.
          </p>
          <textarea
            spellCheck={false}
            defaultValue={`Senior Backend Engineer · Payments

- 5+ yrs building distributed services in Python/Go
- Own reliability of the payments API (webhooks, retries, idempotency)
- Strong on observability, debugging production incidents
- Comfortable reviewing others' code, incl. AI-assisted PRs`}
          />
          <div className={styles.row}>
            <div className={styles.seg}>
              {(["any", "debug", "review", "design"] as TypeFilter[]).map((t) => (
                <button key={t} className={type === t ? styles.on : ""} onClick={() => setType(t)}>
                  {t === "any" ? "Any type" : TYPE_LABEL[t]}
                </button>
              ))}
            </div>
            <div className={styles.seg}>
              {(["easy", "medium", "hard"] as Difficulty[]).map((d) => (
                <button key={d} className={difficulty === d ? styles.on : ""} onClick={() => setDifficulty(d)}>
                  {d[0].toUpperCase() + d.slice(1)}
                </button>
              ))}
            </div>
            <button className={`btn-primary ${styles.cta}`} onClick={generate}>
              Generate a problem →
            </button>
          </div>
        </div>

        <div className={`${styles.card} ${styles.side}`}>
          <h3>Or pick up where the bank left off</h3>
          {recent.map((p) => (
            <Link key={p.id} href={`/solve/${p.id}`} className={styles.bankrow}>
              <span className={`pill ${TYPE_PILL[p.type]}`}>{TYPE_LABEL[p.type]}</span>
              <span className={styles.t}>{p.title}</span>
              <span className={styles.diff}>{p.difficulty}</span>
            </Link>
          ))}
        </div>
      </div>

      <section className={styles.how}>
        <div className={styles.howLead}>
          <div className="eyebrow">Why this works</div>
          <h2>The grader holds the answer key</h2>
        </div>
        <div className={styles.howGrid}>
          <div className={styles.howStep}>
            <div className={styles.howNum}>1</div>
            <h4>Flaws are seeded, not guessed</h4>
            <p>
              Every problem starts as clean, correct code. Realistic flaws are planted into it — and each one is verified real by
              actually executing the code before it enters the bank.
            </p>
          </div>
          <div className={styles.howStep}>
            <div className={styles.howNum}>2</div>
            <h4>You solve in your browser</h4>
            <p>
              Python runs in a WebAssembly sandbox on your machine — no servers, no setup, no code leaving your tab. Edit, run,
              iterate until green.
            </p>
          </div>
          <div className={styles.howStep}>
            <div className={styles.howNum}>3</div>
            <h4>Grading is a match, not a vibe</h4>
            <p>
              Because the flaws are known, grading is near-deterministic: caught / missed / false-positive against the seeded
              answer key, line by line. Precision counts — nits cost points.
            </p>
          </div>
          <div className={styles.howStep}>
            <div className={styles.howNum}>4</div>
            <h4>The follow-up is the lesson</h4>
            <p>
              An interviewer then probes exactly what you missed — one Socratic question at a time — the way a strong interviewer
              would. That conversation is where the skill actually builds.
            </p>
          </div>
        </div>
      </section>

      <section className={styles.cats}>
        <div className={styles.catLead}>
          <div className="eyebrow">Three tracks</div>
          <h2>Pick what you want to sharpen</h2>
        </div>
        <div className={styles.catgrid}>
          <TrackCard
            kind="debug"
            title="Debug"
            desc="Ship a fix. Given runnable code and a failing symptom, edit and re-run in the browser until the tests pass."
            go="Runs live in your browser →"
            href={firstOfType.debug ? `/solve/${firstOfType.debug}` : "/"}
          />
          <TrackCard
            kind="review"
            title="Code review"
            desc="Catch what matters. Review a plausible AI-generated PR, leave line comments, then defend them in follow-up."
            go="Real diff, real comments →"
            href={firstOfType.review ? `/solve/${firstOfType.review}` : "/"}
          />
          <TrackCard
            kind="design"
            title="System design"
            desc="Think out loud. Sketch on a canvas while an AI interviewer probes requirements, capacity, and failure modes."
            go="Interviewer-led session →"
            href="/"
            badge="phase 2"
          />
        </div>
      </section>
    </div>
  );
}

function TrackCard({
  kind,
  title,
  desc,
  go,
  href,
  badge,
}: {
  kind: "debug" | "review" | "design";
  title: string;
  desc: string;
  go: string;
  href: string;
  badge?: string;
}) {
  return (
    <Link href={href} className={`${styles.cat} ${styles[kind]}`}>
      {badge && <span className={styles.badge}>{badge}</span>}
      <div className={styles.ic}>
        <TrackIcon kind={kind} />
      </div>
      <h3>{title}</h3>
      <p>{desc}</p>
      <div className={styles.go}>{go}</div>
    </Link>
  );
}

function TrackIcon({ kind }: { kind: "debug" | "review" | "design" }) {
  const common = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2 } as const;
  if (kind === "debug")
    return (
      <svg {...common} strokeLinecap="round">
        <path d="M12 3v3M5 7l2 2M19 7l-2 2M4 14h3M17 14h3M8 21a4 4 0 0 1 8 0M12 8a5 5 0 0 1 5 5v2a5 5 0 0 1-10 0v-2a5 5 0 0 1 5-5z" />
      </svg>
    );
  if (kind === "review")
    return (
      <svg {...common} strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    );
  return (
    <svg {...common} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}
