"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Difficulty, ProblemSummary, ProblemType } from "@/lib/types";
import { getSessionId } from "@/lib/session";
import { IconShuffle } from "@/lib/icons";
import { notifyByokRequired } from "@/lib/byokClient";
import { streamSSE } from "@/lib/sseClient";
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

/**
 * One problem at random from a pool.
 *
 * Used where there is no better signal to choose by (an empty JD). Taking
 * index 0 sent every such click to the same
 * problem — whichever happened to sort first — so the bank looked like it had
 * one problem per type no matter how much was in it. Called only from click
 * handlers, so the randomness never reaches a render.
 */
function pick<T>(pool: T[]): T | undefined {
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : undefined;
}

const QUALITY_LABEL: Record<ProblemSummary["quality"], string> = {
  good: "★ community pick",
  mixed: "mixed",
  new: "new",
};

/**
 * Landing page (spec §6): JD matching, shared-bank picks, and tailored BYOK
 * generation when the bank genuinely has no relevant exercise.
 */
export function Home({ problems }: { problems: ProblemSummary[] }) {
  const router = useRouter();
  const [type, setType] = useState<TypeFilter>("any");
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");

  /**
   * How many problems each track holds.
   *
   * These cards used to link to the *first* problem of each type, which — since
   * the bank is read oldest-first — meant the three headline calls to action all
   * landed on the original seed problems, the most generic thing in the bank, and
   * the same one on every visit. A track is a category, not a problem: the cards
   * now open that category and let the user choose, which is what the section
   * already claims ("pick what you want to sharpen").
   */
  const countOfType = useMemo(() => {
    const map = { debug: 0, review: 0, design: 0 } as Record<ProblemType, number>;
    for (const p of problems) map[p.type] += 1;
    return map;
  }, [problems]);

  const [shuffling, setShuffling] = useState(false);
  const [jd, setJd] = useState(DEFAULT_JD);
  const [matchPhase, setMatchPhase] = useState<"idle" | "matching" | "generating">("idle");
  const [generationNote, setGenerationNote] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const matching = matchPhase !== "idle";

  const jdTrimmed = jd.trim();
  const canMatch = jdTrimmed.length >= 40;

  /** Match the shared bank first; spend the user's key on generation only on a miss. */
  async function match() {
    setGenError(null);
    setGenerationNote(null);
    if (!jdTrimmed) {
      const pool = type === "any" ? problems : problems.filter((p) => p.type === type);
      const target = pick(pool) ?? pick(problems);
      if (target) router.push(`/solve/${target.id}`);
      return;
    }

    setMatchPhase("matching");
    try {
      const sessionId = getSessionId();
      const request = {
        jd: jdTrimmed,
        sessionId,
        type: type === "any" ? undefined : type,
        difficulty,
      };
      const res = await fetch("/api/jd/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      const data = await res.json();
      notifyByokRequired(data?.code);
      if (!res.ok) throw new Error(data?.error ?? `Matching failed (${res.status})`);

      const matches: { id: string; type: ProblemType }[] = data.matches ?? [];
      const preferred = type === "any" ? matches : matches.filter((m) => m.type === type);
      const best = preferred[0] ?? matches[0];
      if (!best) {
        setMatchPhase("generating");
        let problemId: string | null = null;
        let generationError: string | null = null;
        await streamSSE("/api/generate/tailored", request, {
          onDelta: () => {},
          onPhase: (_phase, note) => setGenerationNote(note ?? "Quality-checking the generated problem"),
          onError: (message) => {
            generationError = message;
          },
          onDone: (payload) => {
            if (typeof payload.problemId === "string") problemId = payload.problemId;
          },
        });
        if (generationError) throw new Error(generationError);
        if (!problemId) throw new Error("Generation completed without a problem.");
        router.push(`/solve/${problemId}`);
        return;
      }
      router.push(`/solve/${best.id}`);
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "Matching failed");
      setMatchPhase("idle");
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
        <div className="eyebrow">Interview practice for backend engineers</div>
        <h1>
          Find the <em>bug</em>. Catch the bad PR. Defend the design.
        </h1>
        <p>
          Anvil plants every flaw itself, so it knows exactly what you caught and what you walked past — then spends the
          follow-up on the difference.
        </p>
        {/* Solving needs your own provider key. Reading a finished attempt does
            not, so the claim above is checkable before anyone signs up for
            anything. */}
        <Link href="/demo" className={styles.heroDemo}>
          See a graded example first — no key needed →
        </Link>
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
            <button className={`btn-primary ${styles.cta}`} onClick={match} disabled={matching}>
              {matchPhase === "matching"
                ? "Checking the bank…"
                : matchPhase === "generating"
                  ? "Generating and verifying…"
                  : canMatch
                    ? "Match me a problem →"
                    : "Pick from the bank →"}
            </button>
          </div>
          {matchPhase === "generating" && (
            <p className={styles.genNote}>
              No close match exists yet. Anvil is creating and quality-checking one with your key; this can take a few minutes.
              {generationNote ? ` ${generationNote}.` : ""}
            </p>
          )}
          {!matching && canMatch && (
            <p className={styles.genNote}>
              Anvil checks the shared bank first. On a miss, your key creates a tailored, verified problem that becomes reusable.
            </p>
          )}
          {!matching && !canMatch && (
            <p className={styles.genNote}>
              Paste a job description (a few lines is enough) and Anvil will match the stack, domain, and seniority.
              Otherwise this just opens one from the bank.
            </p>
          )}
          {genError && <p className={styles.genError}>{genError}</p>}
        </div>

        <div className={`${styles.card} ${styles.side}`}>
          <div className={styles.sideHead}>
            <h3>From the bank</h3>
            <button className={styles.shuffle} onClick={shuffle} disabled={shuffling}>
              {shuffling ? "…" : (
                <>
                  <IconShuffle /> Shuffle
                </>
              )}
            </button>
          </div>
          {recent.map((p) => (
            <Link key={p.id} href={`/solve/${p.id}`} className={styles.bankrow}>
              <span className={`pill ${TYPE_PILL[p.type]}`}>{TYPE_LABEL[p.type]}</span>
              <span className={styles.t}>{p.title}</span>
              <span className={styles.rowmeta}>
                {/* How much code is behind the link — a five-file PR and a
                    six-line patch looked identical in this list. */}
                {p.scale && (
                  <span className={styles.scale}>
                    {p.type === "review" ? `${p.scale.files}f +${p.scale.lines}` : `${p.scale.files}f`}
                  </span>
                )}
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
          <div className="eyebrow">How it works</div>
          <h2>The grader holds the answer key</h2>
        </div>
        <div className={styles.howGrid}>
          <div className={styles.howStep}>
            <div className={styles.howNum}>1</div>
            <h4>Flaws are seeded, not guessed</h4>
            <p>
              Each problem starts as working code. Anvil plants the flaws, then runs the tests. If they don&apos;t fail, the
              problem never enters the bank.
            </p>
          </div>
          <div className={styles.howStep}>
            <div className={styles.howNum}>2</div>
            <h4>You solve in the browser</h4>
            <p>Python runs in a WebAssembly sandbox on your machine. No setup, no server, nothing leaves the tab.</p>
          </div>
          <div className={styles.howStep}>
            <div className={styles.howNum}>3</div>
            <h4>Grading is a line match</h4>
            <p>
              The seeded flaws are known, so a comment either lands on one or it doesn&apos;t: caught, missed, or false
              positive. Nits cost points.
            </p>
          </div>
          <div className={styles.howStep}>
            <div className={styles.howNum}>4</div>
            <h4>Then it asks what you missed</h4>
            <p>One Socratic question at a time, aimed at the gap it just found in your reasoning.</p>
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
            go={trackGo(countOfType.debug, ["debug problem", "debug problems"])}
            href="/bank?type=debug"
          />
          <TrackCard
            kind="review"
            title="Code review"
            desc="Catch what matters. Review a plausible AI-generated PR, leave line comments, then defend them in follow-up."
            go={trackGo(countOfType.review, ["PR to review", "PRs to review"])}
            href="/bank?type=review"
          />
          <TrackCard
            kind="design"
            title="System design"
            desc="Think out loud. Write a design doc while an AI interviewer probes requirements, capacity math, and failure modes — graded on a rubric."
            go={trackGo(countOfType.design, ["design brief", "design briefs"])}
            href="/bank?type=design"
          />
        </div>
      </section>
    </div>
  );
}

/**
 * The card's action line. Says what the click actually opens and how much is
 * there, so the card never promises a session it can't start — an empty track
 * sends the user to the JD box, which is the only thing that fills it.
 */
function trackGo(count: number, [singular, plural]: [string, string]): string {
  // Every card lands on that track's slice of the bank.
  if (count === 0) return "Nothing banked yet →";
  // Both forms are spelled out: these are noun phrases, and suffixing an "s"
  // turns "PR to review" into "PR to reviews".
  return `Pick from ${count} ${count === 1 ? singular : plural} →`;
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
