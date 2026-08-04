"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getSessionId } from "@/lib/session";
import { SIGN_IN_MESSAGES, type SignInStatus } from "@/lib/authStatus";
import type { ProblemType, Difficulty } from "@/lib/types";
import styles from "./History.module.css";

const TYPE_PILL: Record<ProblemType, string> = {
  debug: "pill-dbg",
  review: "pill-rev",
  design: "pill-sys",
};

interface HistoryRow {
  id: string;
  at: string;
  problemId: string;
  title: string;
  type: ProblemType;
  difficulty: Difficulty;
  score: number | null;
  caught: number;
  total: number;
  falsePositives: number;
  graded: boolean;
}

/** Score → the same three-band colouring the results screen uses. */
function band(score: number): string {
  if (score >= 75) return styles.strong;
  if (score >= 50) return styles.mid;
  return styles.weak;
}

function when(iso: string): string {
  const then = new Date(iso);
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  const days = Math.round(mins / (60 * 24));
  if (days < 30) return `${days}d ago`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * The caller's attempt history — the destination the "History" nav entry
 * always advertised, and the surface an account exists to protect.
 *
 * Fetched on the client because the anonymous session id lives in localStorage
 * (spec §14: no login to start), so the server cannot know whose history to
 * render until the browser tells it. The trade is a loading state on first
 * paint, which is why the empty and error cases are distinct: "you haven't
 * attempted anything" and "we couldn't load it" lead to different next actions.
 *
 * The response says whether the request was authenticated, so this renders
 * either "saved to your account" or the offer to make it durable — without a
 * second round trip to /api/auth/session.
 */
export function History({ signInStatus }: { signInStatus?: SignInStatus | null }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [account, setAccount] = useState<{ signedIn: boolean; email: string | null }>({
    signedIn: false,
    email: null,
  });
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/history?sessionId=${encodeURIComponent(getSessionId())}`, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        setRows(data.attempts ?? []);
        setAccount({ signedIn: Boolean(data.signedIn), email: data.email ?? null });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const graded = rows?.filter((r) => r.score !== null) ?? [];
  const average = graded.length
    ? Math.round(graded.reduce((sum, r) => sum + (r.score ?? 0), 0) / graded.length)
    : null;

  return (
    <main className={styles.wrap}>
      <header className={styles.head}>
        <span className="eyebrow">Your attempts</span>
        <h1 className={styles.h1}>What you&apos;ve worked through</h1>
        <p className={styles.sub}>
          {account.signedIn
            ? "Saved to your account, so it survives this browser and follows you to another machine. Nothing here is shared with the bank beyond the problem ratings you chose to give."
            : "Kept on this browser under an anonymous id — nothing here is shared with the bank beyond the problem ratings you chose to give."}
        </p>
      </header>

      {signInStatus === "ok" && (
        <div className={`${styles.notice} ${styles.noticeGood}`} role="status">
          <strong>{SIGN_IN_MESSAGES.ok.title}</strong>
          <span>{SIGN_IN_MESSAGES.ok.detail}</span>
        </div>
      )}

      {/* Only offered once there is something to lose. Asking a first-time
          visitor to create an account before they have any history would be
          asking for a signup to protect nothing. */}
      {!account.signedIn && rows !== null && rows.length > 0 && (
        <div className={styles.notice}>
          <div>
            <strong>This history lives in one browser</strong>
            <span>Clearing site data or switching machines loses it. Signing in keeps it.</span>
          </div>
          <Link className={styles.noticeAction} href="/signin">
            Sign in →
          </Link>
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <div className={styles.stats}>
          <div className={styles.stat}>
            <span className={styles.statNum}>{rows.length}</span>
            <span className={styles.statLbl}>attempt{rows.length === 1 ? "" : "s"}</span>
          </div>
          {average !== null && (
            <div className={styles.stat}>
              <span className={`${styles.statNum} ${band(average)}`}>{average}</span>
              <span className={styles.statLbl}>average score</span>
            </div>
          )}
          <div className={styles.stat}>
            <span className={styles.statNum}>{new Set(rows.map((r) => r.problemId)).size}</span>
            <span className={styles.statLbl}>distinct problems</span>
          </div>
        </div>
      )}

      {failed ? (
        <div className={styles.empty}>
          Couldn&apos;t load your history just now.{" "}
          <button className={styles.link} onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      ) : rows === null ? (
        <div className={styles.empty}>Loading your attempts…</div>
      ) : rows.length === 0 ? (
        <div className={styles.empty}>
          Nothing here yet — every problem you submit shows up on this page.{" "}
          <Link href="/bank" className={styles.link}>
            Pick one from the bank
          </Link>{" "}
          to start.
        </div>
      ) : (
        <ul className={styles.list}>
          {rows.map((row) => (
            <li key={row.id}>
              <Link href={`/solve/${row.problemId}`} className={styles.row}>
                <span className={`pill ${TYPE_PILL[row.type]}`}>{row.type}</span>
                <span className={styles.title}>{row.title}</span>
                {row.graded ? (
                  <span className={styles.detail}>
                    {row.caught}/{row.total} caught
                    {row.falsePositives > 0 && ` · ${row.falsePositives} false positive${row.falsePositives === 1 ? "" : "s"}`}
                  </span>
                ) : (
                  <span className={styles.detail}>not graded</span>
                )}
                <span className={styles.at}>{when(row.at)}</span>
                {row.score !== null ? (
                  <span className={`${styles.score} ${band(row.score)}`}>{row.score}</span>
                ) : (
                  <span className={`${styles.score} ${styles.none}`}>—</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
