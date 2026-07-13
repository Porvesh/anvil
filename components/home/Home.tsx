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

const DEFAULT_JD = `Senior Backend Engineer · Payments

- 5+ yrs building distributed services in Python/Go
- Own reliability of the payments API (webhooks, retries, idempotency)
- Strong on observability, debugging production incidents
- Comfortable reviewing others' code, incl. AI-assisted PRs`;

const QUALITY_LABEL: Record<ProblemSummary["quality"], string> = {
  good: "★ community pick",
  mixed: "mixed",
  new: "new",
};

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

  const [shuffling, setShuffling] = useState(false);
  const [jd, setJd] = useState(DEFAULT_JD);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  // Live generation is only meaningful with a real JD + a type that has an
  // executable oracle (debug/review). Without a JD there's nothing to tailor
  // to; with type=design there's no oracle to self-check against. In both
  // cases we route to a bank pick, and the button label reflects that — no
  // more silently doing a $0.15 Sonnet call for one click and an instant DB
  // read for another with the same 'Generate a problem' verb.
  const jdTrimmed = jd.trim();
  const canGenerate = type !== "any" && type !== "design" && jdTrimmed.length >= 40;

  /**
   * Generate a NEW problem tailored to the JD (design falls back to bank
   * selection — no live design generation yet). This actually calls the model
   * and self-check, then opens the freshly-created problem.
   */
  async function generate() {
    setGenError(null);
    // Design has no executable oracle → serve a matching bank problem instead.
    if (type === "design" || type === "any" || !jdTrimmed) {
      const pool = type === "any" ? problems : problems.filter((p) => p.type === type);
      const target = pool[0] ?? problems[0];
      if (target) router.push(`/solve/${target.id}`);
      return;
    }
    setGenerating(true);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, difficulty, jd: jd.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Generation failed (${res.status})`);
      router.push(`/solve/${data.id}`);
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "Generation failed");
      setGenerating(false);
    }
  }

  /** Jump to a random non-retired problem, honoring the type filter. */
  async function shuffle() {
    setShuffling(true);
    try {
      const q = type === "any" ? "" : `?type=${type}`;
      const res = await fetch(`/api/problems/random${q}`);
      const { id } = await res.json();
      router.push(id ? `/solve/${id}` : "/");
    } catch {
      setShuffling(false);
    }
  }

  const recent = problems.slice(0, 6);

  return (
    <div className={styles.wrap}>
      <section className={styles.hero}>
        <div className="eyebrow">Interview practice for the skills that actually break people</div>
        <h1>
          Drill the hard part. <em>Not</em> inverted binary trees.
        </h1>
        <p>
          Debug real code. Review a plausible AI-written PR. Reason through a system design out loud.{" "}
          <b>The AI plants the flaws, so the grader holds the answer key</b> — grading is a match, not a vibe.
        </p>
      </section>

      <div className={styles.starter}>
        <div className={`${styles.card} ${styles.jd}`}>
          <h3>Tailor it to a job</h3>
          <p className={styles.lead}>
            Paste a job description — Anvil pulls the stack, domain, and seniority to pick problems that match.
          </p>
          <textarea spellCheck={false} value={jd} onChange={(e) => setJd(e.target.value)} />
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
            <button className={`btn-primary ${styles.cta}`} onClick={generate} disabled={generating}>
              {generating
                ? "Generating…"
                : canGenerate
                  ? "Generate a tailored problem →"
                  : type === "design"
                    ? "Open a design problem →"
                    : jdTrimmed.length < 40
                      ? "Pick from the bank →"
                      : "Pick from the bank →"}
            </button>
          </div>
          {generating && (
            <p className={styles.genNote}>
              Writing a fresh {type === "any" ? "" : type + " "}problem tailored to your JD, then executing it to verify the bug is real — this takes a minute or two.
            </p>
          )}
          {!generating && !canGenerate && type !== "design" && (
            <p className={styles.genNote}>
              {type === "any"
                ? "Pick debug or review + paste a JD to generate a fresh, tailored problem. Otherwise this opens a matching problem from the bank."
                : jdTrimmed.length < 40
                  ? "Paste a job description (a few lines is enough) to generate a fresh problem tailored to it. Otherwise this opens one from the bank."
                  : null}
            </p>
          )}
          {!generating && type === "design" && (
            <p className={styles.genNote}>
              System design problems are curated, not generated on-demand — there's no executable oracle to self-check against yet.
            </p>
          )}
          {genError && <p className={styles.genError}>{genError}</p>}
        </div>

        <div className={`${styles.card} ${styles.side}`}>
          <div className={styles.sideHead}>
            <h3>From the bank</h3>
            <button className={styles.shuffle} onClick={shuffle} disabled={shuffling}>
              {shuffling ? "…" : "⤨ Shuffle"}
            </button>
          </div>
          {recent.map((p) => (
            <Link key={p.id} href={`/solve/${p.id}`} className={styles.bankrow}>
              <span className={`pill ${TYPE_PILL[p.type]}`}>{TYPE_LABEL[p.type]}</span>
              <span className={styles.t}>{p.title}</span>
              <span className={styles.rowmeta}>
                {p.timesAttempted > 0 && <span className={styles.attempts}>{p.timesAttempted}×</span>}
                {p.quality !== "new" && <span className={`${styles.quality} ${styles[`q_${p.quality}`]}`}>{QUALITY_LABEL[p.quality]}</span>}
                <span className={styles.diff}>{p.difficulty}</span>
              </span>
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
            desc="Think out loud. Write a design doc while an AI interviewer probes requirements, capacity math, and failure modes — graded on a rubric."
            go="Interviewer-led session →"
            href={firstOfType.design ? `/solve/${firstOfType.design}` : "/"}
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
