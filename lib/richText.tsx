/**
 * Rendering for model-authored prose — bug reports, design briefs, interviewer
 * replies.
 *
 * Generated prompts are markdown-flavoured but arrive as one long string:
 * `identifiers` in backticks, **emphasis**, and enumerations the model usually
 * runs together inline ("Two incidents last week: 1. … 2. …") instead of on
 * their own lines. Rendered as plain text that becomes a wall of prose with
 * literal backticks in it — and the bug report is the one thing on the page the
 * user has to read carefully, so it is the worst place to lose scannability.
 *
 * Deliberately not a markdown library. The input is a paragraph of prose rather
 * than a document, so the whole surface is inline code, bold, and lists; and
 * everything becomes React nodes rather than an HTML string, so untrusted model
 * output can never turn into markup.
 */
import { Fragment, type ReactNode } from "react";

/** A heading, a bullet/number list, or a run of plain prose. */
export type Block =
  | { kind: "p"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: string[] };

// Bold before italic: the alternation is ordered so `**x**` is never consumed as
// an italic `*` pair. Italics stay on one line so a lone `*` in prose (or a
// glob like `*.py`) can't italicise the rest of the paragraph.
const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g;

/**
 * Render `code` spans, **bold**, and *emphasis*. Anything unmatched passes
 * through as text, so a stray backtick or asterisk degrades to a literal
 * character instead of eating the rest of the paragraph.
 */
export function renderInline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={i}>{part.slice(1, -1)}</code>;
    }
    // Emphasis recurses: a PR description written by an agent nests these
    // constantly (**`path/to/file.py`**), and rendering the inner span as plain
    // text left the backticks visible on screen. Each level strips its own
    // delimiters, so the recursion always shrinks.
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={i}>{renderInline(part.slice(2, -2))}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={i}>{renderInline(part.slice(1, -1))}</em>;
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

/** Leading `- ` / `* ` / `1. ` on its own line. */
const LINE_MARKER = /^\s*(?:[-*]|\d+\.)\s+/;

/** An ATX heading line (`## Summary`), as PR descriptions are structured with. */
const HEADING = /^(#{1,6})\s+(.*)$/;

/**
 * Pull an inline enumeration out of a paragraph, returning the lead-in prose and
 * the items — or null when the paragraph is just prose.
 *
 * Two guards keep ordinary sentences from being shredded, because a bare
 * quantity looks exactly like a list marker: "a partial reservation for 2. When
 * the warehouse restocked…" must stay one sentence while "…than the first call.
 * 2. A shipping-webhook retry…" must split.
 *
 *  1. a marker either opens the paragraph or follows a clause end (`.`/`:`/`;`),
 *     which rejects "for 2." because "for" is not punctuation;
 *  2. markers must run 1, 2, 3… in order, so an out-of-sequence number is read
 *     as prose rather than as the start of a list.
 */
function splitEnumeration(text: string): { lead: string; items: string[] } | null {
  const marks: { start: number; end: number }[] = [];
  const re = /(\d+)\.\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(0, m.index).trimEnd();
    const positioned = before.length === 0 || /[.:;]$/.test(before);
    if (!positioned) continue;
    if (Number(m[1]) !== marks.length + 1) continue;
    marks.push({ start: m.index, end: m.index + m[0].length });
  }
  // A lone "1." is a numbered sentence, not a list worth restructuring.
  if (marks.length < 2) return null;

  const items = marks.map(({ end }, i) => {
    const to = i + 1 < marks.length ? marks[i + 1].start : text.length;
    return text.slice(end, to).trim();
  });
  return { lead: text.slice(0, marks[0].start).trim(), items };
}

/**
 * Split prose into renderable blocks: blank lines separate paragraphs, lines
 * opening with a bullet or number become list items, and a paragraph carrying an
 * inline enumeration is broken into its lead-in plus a list.
 */
export function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];

  for (const chunk of text.trim().split(/\n{2,}/)) {
    const lines = chunk.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;

    // Headings are their own block even when they share a chunk with the prose
    // that follows, since a model doesn't reliably leave a blank line after one.
    if (lines.some((l) => HEADING.test(l))) {
      let prose: string[] = [];
      const flush = () => {
        if (prose.length) blocks.push(...splitBlocks(prose.join("\n")));
        prose = [];
      };
      for (const line of lines) {
        const heading = HEADING.exec(line);
        if (!heading) {
          prose.push(line);
          continue;
        }
        flush();
        blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() });
      }
      flush();
      continue;
    }

    // A chunk written as real lines: keep the author's own structure.
    if (lines.length > 1 && lines.every((l) => LINE_MARKER.test(l))) {
      blocks.push({
        kind: "list",
        ordered: /^\s*\d+\./.test(lines[0]),
        items: lines.map((l) => l.replace(LINE_MARKER, "").trim()),
      });
      continue;
    }

    const paragraph = lines.join(" ").trim();
    const enumerated = splitEnumeration(paragraph);
    if (!enumerated) {
      blocks.push({ kind: "p", text: paragraph });
      continue;
    }
    if (enumerated.lead) blocks.push({ kind: "p", text: enumerated.lead });
    blocks.push({ kind: "list", ordered: true, items: enumerated.items });
  }

  return blocks;
}

/** Model prose as paragraphs and lists, with inline code and bold. */
export function RichText({ text, className }: { text: string; className?: string }) {
  const blocks = splitBlocks(text);

  return (
    <div className={className}>
      {blocks.map((block, i) => {
        if (block.kind === "p") return <p key={i}>{renderInline(block.text)}</p>;
        if (block.kind === "heading") {
          // Clamped to h4-h6: this renders inside a page that already has an h1
          // and an h2, and a PR description's "## Summary" is not a peer of those.
          const Tag = `h${Math.min(6, block.level + 3)}` as "h4" | "h5" | "h6";
          return <Tag key={i}>{renderInline(block.text)}</Tag>;
        }
        const List = block.ordered ? "ol" : "ul";
        return (
          <List key={i}>
            {block.items.map((item, j) => (
              <li key={j}>{renderInline(item)}</li>
            ))}
          </List>
        );
      })}
    </div>
  );
}
