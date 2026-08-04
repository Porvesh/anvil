"use client";

import { useState } from "react";
import type { DiffHunk, DiffLineKind, PrMeta, ReviewComment } from "@/lib/types";
import { RichText } from "@/lib/richText";
import { IconSparkle } from "@/lib/icons";
import styles from "./ReviewPane.module.css";

// The domain kind "context" maps to the `.ctx` class; add/del match directly.
const KIND_CLASS: Record<DiffLineKind, string> = {
  context: styles.ctx,
  add: styles.add,
  del: styles.del,
};

/** Stable DOM id for a file's section, so the jump chips can target it. */
function fileAnchor(path: string): string {
  return `diff-${path.replace(/[^a-zA-Z0-9]/g, "-")}`;
}

/** `billing/webhooks/dedupe.py` → `dedupe.py`, for the narrow jump chips. */
function shortPath(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The sign column: what changed on this row, as its own aligned character. */
const KIND_SIGN: Record<DiffLineKind, string> = { add: "+", del: "−", context: "" };

/**
 * Where numbered lines skip ahead, and by how much — `idx → hidden count`.
 *
 * A diff that jumps from line 40 to line 388 means ~350 unchanged lines the PR
 * didn't touch. Rendered without a marker the file reads as continuous, and a
 * reviewer's mental model of "what's near this code" is silently wrong.
 */
function gapsFor(hunk: DiffHunk): Map<number, number> {
  const gaps = new Map<number, number>();
  let prev: number | null = null;
  hunk.lines.forEach((line, idx) => {
    if (line.lineNo === null) return; // deleted lines carry no new-file number
    if (prev !== null && line.lineNo > prev + 1) gaps.set(idx, line.lineNo - prev - 1);
    prev = line.lineNo;
  });
  return gaps;
}

/**
 * Review work surface (spec §6, §10): a GitHub-style PR diff with inline comment
 * threads. Diff-centric, no editing. Comments anchor to the new-file line number
 * (`lineNo`) — the same coordinate system the answer key uses for grading, so a
 * comment on a buggy line is a "catch".
 *
 * Design note: the seeded-flaw count is intentionally NOT shown — a real PR
 * doesn't come with a bug-count, and revealing N destroys the precision /
 * recall trade-off we grade on (users would just drop comments until they
 * hit N). Count is revealed on the results screen, not here.
 */
export function ReviewPane({
  title,
  prompt,
  prMeta,
  diff,
  comments,
  onAddComment,
  onRemoveComment,
  readOnly = false,
}: {
  title: string;
  prompt: string;
  prMeta: PrMeta | null;
  diff: DiffHunk[];
  comments: ReviewComment[];
  onAddComment: (file: string, line: number, body: string) => void;
  onRemoveComment: (index: number) => void;
  /**
   * Render an already-submitted review: comments show, but lines don't invite
   * new ones and existing ones can't be removed. Used by the recorded demo.
   */
  readOnly?: boolean;
}) {
  // Keyed by file as well as line: line numbers restart in every file, so a
  // line-only key opened the composer on the same-numbered line of every file at
  // once and rendered each thread under all of them.
  const [open, setOpen] = useState<{ file: string; line: number } | null>(null);
  const [draft, setDraft] = useState("");

  const commented = new Set(comments.map((c) => `${c.file ?? ""}:${c.line}`));

  function commentsFor(file: string, line: number) {
    return comments.map((c, i) => ({ c, i })).filter(({ c }) => c.line === line && (c.file ?? file) === file);
  }

  function submit(file: string, line: number) {
    const body = draft.trim();
    if (!body) return;
    onAddComment(file, line, body);
    setDraft("");
    setOpen(null);
  }

  return (
    <div className={styles.pane}>
      <div className={styles.prhead}>
        <div className={styles.row1}>
          <h2>{title}</h2>
          {prMeta?.aiGenerated && (
            <span className={styles.aiflag}>
              <IconSparkle /> AI-generated
            </span>
          )}
        </div>
        {prMeta && (
          <div className={styles.meta}>
            #{prMeta.number} · {prMeta.branch} · +{prMeta.additions} −{prMeta.deletions} · {prMeta.files}{" "}
            {prMeta.files === 1 ? "file" : "files"}
          </div>
        )}
        <RichText className={styles.desc} text={prompt} />

        {/* Files changed, with a jump for each. A five-file PR is a lot of
            scrolling to even learn what it touches, and knowing the shape of a
            change before reading it is most of how a reviewer decides where to
            look first. */}
        {diff.length > 1 && (
          <div className={styles.filelist}>
            <span className={styles.filelistLabel}>{diff.length} files changed</span>
            {diff.map((hunk) => {
              const added = hunk.lines.filter((l) => l.kind === "add").length;
              const commentCount = comments.filter((c) => c.file === hunk.file).length;
              return (
                <button
                  key={hunk.file}
                  className={styles.filechip}
                  onClick={() => document.getElementById(fileAnchor(hunk.file))?.scrollIntoView({ block: "start" })}
                  title={`Jump to ${hunk.file}`}
                >
                  {shortPath(hunk.file)}
                  <span className={styles.filechipAdd}>+{added}</span>
                  {commentCount > 0 && <span className={styles.filechipDot} aria-label={`${commentCount} comments`} />}
                </button>
              );
            })}
          </div>
        )}

        <div className={styles.progress}>
          <span className={styles.progressCount}>
            {comments.length} {comments.length === 1 ? "comment" : "comments"} left
          </span>
        </div>
        <div className={styles.guidance}>
          {readOnly
            ? "A submitted review. The comments below are what the reviewer left."
            : "Click any line to comment. Review it like you'd review a teammate's PR."}
        </div>
      </div>

      {diff.map((hunk) => {
        const added = hunk.lines.filter((l) => l.kind === "add").length;
        const removed = hunk.lines.filter((l) => l.kind === "del").length;
        const gaps = gapsFor(hunk);
        const slash = hunk.file.lastIndexOf("/");
        return (
        <div key={hunk.file} style={{ display: "contents" }}>
          <div className={styles.difffile} id={fileAnchor(hunk.file)}>
            <span className={styles.diffpath}>
              {slash >= 0 && <span className={styles.diffdir}>{hunk.file.slice(0, slash + 1)}</span>}
              <b>{shortPath(hunk.file)}</b>
            </span>
            <span className={styles.diffcounts}>
              {added > 0 && <span className={styles.countAdd}>+{added}</span>}
              {removed > 0 && <span className={styles.countDel}>−{removed}</span>}
            </span>
          </div>
          <div className={styles.diff}>
            {hunk.lines.map((line, idx) => {
              // Deleted lines have no new-file number, so they can neither
              // carry a comment nor anchor one. `commentable` additionally
              // requires the pane to be editable — but existing threads must
              // still render read-only, so they key off `numbered`.
              const numbered = line.lineNo !== null;
              const commentable = numbered && !readOnly;
              const threads = numbered ? commentsFor(hunk.file, line.lineNo!) : [];
              const hasComment = numbered && commented.has(`${hunk.file}:${line.lineNo}`);
              const isOpen = open?.file === hunk.file && open?.line === line.lineNo;
              const gap = gaps.get(idx);
              return (
                <div key={idx} style={{ display: "contents" }}>
                  {gap !== undefined && (
                    <div className={styles.gapline} aria-label={`${gap} unchanged lines not shown`}>
                      <span className={styles.gapg}>⋮</span>
                      <span>{gap} unchanged {gap === 1 ? "line" : "lines"} not shown</span>
                    </div>
                  )}
                  <div
                    className={`${styles.dl} ${KIND_CLASS[line.kind]} ${commentable ? styles.commentable : ""} ${hasComment ? styles.hasComment : ""}`}
                    onClick={() => commentable && setOpen(isOpen ? null : { file: hunk.file, line: line.lineNo! })}
                    title={commentable ? `Comment on ${hunk.file} line ${line.lineNo}` : undefined}
                  >
                    <span className={styles.g}>{line.lineNo ?? ""}</span>
                    <span className={styles.sign} aria-hidden>
                      {KIND_SIGN[line.kind]}
                    </span>
                    <span className={styles.code}>{line.content}</span>
                  </div>

                  {threads.length > 0 && (
                    <div className={styles.thread}>
                      {threads.map(({ c, i }) => (
                        <div key={i} className={styles.comment}>
                          <div className={styles.who}>
                            <span className={styles.whoChip}>you</span>
                            <span className={styles.whoRef}>
                              {shortPath(c.file ?? hunk.file)}:{c.line}
                            </span>
                          </div>
                          {c.body}
                          {!readOnly && (
                            <button className={styles.remove} onClick={() => onRemoveComment(i)} aria-label="Remove comment">
                              remove
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {commentable && isOpen && (
                    <div className={styles.thread}>
                      <div className={styles.addcomment}>
                        <textarea
                          autoFocus
                          spellCheck={false}
                          placeholder={`Comment on line ${line.lineNo} — what breaks, and when?`}
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(hunk.file, line.lineNo!);
                            if (e.key === "Escape") {
                              setOpen(null);
                              setDraft("");
                            }
                          }}
                        />
                        <div className={styles.actions}>
                          <span className={styles.kbdHint}>⌘↵ to comment · esc to cancel</span>
                          <button
                            className={`${styles.mini} ${styles.miniGhost}`}
                            onClick={() => {
                              setOpen(null);
                              setDraft("");
                            }}
                          >
                            Cancel
                          </button>
                          <button className={`${styles.mini} ${styles.miniBlue}`} onClick={() => submit(hunk.file, line.lineNo!)}>
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
        );
      })}
    </div>
  );
}
