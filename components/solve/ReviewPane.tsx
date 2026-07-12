"use client";

import { useState } from "react";
import type { DiffHunk, DiffLineKind, PrMeta, ReviewComment } from "@/lib/types";
import styles from "./ReviewPane.module.css";

// The domain kind "context" maps to the `.ctx` class; add/del match directly.
const KIND_CLASS: Record<DiffLineKind, string> = {
  context: styles.ctx,
  add: styles.add,
  del: styles.del,
};

/**
 * Review work surface (spec §6, §10): a GitHub-style PR diff with inline comment
 * threads. Diff-centric, no editing. Comments anchor to the new-file line number
 * (`lineNo`) — the same coordinate system the answer key uses for grading, so a
 * comment on a buggy line is a "catch".
 */
export function ReviewPane({
  title,
  prompt,
  prMeta,
  diff,
  comments,
  onAddComment,
  onRemoveComment,
}: {
  title: string;
  prompt: string;
  prMeta: PrMeta | null;
  diff: DiffHunk[];
  comments: ReviewComment[];
  onAddComment: (line: number, body: string) => void;
  onRemoveComment: (index: number) => void;
}) {
  const [openLine, setOpenLine] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  function commentsFor(line: number) {
    return comments.map((c, i) => ({ c, i })).filter(({ c }) => c.line === line);
  }

  function submit(line: number) {
    const body = draft.trim();
    if (!body) return;
    onAddComment(line, body);
    setDraft("");
    setOpenLine(null);
  }

  return (
    <div className={styles.pane}>
      <div className={styles.prhead}>
        <div className={styles.row1}>
          <h2>{title}</h2>
          {prMeta?.aiGenerated && <span className={styles.aiflag}>◆ AI-generated</span>}
        </div>
        {prMeta && (
          <div className={styles.meta}>
            #{prMeta.number} · {prMeta.branch} · +{prMeta.additions} −{prMeta.deletions} · {prMeta.files} file
          </div>
        )}
        <div className={styles.desc}>{prompt}</div>
      </div>

      {diff.map((hunk) => (
        <div key={hunk.file} style={{ display: "contents" }}>
          <div className={styles.difffile}>{hunk.file}</div>
          <div className={styles.diff}>
            {hunk.lines.map((line, idx) => {
              const commentable = line.lineNo !== null;
              const threads = commentable ? commentsFor(line.lineNo!) : [];
              return (
                <div key={idx} style={{ display: "contents" }}>
                  <div
                    className={`${styles.dl} ${KIND_CLASS[line.kind]} ${commentable ? styles.commentable : ""}`}
                    onClick={() => commentable && setOpenLine(openLine === line.lineNo ? null : line.lineNo)}
                  >
                    <span className={styles.g}>{line.lineNo ?? ""}</span>
                    <span className={styles.code}>{line.content}</span>
                  </div>

                  {threads.length > 0 && (
                    <div className={styles.thread}>
                      {threads.map(({ c, i }) => (
                        <div key={i} className={styles.comment}>
                          <div className={styles.who}>you</div>
                          {c.body}
                          <button className={styles.remove} onClick={() => onRemoveComment(i)}>
                            remove
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {commentable && openLine === line.lineNo && (
                    <div className={styles.thread}>
                      <div className={styles.addcomment}>
                        <textarea
                          autoFocus
                          spellCheck={false}
                          placeholder={`Comment on line ${line.lineNo}…`}
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(line.lineNo!);
                          }}
                        />
                        <div className={styles.actions}>
                          <button
                            className={`${styles.mini} ${styles.miniGhost}`}
                            onClick={() => {
                              setOpenLine(null);
                              setDraft("");
                            }}
                          >
                            Cancel
                          </button>
                          <button className={`${styles.mini} ${styles.miniBlue}`} onClick={() => submit(line.lineNo!)}>
                            Comment
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
