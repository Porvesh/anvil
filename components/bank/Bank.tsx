"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ProblemSummary, ProblemType, Difficulty } from "@/lib/types";
import { DIFFICULTIES, PROBLEM_TYPES } from "@/lib/types";
import { asTag, type Tag } from "@/lib/tags";
import styles from "./Bank.module.css";

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

type Sort = "top" | "new";

/**
 * How big the job is, phrased in the unit that matters for the mode: a reviewer
 * reads added lines across files, a debugger has the whole package open.
 */
function scaleLabel(type: ProblemType, scale: NonNullable<ProblemSummary["scale"]>): string {
  const files = `${scale.files} file${scale.files === 1 ? "" : "s"}`;
  return type === "review" ? `${files} · +${scale.lines}` : `${files} · ${scale.lines} lines`;
}

/**
 * The full problem bank (the destination the "Problem bank" nav entry always
 * advertised). The home page shows six rows as a teaser; this is the browsable
 * list, filterable by the same axes the bank is generated along plus the topic
 * tags that make it searchable by concern rather than only by mode.
 *
 * Type/difficulty/sort go to the server because the API already implements them
 * (and ranking needs the vote counts); tag filtering is done here, over the rows
 * already fetched, because it is set intersection over a closed vocabulary and a
 * round trip per chip click would feel worse than instant.
 */
export function Bank({ initial }: { initial: ProblemSummary[] }) {
  // Seeded from the URL so `/bank?type=debug&tag=idempotency` lands pre-filtered:
  // that is what makes the home page's track cards and a shared link work. Read
  // once as initial state rather than kept in sync, since the controls below are
  // the source of truth from then on.
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const urlType = params.get("type");
  const urlDifficulty = params.get("difficulty");
  const urlTags = params.getAll("tag").map(asTag).filter((tag): tag is Tag => tag !== null);

  const [problems, setProblems] = useState(initial);
  const [type, setType] = useState<ProblemType | "all">(
    (PROBLEM_TYPES as readonly string[]).includes(urlType ?? "") ? (urlType as ProblemType) : "all",
  );
  const [difficulty, setDifficulty] = useState<Difficulty | "all">(
    (DIFFICULTIES as readonly string[]).includes(urlDifficulty ?? "") ? (urlDifficulty as Difficulty) : "all",
  );
  const [sort, setSort] = useState<Sort>(params.get("sort") === "new" ? "new" : "top");
  const [activeTags, setActiveTags] = useState<Tag[]>(() => [...new Set(urlTags)]);
  const [loading, setLoading] = useState(false);
  const firstRender = useRef(true);

  // Refetch whenever a server-side filter changes — but not on mount: the server
  // component already queried with these exact filters, so a first-render fetch
  // would re-request the identical rows on every page load.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({ sort, limit: "100" });
    if (type !== "all") params.set("type", type);
    if (difficulty !== "all") params.set("difficulty", difficulty);

    setLoading(true);
    fetch(`/api/problems?${params}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setProblems(data.problems ?? []);
      })
      .catch(() => {
        // Leave the current list up rather than blanking the page on a blip.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [type, difficulty, sort]);

  // Keep the controls shareable and browser-navigation friendly. The server page
  // reads the same query on a fresh request; tags stay client-side because they
  // filter the already fetched, closed-vocabulary result set instantly.
  useEffect(() => {
    const next = new URLSearchParams();
    if (type !== "all") next.set("type", type);
    if (difficulty !== "all") next.set("difficulty", difficulty);
    if (sort !== "top") next.set("sort", sort);
    for (const tag of activeTags) next.append("tag", tag);

    const href = next.size > 0 ? `${pathname}?${next}` : pathname;
    router.replace(href, { scroll: false });
  }, [activeTags, difficulty, pathname, router, sort, type]);

  // Tags actually present in the current result set, commonest first — showing
  // the whole 40-tag vocabulary would mostly offer dead ends.
  const availableTags = useMemo(() => {
    const counts = new Map<Tag, number>();
    for (const p of problems) {
      for (const tag of p.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [problems]);

  // Every selected tag must be present (AND), which is what makes stacking two
  // chips narrow the list instead of widening it.
  const visible = useMemo(
    () => problems.filter((p) => activeTags.every((t) => p.tags.includes(t))),
    [problems, activeTags],
  );

  function toggleTag(tag: Tag) {
    setActiveTags((current) => (current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag]));
  }

  const filtered = type !== "all" || difficulty !== "all" || activeTags.length > 0;

  return (
    <main className={styles.wrap}>
      <header className={styles.head}>
        <div>
          <span className="eyebrow">Shared bank</span>
          <h1 className={styles.h1}>Every problem, verified before it landed</h1>
          <p className={styles.sub}>
            Each one was generated, then executed to prove the flaw is real — the ones that failed that check
            never made it here. Tailored problems other people generated are in this list too.
          </p>
        </div>
      </header>

      <div className={styles.controls}>
        <div className={styles.seg}>
          <button className={type === "all" ? styles.on : ""} onClick={() => setType("all")}>
            Any type
          </button>
          {PROBLEM_TYPES.map((t) => (
            <button key={t} className={type === t ? styles.on : ""} onClick={() => setType(t)}>
              {TYPE_LABEL[t]}
            </button>
          ))}
        </div>

        <div className={styles.seg}>
          <button className={difficulty === "all" ? styles.on : ""} onClick={() => setDifficulty("all")}>
            Any level
          </button>
          {DIFFICULTIES.map((d) => (
            <button key={d} className={difficulty === d ? styles.on : ""} onClick={() => setDifficulty(d)}>
              {d[0].toUpperCase() + d.slice(1)}
            </button>
          ))}
        </div>

        <div className={styles.seg}>
          <button className={sort === "top" ? styles.on : ""} onClick={() => setSort("top")}>
            Top rated
          </button>
          <button className={sort === "new" ? styles.on : ""} onClick={() => setSort("new")}>
            Newest
          </button>
        </div>

        <span className={styles.count}>
          {loading ? "loading…" : `${visible.length} problem${visible.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {availableTags.length > 0 && (
        <div className={styles.tagrow}>
          <span className={styles.tagLabel}>Topic</span>
          {availableTags.map(([tag, n]) => (
            <button
              key={tag}
              className={`${styles.tag} ${activeTags.includes(tag) ? styles.tagOn : ""}`}
              onClick={() => toggleTag(tag)}
              aria-pressed={activeTags.includes(tag)}
            >
              {tag}
              <span className={styles.tagCount}>{n}</span>
            </button>
          ))}
          {activeTags.length > 0 && (
            <button className={styles.clear} onClick={() => setActiveTags([])}>
              clear
            </button>
          )}
        </div>
      )}

      {visible.length === 0 ? (
        <div className={styles.empty}>
          {filtered ? (
            <>
              Nothing matches that combination yet.{" "}
              <button
                className={styles.link}
                onClick={() => {
                  setType("all");
                  setDifficulty("all");
                  setActiveTags([]);
                }}
              >
                Clear the filters
              </button>{" "}
              — or paste a job description on the home page and Anvil will build one.
            </>
          ) : (
            <>The bank is empty. Generate a problem from the home page to start it off.</>
          )}
        </div>
      ) : (
        <ul className={styles.list}>
          {visible.map((p) => (
            <li key={p.id}>
              <Link href={`/solve/${p.id}`} className={styles.row}>
                <span className={`pill ${TYPE_PILL[p.type]}`}>{p.type}</span>
                <span className={styles.main}>
                  <span className={styles.title}>{p.title}</span>
                  <span className={styles.sub}>
                    {p.scale && <span className={styles.scale}>{scaleLabel(p.type, p.scale)}</span>}
                    {p.tags.slice(0, 3).map((t) => (
                      <span key={t} className={styles.rowtag}>
                        {t}
                      </span>
                    ))}
                    {p.quality === "good" && <span className={styles.good}>well rated</span>}
                  </span>
                </span>
                {/* Fixed-width trailing columns so the eye can run down them
                    instead of tracking a ragged edge row to row. */}
                <span className={styles.attempts}>
                  {p.timesAttempted > 0 ? `${p.timesAttempted} attempt${p.timesAttempted === 1 ? "" : "s"}` : ""}
                </span>
                <span className={`${styles.diff} ${styles[p.difficulty]}`}>{p.difficulty}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
