/**
 * The block splitter's only hard job is telling a list marker from a quantity.
 * Generated bug reports contain both, often in the same sentence, so these cases
 * are taken verbatim from a real generated problem ("Fulfilment service: retries
 * corrupt inventory counts") rather than invented.
 */
import { describe, expect, it } from "vitest";
import { isValidElement } from "react";
import { renderInline, splitBlocks } from "../lib/richText";

/** The element types renderInline produced, in order, for easy assertions. */
function inlineTypes(text: string): string[] {
  return renderInline(text)
    .filter((node) => isValidElement(node) && typeof node.type === "string")
    .map((node) => (isValidElement(node) ? String(node.type) : ""));
}

const REAL_BUG_REPORT = [
  "Our order-fulfilment service is fed by a queue that retries aggressively (at-least-once delivery), so",
  "`FulfilmentService.reserve()` and `FulfilmentService.advance()` get called more than once with the same",
  "arguments all the time. Two incidents from last week: 1. A customer ordered 5 of SKU `B` when only 2 were",
  "on hand. We created a partial reservation for 2. When the warehouse restocked and the intake queue",
  "redelivered the *same* message (same `request_id`), inventory ended up showing 7 units of `B` reserved",
  "for a 5-unit order. 2. A shipping-webhook retry called `advance(order_id, \"shipped\")` a second time for",
  "an order that was already shipped and blew up with `InvalidTransition`.",
].join(" ");

describe("splitBlocks", () => {
  it("splits an inline enumeration into a lead paragraph plus a list", () => {
    const blocks = splitBlocks(REAL_BUG_REPORT);

    expect(blocks.map((b) => b.kind)).toEqual(["p", "list"]);
    const list = blocks[1];
    if (list.kind !== "list") throw new Error("expected a list");
    expect(list.ordered).toBe(true);
    expect(list.items).toHaveLength(2);
    expect(blocks[0].kind === "p" && blocks[0].text).toMatch(/Two incidents from last week:$/);
  });

  it("does not treat a quantity that ends a sentence as a list marker", () => {
    const blocks = splitBlocks(REAL_BUG_REPORT);
    const list = blocks[1];
    if (list.kind !== "list") throw new Error("expected a list");

    // "…a partial reservation for 2. When the warehouse restocked…" is one
    // sentence inside item 1 — splitting there would strand "When the warehouse
    // restocked" as its own bogus item.
    expect(list.items[0]).toContain("partial reservation for 2. When the warehouse restocked");
    expect(list.items[1]).toMatch(/^A shipping-webhook retry/);
  });

  it("leaves prose with a single numbered reference alone", () => {
    const blocks = splitBlocks("The worker crashed on shard 3. Restarting it cleared the backlog.");
    expect(blocks).toEqual([
      { kind: "p", text: "The worker crashed on shard 3. Restarting it cleared the backlog." },
    ]);
  });

  it("ignores an out-of-sequence number", () => {
    // "5." never opens a list here: the sequence must start at 1.
    const blocks = splitBlocks("Retry budget is exhausted after 5. Then the job is parked.");
    expect(blocks.map((b) => b.kind)).toEqual(["p"]);
  });

  it("keeps author-written line lists, ordered and unordered", () => {
    const bullets = splitBlocks("Checks:\n\n- bounded retries\n- an idempotency key\n* a dead-letter queue");
    expect(bullets[0]).toEqual({ kind: "p", text: "Checks:" });
    expect(bullets[1]).toEqual({
      kind: "list",
      ordered: false,
      items: ["bounded retries", "an idempotency key", "a dead-letter queue"],
    });

    const numbered = splitBlocks("1. read the diff\n2. leave a comment");
    expect(numbered).toEqual([
      { kind: "list", ordered: true, items: ["read the diff", "leave a comment"] },
    ]);
  });

  it("marks up code, bold, and emphasis inline", () => {
    expect(inlineTypes("call `reserve()` twice")).toEqual(["code"]);
    expect(inlineTypes("the **same** message")).toEqual(["strong"]);
    // Bold must not be mistaken for a pair of italics.
    expect(inlineTypes("redelivered the *same* message")).toEqual(["em"]);
    expect(inlineTypes("`a` and **b** and *c*")).toEqual(["code", "strong", "em"]);
  });

  it("leaves a lone asterisk or backtick as literal text", () => {
    // A glob or an unclosed span must not swallow the rest of the paragraph.
    expect(inlineTypes("match *.py files")).toEqual([]);
    expect(inlineTypes("an unclosed `span here")).toEqual([]);
  });

  it("separates paragraphs on blank lines", () => {
    expect(splitBlocks("First para.\n\nSecond para.")).toEqual([
      { kind: "p", text: "First para." },
      { kind: "p", text: "Second para." },
    ]);
  });
});

/**
 * PR descriptions are the one input written as a structured document rather than
 * a paragraph: generation asks for '## Summary' / '## Changes' / '## Testing'
 * with bolded file paths, so headings and nested emphasis have to survive.
 */
describe("splitBlocks on PR-description markdown", () => {
  it("promotes ATX headings to their own block", () => {
    const blocks = splitBlocks("## Summary\n\nWe fixed the thing.\n\n## Testing\n\nSuite is green.");
    expect(blocks).toEqual([
      { kind: "heading", level: 2, text: "Summary" },
      { kind: "p", text: "We fixed the thing." },
      { kind: "heading", level: 2, text: "Testing" },
      { kind: "p", text: "Suite is green." },
    ]);
  });

  it("splits a heading off prose that follows it without a blank line", () => {
    const blocks = splitBlocks("## Summary\nWe fixed the thing.");
    expect(blocks).toEqual([
      { kind: "heading", level: 2, text: "Summary" },
      { kind: "p", text: "We fixed the thing." },
    ]);
  });

  it("keeps a heading with the list under it", () => {
    const blocks = splitBlocks("## Changes\n- added a store\n- wired the route");
    expect(blocks).toEqual([
      { kind: "heading", level: 2, text: "Changes" },
      { kind: "list", ordered: false, items: ["added a store", "wired the route"] },
    ]);
  });

  it("does not treat a mid-sentence hash as a heading", () => {
    expect(splitBlocks("Fixes issue #2291 in the ledger.")).toEqual([
      { kind: "p", text: "Fixes issue #2291 in the ledger." },
    ]);
  });

  it("renders code nested inside bold rather than leaking backticks", () => {
    // `**`billing/money.py`**` is how an agent writes a file heading in a bullet.
    const nodes = renderInline("**`billing/money.py`** (new): parses amounts");
    const strong = nodes.find((n) => isValidElement(n) && n.type === "strong");
    expect(strong).toBeTruthy();
    // The bold's child is a <code>, not a literal backticked string.
    const inner = (strong as { props: { children: unknown[] } }).props.children;
    const hasCode = (inner as unknown[]).some((c) => isValidElement(c) && c.type === "code");
    expect(hasCode).toBe(true);
  });
});
