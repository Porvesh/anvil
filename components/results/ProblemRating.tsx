"use client";

import { useState } from "react";
import { getSessionId } from "@/lib/session";
import { IconFlag, IconThumbsDown, IconThumbsUp } from "@/lib/icons";
import styles from "./ProblemRating.module.css";

/**
 * Post-solve rating (spec §16 v2). The crowd curates the bank: a 👍/👎 feeds the
 * quality ranking, and enough downvotes retire a weak problem so we stop serving
 * it — which is how the bank improves without re-running generation. Optimistic
 * UI; one vote per session, re-clickable to change or clear.
 */
export function ProblemRating({ problemId }: { problemId: string }) {
  const [your, setYour] = useState<1 | -1 | 0>(0);
  const [counts, setCounts] = useState<{ up: number; down: number } | null>(null);
  const [retired, setRetired] = useState(false);
  const [busy, setBusy] = useState(false);

  async function vote(value: 1 | -1) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/problems/${problemId}/vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: getSessionId(), value }),
      });
      if (res.ok) {
        const data = await res.json();
        setYour(data.your);
        setCounts({ up: data.upvotes, down: data.downvotes });
        setRetired(data.retired);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.ask}>
        <b>Was this a good problem?</b>
        <span className={styles.sub}>
          Your rating curates the shared bank — strong problems rise, weak ones get retired.
        </span>
      </div>
      <div className={styles.buttons}>
        {retired ? (
          <span className={styles.retired}>
            <IconFlag /> retired from the bank — thanks for the signal
          </span>
        ) : your !== 0 ? (
          <span className={styles.thanks}>✓ rated — thanks</span>
        ) : null}
        <button
          className={`${styles.vote} ${styles.up} ${your === 1 ? styles.on : ""}`}
          onClick={() => vote(1)}
          disabled={busy}
          aria-label="Good problem"
        >
          <IconThumbsUp /> <span className={styles.count}>{counts ? counts.up : ""}</span>
        </button>
        <button
          className={`${styles.vote} ${styles.down} ${your === -1 ? styles.on : ""}`}
          onClick={() => vote(-1)}
          disabled={busy}
          aria-label="Weak problem"
        >
          <IconThumbsDown /> <span className={styles.count}>{counts ? counts.down : ""}</span>
        </button>
      </div>
    </div>
  );
}
