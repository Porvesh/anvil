/**
 * Deterministic browser smoke suite. Model endpoints are fulfilled in-browser,
 * while pages, the problem API, Monaco, localStorage, and React state are real.
 * This is the per-push suite; scripts/e2e.mjs remains the scheduled live loop.
 */
import { chromium } from "playwright";

const BASE = (process.env.E2E_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const log = (...args) => console.log(...args);

function grade(mode) {
  return {
    score: 100,
    headline: "Deterministic smoke grade",
    summary: "The mocked provider boundary returned a valid, explainable grade.",
    outcomes: [
      {
        issueId: "smoke",
        status: "caught",
        severity: "major",
        failure: "Smoke-test issue",
        explanation: "Used only by the deterministic browser suite.",
        matchedOn: "fixture",
      },
    ],
    falsePositives: [],
    breakdown: [{ label: "Smoke fixture", earned: 100, max: 100, detail: "provider-independent" }],
    testsPassed: mode === "debug" ? true : undefined,
    dimensionScores: mode === "design" ? [{ name: "Smoke", score: 100, justification: "fixture" }] : undefined,
    graderModel: "deterministic-smoke",
  };
}

async function setMonaco(page, marker, replacement) {
  return page.evaluate(
    ({ find, value }) => {
      const models = window.monaco?.editor.getModels() ?? [];
      const model = models.find((item) => item.getValue().includes(find)) ?? models[0];
      if (!model) return false;
      model.setValue(value ?? `${model.getValue()}\n${find}`);
      return true;
    },
    { find: marker, value: replacement },
  );
}

async function waitForDraft(page, problemId) {
  await page.waitForFunction((id) => localStorage.getItem(`anvil:solve-draft:v1:${id}`) !== null, problemId, { timeout: 5000 });
}

async function main() {
  const health = await fetch(`${BASE}/api/problems`).catch(() => null);
  if (!health?.ok) throw new Error(`Anvil is not reachable at ${BASE}. Start the app or set E2E_BASE_URL.`);
  const { problems } = await health.json();
  const debug = problems.find((problem) => problem.title.includes("Webhook batcher")) ?? problems.find((problem) => problem.type === "debug");
  const review = problems.find((problem) => problem.type === "review");
  const design = problems.find((problem) => problem.type === "design");
  if (!debug || !review || !design) throw new Error("Smoke suite needs one seeded problem of each type.");

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  let holdGrade = false;
  let releaseGrade;
  let byokConnected = false;
  let byokProvider = null;
  let generationRequests = 0;
  await page.route("**/api/byok", async (route) => {
    const method = route.request().method();
    if (method === "POST") {
      const payload = route.request().postDataJSON();
      if (payload.provider !== "openai") throw new Error("BYOK did not send the selected OpenAI provider.");
      byokConnected = true;
      byokProvider = payload.provider;
    }
    if (method === "DELETE") {
      byokConnected = false;
      byokProvider = null;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ connected: byokConnected, provider: byokProvider, expiresAt: byokConnected ? Date.now() + 60_000 : null }),
    });
  });
  await page.route("**/api/grade", async (route) => {
    const payload = route.request().postDataJSON();
    if (holdGrade) {
      await new Promise((resolve) => {
        releaseGrade = resolve;
      });
    }
    await route
      .fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ attemptId: `smoke-${payload.submission.mode}`, grade: grade(payload.submission.mode) }),
      })
      .catch(() => {});
  });
  await page.route("**/api/jd/match", async (route) => {
    const payload = route.request().postDataJSON();
    if (payload.difficulty !== "medium") throw new Error("JD match omitted the selected difficulty.");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tags: ["idempotency"], seniority: "senior", confidence: 0.2, matches: [{ id: debug.id, type: "debug" }] }),
    });
  });
  await page.route("**/api/generate", async (route) => {
    generationRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "must not run" }) });
  });
  const sse = (text) => `data: ${JSON.stringify({ type: "delta", text })}\n\ndata: ${JSON.stringify({ type: "done" })}\n\n`;
  await page.route("**/api/hint", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: sse("Trace the boundary condition first.") }));
  await page.route("**/api/socratic", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: sse("What invariant would prevent this failure?") }));

  // The global BYOK control connects without retaining the plaintext in browser storage.
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Connect an AI provider key" }).click();
  await page.getByText("How your key is protected").click();
  await page.getByText(/Never written to Anvil/).waitFor();
  await page.getByRole("button", { name: "OpenAI" }).click();
  await page.getByLabel("OpenAI API key").fill("sk-proj-deterministic-smoke-key");
  await page.getByRole("button", { name: "Connect key", exact: true }).click();
  await page.getByRole("button", { name: "OpenAI API key connected" }).waitFor();
  const leakedKey = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).includes("deterministic-smoke-key"));
  if (leakedKey) throw new Error("BYOK plaintext leaked into browser-readable storage.");
  log("✓ provider-selectable BYOK is global and keeps plaintext out of browser storage");

  await page.getByRole("button", { name: /Match me a problem/ }).click();
  await page.waitForURL(new RegExp(`/solve/${debug.id}$`));
  if (generationRequests !== 0) throw new Error("Public JD matching invoked operator-funded generation.");
  log("✓ JD matching uses BYOK and never invokes operator generation");

  // Debug edits and run context survive a full reload.
  await page.goto(`${BASE}/solve/${debug.id}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".monaco-editor", { timeout: 30000 });
  const original = await page.evaluate(() => window.monaco.editor.getModels()[0]?.getValue() ?? "");
  if (!(await setMonaco(page, "SMOKE_DRAFT_MARKER", `${original}\n# SMOKE_DRAFT_MARKER`))) throw new Error("Could not edit debug Monaco model.");
  await waitForDraft(page, debug.id);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".monaco-editor", { timeout: 30000 });
  await page.waitForFunction(() => window.monaco.editor.getModels().some((model) => model.getValue().includes("SMOKE_DRAFT_MARKER")));
  log("✓ debug edits recover after reload");

  // Hint streaming uses no real provider in this suite.
  await page.getByRole("button", { name: "Where should I start?" }).click();
  await page.getByText("Trace the boundary condition first.").waitFor();
  log("✓ deterministic hint stream renders");

  // Grading can be cancelled, keeps the draft, then succeeds on retry and clears it.
  holdGrade = true;
  await page.getByRole("button", { name: /Submit for review/i }).click();
  await page.getByRole("button", { name: "Cancel grading" }).click();
  await page.getByText(/draft is saved locally/i).waitFor();
  const savedAfterCancel = await page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith("anvil:solve-draft:v1:")));
  if (!savedAfterCancel) throw new Error("Cancelling grading removed the draft.");
  holdGrade = false;
  releaseGrade?.();
  await page.getByRole("button", { name: /Submit for review/i }).click();
  await page.getByText("Deterministic smoke grade").waitFor();
  const savedAfterGrade = await page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith("anvil:solve-draft:v1:")));
  if (savedAfterGrade) throw new Error("Successful grading did not clear the draft.");
  await page.getByText("What invariant would prevent this failure?").waitFor();
  log("✓ grading cancellation preserves work; retry succeeds and clears the draft");

  // Review comments recover with their file/line anchor.
  await page.goto(`${BASE}/solve/${review.id}`, { waitUntil: "networkidle" });
  const line = page.locator("[title^='Comment on']").first();
  await line.click();
  await page.locator('textarea[placeholder*="Comment on line"]').fill("SMOKE_REVIEW_COMMENT");
  await page.getByRole("button", { name: /^Comment$/ }).click();
  await waitForDraft(page, review.id);
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("SMOKE_REVIEW_COMMENT").waitFor();
  log("✓ review comments recover after reload");

  // Design documents recover too.
  await page.goto(`${BASE}/solve/${design.id}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".monaco-editor", { timeout: 30000 });
  if (!(await setMonaco(page, "SMOKE_DESIGN_MARKER", "# SMOKE_DESIGN_MARKER\n\nUse a token bucket."))) throw new Error("Could not edit design Monaco model.");
  await waitForDraft(page, design.id);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".monaco-editor", { timeout: 30000 });
  await page.waitForFunction(() => window.monaco.editor.getModels().some((model) => model.getValue().includes("SMOKE_DESIGN_MARKER")));
  log("✓ design document recovers after reload");

  // Keep the responsive regression in the cheap suite that runs on every push.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/solve/${debug.id}`, { waitUntil: "networkidle" });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  if (overflow > 1) throw new Error(`Mobile solve overflows by ${overflow}px.`);
  await page.getByRole("tab", { name: /Interviewer/ }).click();
  await page.getByPlaceholder(/Ask the interviewer/).waitFor();
  log("✓ mobile workspace and interviewer remain reachable");

  await browser.close();
  if (pageErrors.length) throw new Error(`Browser errors:\n${pageErrors.join("\n")}`);
  log("\n=== DETERMINISTIC E2E SMOKE PASSED ===");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
