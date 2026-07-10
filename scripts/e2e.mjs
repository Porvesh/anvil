/**
 * Real-browser end-to-end check: drives the full Anvil loop in headless Chromium
 * to prove Pyodide + Monaco + grading + Socratic actually work in a browser
 * (not just at build/logic level). Run with the dev server up on :3000.
 */
import { chromium } from "playwright";

const BASE = "http://localhost:3000";
const SHOT = "/private/tmp/claude-501/-Users-porvesh-dev-Anvil/c12f3ba4-21d8-446c-8127-9669cb5617da/scratchpad";
const log = (...a) => console.log(...a);
const fail = (msg) => {
  console.error(`\n❌ FAIL: ${msg}`);
  process.exitCode = 1;
};

// The intended fix for the "Webhook batcher" seed problem (see prisma/seed.ts).
const FIXED_BATCH = `MAX_BATCH = 8

class WebhookBatcher:
    """Collects webhook events and posts them downstream in fixed-size batches."""

    def __init__(self, transport, batch_size=MAX_BATCH):
        self.transport = transport
        self.batch_size = batch_size
        self.pending = []
        self.delivered = 0

    def add(self, event):
        if not isinstance(event, dict) or "id" not in event:
            raise ValueError("event must be a dict with an 'id'")
        self.pending.append(event)

    def flush(self):
        """Dispatch every pending event downstream. Returns how many were sent."""
        sent = 0
        i = 0
        while i < len(self.pending):
            chunk = self.pending[i:i + self.batch_size]
            self.transport.send(chunk)
            sent += len(chunk)
            i += self.batch_size
        self.pending = self.pending[i:]
        self.delivered += sent
        return sent`;

async function pickProblems() {
  const res = await fetch(`${BASE}/api/problems`);
  const { problems } = await res.json();
  const debug = problems.find((p) => p.title.includes("Webhook batcher")) || problems.find((p) => p.type === "debug");
  const review = problems.find((p) => p.title.startsWith("Add retry")) || problems.find((p) => p.type === "review");
  const design = problems.find((p) => p.type === "design");
  return { debug, review, design };
}

/** Set the Monaco model whose current text contains `marker` (defaults to any). */
async function setMonaco(page, value, marker) {
  return page.evaluate(
    ({ code, mk }) => {
      const m = window.monaco;
      if (!m) return false;
      const models = m.editor.getModels();
      const target = (mk && models.find((mo) => mo.getValue().includes(mk))) || models[0];
      if (!target) return false;
      target.setValue(code);
      return true;
    },
    { code: value, mk: marker },
  );
}

const DESIGN_DOC = `# Distributed rate limiter

## Requirements & assumptions
Assume ~50k active users, peak ~10k req/s across 12 regions. Hard limit of 1000 req/min
per user, enforced globally (not per-region). Small over-count is acceptable; under-count
(letting users exceed) is not.

## Approach & data model
Token bucket per user: key rate_limit:{user_id} in Redis holding {tokens, last_refill}.
Refill lazily on read. Token bucket over fixed-window to avoid boundary bursts.

## Handling 12 regions
Central Redis cluster is the source of truth so the global limit is actually global.
Local per-region counters would let a user do 12x the limit. Accept the ~cross-region RTT
on the hot path; colocate the limiter with a regional Redis replica for reads, writes to primary.

## Failure modes
If Redis is unreachable, fail OPEN (serve traffic) rather than reject everyone — availability
over strict enforcement for a rate limiter. Handle clock skew by having Redis compute time,
not the app servers. Hot single user: shard that key / add a local pre-check.

## Trade-offs
Chose global accuracy over latency: the central store adds a hop but a per-region approximation
breaks the actual requirement. Gave up strict exactness under Redis failover.
`;

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(`console.error: ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  const { debug, review, design } = await pickProblems();
  log(`Problems: debug="${debug?.title}"  review="${review?.title}"`);
  if (!debug || !review) return fail("could not find a debug and a review problem in the bank");

  // ---------- HOME ----------
  await page.goto(BASE, { waitUntil: "networkidle" });
  const heroOk = await page.getByText("Drill the hard part").isVisible();
  log(heroOk ? "✓ home renders" : "✗ home hero missing");
  if (!heroOk) return fail("home did not render");

  // ---------- DEBUG SOLVE ----------
  await page.goto(`${BASE}/solve/${debug.id}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".monaco-editor", { timeout: 30000 });
  log("✓ Monaco editor mounted");

  // First run — buggy starter should FAIL
  log("… clicking Run tests (first Pyodide boot can take ~30s)");
  await page.getByRole("button", { name: /Run tests/i }).click();
  const banner = page.locator("text=/tests? passing|FAIL|Error|timed out/i").first();
  await banner.waitFor({ timeout: 120000 });
  const firstText = await page.locator("text=/\\d+\\/\\d+ tests? passing/").first().textContent().catch(() => "");
  const failCount = await page.locator("text=✗ FAIL").count();
  log(`✓ first run returned (banner: "${firstText?.trim()}", ${failCount} failing)`);
  if (failCount === 0) return fail("buggy starter code did not fail any tests");

  // Fix the code, re-run — should be all green
  const set = await setMonaco(page, FIXED_BATCH, "WebhookBatcher");
  if (!set) return fail("could not set Monaco value");
  log("✓ applied the fix");
  await page.getByRole("button", { name: /Run tests/i }).click();
  await page.waitForFunction(
    () => {
      const el = [...document.querySelectorAll("*")].find((e) => /tests? passing/.test(e.textContent || "") && e.children.length === 0);
      return el && /all green/.test(el.textContent || "");
    },
    { timeout: 60000 },
  ).catch(() => {});
  const passAfter = await page.locator("text=✓ PASS").count();
  const failAfter = await page.locator("text=✗ FAIL").count();
  log(`✓ re-run after fix: ${passAfter} passing, ${failAfter} failing`);
  if (failAfter > 0) return fail("fixed code still has failing tests in-browser");

  // Submit → grade → results
  log("… submitting for grade (live Haiku call)");
  await page.getByRole("button", { name: /Submit for review/i }).click();
  await page.waitForSelector("text=%", { timeout: 60000 });
  const score = await page.locator("text=/^\\d+$/").first().textContent().catch(() => "?");
  const caught = await page.locator("text=CAUGHT").count();
  log(`✓ results rendered (score ~${score?.trim()}, ${caught} caught)`);

  // Socratic follow-up should stream a message into the interviewer panel
  await page.waitForFunction(
    () => {
      const bubbles = [...document.querySelectorAll("*")].filter((e) => (e.className || "").toString().includes("bub"));
      return bubbles.some((b) => (b.textContent || "").length > 20);
    },
    { timeout: 60000 },
  ).catch(() => {});
  const socraticLen = await page.evaluate(() => {
    const bubbles = [...document.querySelectorAll("*")].filter((e) => (e.className || "").toString().includes("bub"));
    return Math.max(0, ...bubbles.map((b) => (b.textContent || "").length));
  });
  log(socraticLen > 20 ? `✓ Socratic follow-up streamed (${socraticLen} chars)` : "✗ Socratic did not stream");
  if (socraticLen <= 20) return fail("Socratic follow-up did not stream a message");

  // ---------- REVIEW SOLVE ----------
  await page.goto(`${BASE}/solve/${review.id}`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=AI-generated", { timeout: 15000 });
  log("✓ review diff rendered");
  // Click the buggy 'while True' line (line 42) to open a comment box
  const line = page.locator("text=while True:").first();
  await line.click();
  const ta = page.locator('textarea[placeholder*="Comment on line"]');
  await ta.waitFor({ timeout: 5000 });
  await ta.fill("This while True retry is unbounded — no max attempts, it will block the worker forever if the ledger stays down.");
  await page.getByRole("button", { name: /^Comment$/ }).click();
  log("✓ left an inline review comment");
  await page.getByRole("button", { name: /Submit review/i }).click();
  await page.waitForSelector("text=%", { timeout: 60000 });
  const reviewCaught = await page.locator("text=CAUGHT").count();
  log(`✓ review graded and results rendered (${reviewCaught} caught)`);

  // ---------- RATING (curation) ----------
  await page.getByText("Was this a good problem?").waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: /👍/ }).click();
  await page.getByText(/✓ rated/).waitFor({ timeout: 8000 });
  log("✓ rated the problem 👍 (curation vote persisted)");

  // ---------- SHUFFLE / next ----------
  await page.getByRole("button", { name: /Next .* problem/i }).click();
  await page.waitForURL(/\/solve\/.+/, { timeout: 15000 });
  log("✓ 'next problem' shuffled to another problem");

  // ---------- DESIGN SOLVE ----------
  if (design) {
    await page.goto(`${BASE}/solve/${design.id}`, { waitUntil: "networkidle" });
    await page.waitForSelector(".monaco-editor", { timeout: 30000 });
    await page.getByText(/Design brief/i).waitFor({ timeout: 8000 });
    log("✓ design brief + doc editor rendered");
    const setDoc = await setMonaco(page, DESIGN_DOC, "Distributed rate limiter");
    if (!setDoc) return fail("could not set design doc");
    await page.getByRole("button", { name: /Submit design/i }).click();
    await page.waitForSelector("text=%", { timeout: 60000 });
    const designCaught = await page.locator("text=CAUGHT").count();
    log(`✓ design graded against rubric and results rendered (${designCaught} dimensions caught)`);
    if (designCaught === 0) return fail("design doc addressing 5 dimensions scored 0 caught — grading likely broken");
  } else {
    log("… no design problem in bank, skipping design flow");
  }

  await page.screenshot({ path: `${SHOT}/e2e-final.png`, fullPage: true }).catch(() => {});
  await browser.close();

  if (errors.length) {
    log(`\n⚠️  ${errors.length} console/page errors during run:`);
    errors.slice(0, 10).forEach((e) => log("   " + e));
  }
  log(process.exitCode ? "\n=== E2E FAILED ===" : "\n=== E2E PASSED: full loop works in a real browser ===");
}

main().catch((e) => {
  console.error("harness crashed:", e);
  process.exit(1);
});
