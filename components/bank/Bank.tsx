"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ProblemSummary, ProblemType, Difficulty } from "@/lib/types";
import { DIFFICULTIES, PROBLEM_TYPES } from "@/lib/types";
import { asTag, type Tag } from "@/lib/tags";
import { IconArrowRight, IconChevronDown, IconPlus, IconSearch, IconX } from "@/lib/icons";
import styles from "./Bank.module.css";

const TYPE_PILL: Record<ProblemType, string> = {
  debug: "pill-dbg",
  review: "pill-rev",
  design: "pill-sys",
};

const TYPE_LABEL: Record<ProblemType, string> = {
  debug: "Debug",
  review: "Code review",
  design: "System design",
};
const TYPE_BADGE_LABEL: Record<ProblemType, string> = {
  debug: "Debug",
  review: "Review",
  design: "Design",
};

type Sort = "top" | "new";

function scaleLabel(type: ProblemType, scale: NonNullable<ProblemSummary["scale"]>): string {
  const files = `${scale.files} file${scale.files === 1 ? "" : "s"}`;
  return type === "review" ? `${files} · +${scale.lines} lines` : `${files} · ${scale.lines} lines`;
}

function matchesQuery(problem: ProblemSummary, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return true;
  if (problem.title.toLowerCase().includes(query)) return true;
  return problem.tags.some((tag) => tag.includes(query) || tag.replaceAll("-", " ").includes(query));
}

/** Browsable, shareable view of every verified problem in the bank. */
export function Bank({ initial }: { initial: ProblemSummary[] }) {
  const params = useSearchParams();
  const pathname = usePathname();
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
  const [query, setQuery] = useState(() => (params.get("q") ?? "").slice(0, 100));
  const [activeTags, setActiveTags] = useState<Tag[]>(() => [...new Set(urlTags)]);
  const [topicsExpanded, setTopicsExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    let cancelled = false;
    const next = new URLSearchParams({ sort, limit: "100" });
    if (type !== "all") next.set("type", type);
    if (difficulty !== "all") next.set("difficulty", difficulty);

    setLoading(true);
    setLoadError(false);
    fetch(`/api/problems?${next}`)
      .then((response) => {
        if (!response.ok) throw new Error(`Problem bank request failed (${response.status})`);
        return response.json();
      })
      .then((data) => {
        if (!cancelled) setProblems(data.problems ?? []);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [type, difficulty, sort, refreshKey]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (type !== "all") next.set("type", type);
    if (difficulty !== "all") next.set("difficulty", difficulty);
    if (sort !== "top") next.set("sort", sort);
    if (query.trim()) next.set("q", query.trim());
    for (const tag of activeTags) next.append("tag", tag);

    // These controls already own their data fetching and local filtering. A
    // native history update keeps the URL shareable without starting an RSC
    // navigation for every character typed into search.
    window.history.replaceState(null, "", next.size > 0 ? `${pathname}?${next}` : pathname);
  }, [activeTags, difficulty, pathname, query, sort, type]);

  const availableTags = useMemo(() => {
    const counts = new Map<Tag, number>();
    for (const problem of problems) {
      for (const tag of problem.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    for (const tag of activeTags) if (!counts.has(tag)) counts.set(tag, 0);
    return [...counts.entries()].sort(
      (a, b) => Number(activeTags.includes(b[0])) - Number(activeTags.includes(a[0])) || b[1] - a[1] || a[0].localeCompare(b[0]),
    );
  }, [activeTags, problems]);

  const visible = useMemo(
    () =>
      problems.filter(
        (problem) => activeTags.every((tag) => problem.tags.includes(tag)) && matchesQuery(problem, query),
      ),
    [problems, activeTags, query],
  );

  function toggleTag(tag: Tag) {
    setActiveTags((current) => (current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag]));
  }

  function clearFilters() {
    setType("all");
    setDifficulty("all");
    setQuery("");
    setActiveTags([]);
  }

  const filtered = type !== "all" || difficulty !== "all" || activeTags.length > 0 || query.trim().length > 0;
  return (
    <main className={styles.wrap}>
      <header className={styles.head}>
        <div>
          <span className="eyebrow">Shared library</span>
          <h1 className={styles.h1}>Problem bank</h1>
          <p className={styles.intro}>
            Verified debugging, code-review, and system-design exercises, ready to practice.
          </p>
        </div>
        <Link href="/contribute" className={styles.contributeAction}>
          <IconPlus />
          Contribute
        </Link>
      </header>

      <section className={styles.filterPanel} aria-label="Problem bank filters">
        <div className={styles.searchRow}>
          <label className={styles.search}>
            <IconSearch />
            <span className={styles.srOnly}>Search problems</span>
            <input
              type="search"
              value={query}
              maxLength={100}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search titles or topics"
            />
            {query && (
              <button type="button" onClick={() => setQuery("")} aria-label="Clear search" title="Clear search">
                <IconX />
              </button>
            )}
          </label>

          <div className={styles.sortGroup} role="group" aria-label="Sort problems">
            <span className={styles.controlLabel}>Sort</span>
            <div className={styles.seg}>
              <button aria-pressed={sort === "top"} className={sort === "top" ? styles.on : ""} onClick={() => setSort("top")}>
                Top rated
              </button>
              <button aria-pressed={sort === "new"} className={sort === "new" ? styles.on : ""} onClick={() => setSort("new")}>
                Newest
              </button>
            </div>
          </div>
        </div>

        <div className={styles.filterRow}>
          <label className={styles.selectControl}>
            <select aria-label="Filter by track" value={type} onChange={(event) => setType(event.target.value as ProblemType | "all")}>
              <option value="all">All tracks</option>
              {PROBLEM_TYPES.map((item) => <option key={item} value={item}>{TYPE_LABEL[item]}</option>)}
            </select>
            <IconChevronDown />
          </label>

          <label className={styles.selectControl}>
            <select aria-label="Filter by difficulty" value={difficulty} onChange={(event) => setDifficulty(event.target.value as Difficulty | "all")}>
              <option value="all">All levels</option>
              {DIFFICULTIES.map((item) => <option key={item} value={item}>{item[0].toUpperCase() + item.slice(1)}</option>)}
            </select>
            <IconChevronDown />
          </label>

          {availableTags.length > 0 && (
            <button
              className={`${styles.topicDisclosure} ${activeTags.length > 0 ? styles.topicDisclosureActive : ""}`}
              onClick={() => setTopicsExpanded((current) => !current)}
              aria-expanded={topicsExpanded}
            >
              Topics{activeTags.length > 0 ? ` · ${activeTags.length}` : ""}
              <IconChevronDown className={topicsExpanded ? styles.chevronUp : ""} />
            </button>
          )}

          <div className={styles.resultSummary} aria-live="polite">
            <span>{loading ? "Updating…" : `${visible.length} result${visible.length === 1 ? "" : "s"}`}</span>
            {filtered && (
              <button type="button" onClick={clearFilters}>
                Reset filters
              </button>
            )}
          </div>
        </div>

        {topicsExpanded && availableTags.length > 0 && (
          <div className={styles.topicDrawer}>
            <div className={styles.topicList}>
              {availableTags.map(([tag, count]) => (
                <button
                  key={tag}
                  className={`${styles.tag} ${activeTags.includes(tag) ? styles.tagOn : ""}`}
                  onClick={() => toggleTag(tag)}
                  aria-pressed={activeTags.includes(tag)}
                >
                  {tag.replaceAll("-", " ")}
                  <span>{count}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {!topicsExpanded && activeTags.length > 0 && (
          <div className={styles.activeTopics}>
            {activeTags.map((tag) => (
              <button key={tag} onClick={() => toggleTag(tag)} title={`Remove ${tag.replaceAll("-", " ")} filter`}>
                {tag.replaceAll("-", " ")}
                <IconX size={12} />
              </button>
            ))}
          </div>
        )}
      </section>

      {loadError && (
        <div className={styles.loadError} role="alert">
          <span>Couldn&apos;t refresh the bank. The previous results are still shown.</span>
          <button onClick={() => setRefreshKey((key) => key + 1)}>Retry</button>
        </div>
      )}

      {visible.length === 0 ? (
        <div className={styles.empty}>
          <strong>{filtered ? "No matching problems" : "The bank is empty"}</strong>
          <span>{filtered ? "Try a broader search or remove one of the active filters." : "Generate a tailored problem from the practice page."}</span>
          {filtered && <button onClick={clearFilters}>Reset filters</button>}
        </div>
      ) : (
        <ul className={`${styles.list} ${loading ? styles.listLoading : ""}`} aria-busy={loading}>
          {visible.map((problem) => (
              <li key={problem.id}>
                <Link href={`/solve/${problem.id}`} className={styles.problemRow}>
                  <span className={`${styles.type} pill ${TYPE_PILL[problem.type]}`}>{TYPE_BADGE_LABEL[problem.type]}</span>
                  <span className={styles.problemMain}>
                    <span className={styles.title}>{problem.title}</span>
                    <span className={styles.metadata}>
                      {problem.scale && <span>{scaleLabel(problem.type, problem.scale)}</span>}
                      {problem.timesAttempted > 0 && (
                        <span>{problem.timesAttempted} attempt{problem.timesAttempted === 1 ? "" : "s"}</span>
                      )}
                      {problem.quality === "good" && <span className={styles.good}>Community pick</span>}
                    </span>
                  </span>
                  <span className={`${styles.difficulty} ${styles[problem.difficulty]}`}>{problem.difficulty}</span>
                  <span className={styles.open} aria-hidden="true">
                    <IconArrowRight />
                  </span>
                </Link>
              </li>
          ))}
        </ul>
      )}
    </main>
  );
}
