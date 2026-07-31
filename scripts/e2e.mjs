/**
 * Real-browser end-to-end check: drives the full Anvil loop in headless Chromium
 * to prove Pyodide + Monaco + grading + Socratic actually work in a browser
 * (not just at build/logic level). Run with a server up at E2E_BASE_URL (or :3000).
 */
import os from "node:os";
import { chromium } from "playwright";

if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY && typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(".env");
  } catch {
    // CI injects the key directly; a missing local file is handled below.
  }
}
const E2E_PROVIDER = process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY ? "openai" : "anthropic";
const E2E_API_KEY = E2E_PROVIDER === "openai" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
const E2E_PROVIDER_LABEL = E2E_PROVIDER === "openai" ? "OpenAI" : "Anthropic";

const BASE = (process.env.E2E_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
// Screenshot target — was a hardcoded per-session temp dir from the machine the
// suite was written on, which silently failed everywhere else.
const SHOT = process.env.E2E_SHOT_DIR ?? os.tmpdir();
const log = (...a) => console.log(...a);
const fail = (msg) => {
  throw new Error(msg);
};

// The intended fix for webhooks/batcher.py in the "Webhook batcher" seed problem.
const FIXED_BATCH = `from .transport import Transport

MAX_BATCH = 8


class WebhookBatcher:
    """Collects webhook events and posts them downstream in fixed-size batches."""

    def __init__(self, transport: Transport, batch_size=MAX_BATCH):
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
        return sent
`;

/**
 * Assert the solve payload carries no ground truth. Checked on the wire rather
 * than in a unit test because this is the exact shape a browser receives, and
 * the bug it guards (a field surviving an object spread) is invisible to a
 * type check.
 */
async function assertNoGroundTruthLeak(id) {
  const res = await fetch(`${BASE}/api/problems/${id}`);
  const raw = await res.text();
  for (const field of ["answerKey", "answerKeyCount", "jdContext"]) {
    if (raw.includes(`"${field}"`)) {
      throw new Error(`LEAK: /api/problems/${id} exposed ${field} to the client`);
    }
  }
  log(`✓ solve payload withholds the answer key, its count, and the JD`);
}

async function pickProblems() {
  const res = await fetch(`${BASE}/api/problems`);
  const { problems } = await res.json();
  const debug = problems.find((p) => p.title.includes("Webhook batcher")) || problems.find((p) => p.type === "debug");
  // No preferred review problem: the debug leg needs the "Webhook batcher" seed
  // because it applies a known fix to it, but the review leg is problem-agnostic,
  // and naming a favourite here meant retiring that problem broke the suite.
  const review = problems.find((p) => p.type === "review");
  // The design leg injects a rate-limiter answer, so it needs the corresponding
  // rubric rather than whichever design problem was most recently banked.
  const design = problems.find((p) => p.title.includes("distributed rate limiter")) || problems.find((p) => p.type === "design");
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
  const health = await fetch(`${BASE}/api/problems`).catch(() => null);
  if (!health?.ok) {
    throw new Error(`Anvil is not reachable at ${BASE}. Start the app or set E2E_BASE_URL.`);
  }

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
  const heroOk = await page.getByText("Catch the bad PR").isVisible();
  log(heroOk ? "✓ home renders" : "✗ home hero missing");
  if (!heroOk) return fail("home did not render");
  if (!E2E_API_KEY) return fail("ANTHROPIC_API_KEY or OPENAI_API_KEY is required for the live BYOK E2E run");
  await page.getByRole("button", { name: "Connect an AI provider key" }).click();
  if (E2E_PROVIDER === "openai") await page.getByRole("button", { name: "OpenAI" }).click();
  await page.getByLabel(`${E2E_PROVIDER_LABEL} API key`).fill(E2E_API_KEY);
  await page.getByRole("button", { name: "Connect key", exact: true }).click();
  await page.getByRole("button", { name: `${E2E_PROVIDER_LABEL} API key connected` }).waitFor({ timeout: 20000 });
  const byokCookie = (await page.context().cookies(BASE)).find((cookie) => cookie.name === "anvil_byok");
  if (!byokCookie?.httpOnly || byokCookie.sameSite !== "Strict") {
    return fail("BYOK cookie is missing HttpOnly or SameSite=Strict protection");
  }
  if (byokCookie.value.includes(E2E_API_KEY) || (await page.evaluate(() => document.cookie.includes("anvil_byok")))) {
    return fail("BYOK credential is browser-readable");
  }
  log(`✓ user-owned ${E2E_PROVIDER_LABEL} key connected for this browser session`);
  await assertNoGroundTruthLeak(debug.id);

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
  // Multi-file: open the file that holds the bug before editing it.
  await page.getByRole("button", { name: /batcher\.py/ }).click();
  await page.waitForTimeout(400);
  const set = await setMonaco(page, FIXED_BATCH, "class WebhookBatcher");
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
  log("… submitting for grade (live judge call)");
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
  const reviewFiles = await page.locator("[class*='difffile']").count();
  log(`✓ review diff rendered (${reviewFiles} file section(s))`);

  // Comment on a line by coordinate rather than by matching source text: this
  // used to click a literal 'while True:' from one specific seeded problem, so
  // retiring that problem silently broke the whole review leg of the suite.
  // Any commentable added line exercises the same path.
  const commentable = page.locator("[title^='Comment on']");
  await commentable.first().waitFor({ timeout: 10000 });
  const anchor = commentable.nth(Math.min(3, (await commentable.count()) - 1));
  const anchorTitle = await anchor.getAttribute("title");
  await anchor.scrollIntoViewIfNeeded();
  await anchor.click();
  const ta = page.locator('textarea[placeholder*="Comment on line"]');
  await ta.waitFor({ timeout: 5000 });
  await ta.fill("This retry path looks unbounded and the error is swallowed — a transient failure here would loop or vanish silently.");
  await page.getByRole("button", { name: /^Comment$/ }).click();
  await page.waitForTimeout(300);
  // The comment must attach to the file it was left on, not merely to a line
  // number that also exists in the other files of a multi-file PR.
  const threads = await page.locator("[class*='comment']").filter({ hasText: "unbounded" }).count();
  if (threads !== 1) return fail(`expected 1 comment thread, found ${threads} (${anchorTitle})`);
  log(`✓ left an inline review comment (${anchorTitle}), attached to exactly one file`);
  await page.getByRole("button", { name: /Submit review/i }).click();
  await page.waitForSelector("text=%", { timeout: 60000 });
  const reviewCaught = await page.locator("text=CAUGHT").count();
  log(`✓ review graded and results rendered (${reviewCaught} caught)`);

  // ---------- RATING (curation) ----------
  await page.getByText("Was this a good problem?").waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: /Good problem/ }).click();
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

  // ---------- NAV ----------
  // Every top-bar entry pointed at "/" once, so a click appeared to do nothing.
  // Assert each lands on its own page AND is marked current there.
  await page.goto(BASE, { waitUntil: "networkidle" });
  for (const [label, path] of [
    ["Problem bank", "/bank"],
    ["History", "/history"],
    ["Practice", "/"],
  ]) {
    await page.getByRole("link", { name: label, exact: true }).click();
    // Navigation is client-side, so the URL settles after the click resolves —
    // waiting on load state alone reads the previous page.
    await page.waitForURL((u) => new URL(u).pathname === path, { timeout: 15000 }).catch(() => {});
    const landed = new URL(page.url()).pathname;
    if (landed !== path) return fail(`nav "${label}" went to ${landed}, expected ${path}`);
    const current = (await page.locator('nav a[aria-current="page"]').first().textContent().catch(() => ""))?.trim();
    if (current !== label) return fail(`nav "${label}" landed on ${path} but marks "${current}" as current`);
  }
  log("✓ every nav entry lands on its own page and marks itself current");

  // ---------- TRACK CARDS ----------
  // These three used to open the first problem of each type, which (the bank
  // being read oldest-first) was always the same generic seed problem. A track
  // must open its own slice of the bank instead.
  for (const [label, type, pill] of [
    ["Debug", "debug", "pill-dbg"],
    ["Code review", "review", "pill-rev"],
    ["System design", "design", "pill-sys"],
  ]) {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.locator("a", { hasText: new RegExp(`^${label}`) }).last().click();
    await page.waitForURL((u) => new URL(u).pathname === "/bank", { timeout: 15000 }).catch(() => {});
    const url = new URL(page.url());
    if (url.searchParams.get("type") !== type) {
      return fail(`track "${label}" opened ${url.pathname}${url.search}, expected ?type=${type}`);
    }
    await page.locator("main ul li").first().waitFor({ timeout: 10000 }).catch(() => {});
    const offType = await page.locator(`main ul li .pill:not(.${pill})`).count();
    if (offType > 0) return fail(`track "${label}" listed ${offType} rows of another type`);
  }
  log("✓ each track card opens its own filtered slice of the bank");

  // ---------- BANK ----------
  await page.goto(`${BASE}/bank`, { waitUntil: "networkidle" });
  const allRows = await page.locator("main ul li").count();
  if (allRows === 0) return fail("bank page listed no problems");

  await page.getByRole("button", { name: "Debug", exact: true }).click();
  await page.waitForURL((url) => url.searchParams.get("type") === "debug", { timeout: 10000 });
  await page.waitForFunction(
    () => {
      const rows = [...document.querySelectorAll("main ul li")];
      return rows.length > 0 && rows.every((row) => row.querySelector(".pill-dbg"));
    },
    undefined,
    { timeout: 10000 },
  );
  const debugRows = await page.locator("main ul li").count();
  const nonDebug = await page.locator("main ul li .pill-rev, main ul li .pill-sys").count();
  if (nonDebug > 0) return fail(`bank type filter left ${nonDebug} non-debug rows visible`);
  log(`✓ bank filters by type (${allRows} → ${debugRows} rows, all debug)`);

  // Tag chips narrow further, client-side over the fetched rows.
  const chip = page.locator("main button", { hasText: /^idempotency/ }).first();
  if (await chip.count()) {
    await chip.click();
    await page.waitForTimeout(300);
    const tagged = await page.locator("main ul li").count();
    if (tagged === 0 || tagged > debugRows) return fail(`tag filter returned ${tagged} rows (had ${debugRows})`);
    log(`✓ bank filters by topic tag (${debugRows} → ${tagged} rows)`);
  }

  // A row must actually open the problem.
  await page.locator("main ul li a").first().click();
  await page.waitForURL(/\/solve\/.+/, { timeout: 15000 });
  log("✓ a bank row opens its problem");

  // ---------- HISTORY ----------
  // This run graded three problems under this browser's session id, so they must
  // show up here — the end-to-end tie between grading, persistence, and history.
  await page.goto(`${BASE}/history`, { waitUntil: "networkidle" });
  await page.locator("main ul li").first().waitFor({ timeout: 15000 }).catch(() => {});
  const histRows = await page.locator("main ul li").count();
  if (histRows === 0) return fail("history is empty after grading three problems in this session");
  const scored = await page.locator("main ul li").filter({ hasText: /\d/ }).count();
  log(`✓ history lists this session's graded attempts (${histRows} rows, ${scored} with a score)`);

  await page.screenshot({ path: `${SHOT}/e2e-final.png`, fullPage: true }).catch(() => {});

  // ---------- MOBILE WORKSPACE ----------
  // Guard the narrow layout as behavior, not just pixels: both primary surfaces
  // must be reachable and neither list nor editor chrome may widen the document.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/bank`, { waitUntil: "networkidle" });
  const bankOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (bankOverflow > 1) return fail(`mobile bank overflows horizontally by ${bankOverflow}px`);

  await page.goto(`${BASE}/solve/${debug.id}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".monaco-editor", { timeout: 30000 });
  const solveOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (solveOverflow > 1) return fail(`mobile solve workspace overflows horizontally by ${solveOverflow}px`);
  await page.getByRole("tab", { name: /Interviewer/ }).click();
  await page.getByPlaceholder(/Ask the interviewer/i).waitFor({ timeout: 5000 });
  await page.getByRole("tab", { name: "Workspace" }).click();
  await page.getByRole("button", { name: /Run tests/i }).waitFor({ timeout: 5000 });
  log("✓ mobile bank and solve views fit the viewport; workspace and interviewer are both reachable");

  await browser.close();

  if (errors.length) {
    log(`\n⚠️  ${errors.length} console/page errors during run:`);
    errors.slice(0, 10).forEach((e) => log("   " + e));
  }
  log("\n=== E2E PASSED: full loop works in a real browser ===");
}

main().catch((e) => {
  console.error(`\n❌ E2E FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
