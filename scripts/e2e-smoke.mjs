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
  let returnNoJdMatch = true;
  let operatorGenerationRequests = 0;
  let tailoredGenerationRequests = 0;
  let contributionRequests = 0;
  let contributionOutcome = "rejected";
  let authRequests = 0;
  let lastSignInRequest = null;
  let signedInAs = null;

  // Sending mail is an outbound side effect, so it is stubbed here for the same
  // reason the model endpoints are. Everything the stub stands in for — tokens,
  // cookies, redirects, the anonymous-work merge — is covered against the real
  // handlers in tests/authRoutes.test.ts and tests/authAccount.test.ts.
  await page.route("**/api/auth/request", async (route) => {
    authRequests += 1;
    lastSignInRequest = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sent: true, expiresInMinutes: 15 }),
    });
  });
  // Named so the "coming soon" check below can lift it and put it back. The
  // stub stands in for a deployment that has mail configured; the unconfigured
  // case is asserted against the real handler.
  const sessionStub = async (route) => {
    if (route.request().method() === "DELETE") signedInAs = null;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ signedIn: Boolean(signedInAs), email: signedInAs, signInAvailable: true }),
    });
  };
  await page.route("**/api/auth/session", sessionStub);
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
      body: JSON.stringify({
        tags: ["idempotency"],
        seniority: "senior",
        confidence: returnNoJdMatch ? 0 : 0.8,
        matches: returnNoJdMatch ? [] : [{ id: debug.id, type: "debug" }],
      }),
    });
  });
  await page.route("**/api/generate", async (route) => {
    operatorGenerationRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "must not run" }) });
  });
  await page.route("**/api/generate/tailored", async (route) => {
    tailoredGenerationRequests += 1;
    const payload = route.request().postDataJSON();
    if (payload.difficulty !== "medium" || !payload.jd || !payload.sessionId) {
      throw new Error("Tailored generation omitted JD matching context.");
    }
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        `data: ${JSON.stringify({ type: "phase", phase: "writing", note: "Writing a tailored debug problem" })}`,
        `data: ${JSON.stringify({ type: "done", problemId: debug.id, problemType: "debug", title: debug.title })}`,
        "",
      ].join("\n\n"),
    });
  });
  await page.route("**/api/contributions", async (route) => {
    contributionRequests += 1;
    const payload = route.request().postDataJSON();
    if (!payload.attested || !payload.question || !payload.sessionId) {
      throw new Error("Contribution request omitted the privacy attestation or source context.");
    }
    const outcome =
      contributionOutcome === "accepted"
        ? { type: "done", outcome: "accepted", receiptId: "receipt-accepted", problemId: design.id, title: design.title }
        : contributionOutcome === "duplicate"
          ? { type: "done", outcome: "duplicate", receiptId: "receipt-duplicate", problemId: design.id, title: design.title }
          : { type: "done", outcome: "rejected", receiptId: "receipt-rejected", message: "This needs more technical constraints before it can be added." };
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        `data: ${JSON.stringify({ type: "phase", phase: "analyzing", note: "Extracting the reusable engineering signal" })}`,
        `data: ${JSON.stringify(outcome)}`,
        "",
      ].join("\n\n"),
    });
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

  // Community source text stays in component/request memory and all review outcomes render clearly.
  await page.goto(`${BASE}/bank`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Contribute" }).click();
  await page.waitForURL(`${BASE}/contribute`);
  const sourceMarker = "SMOKE_PRIVATE_INTERVIEW_SOURCE";
  await page.getByPlaceholder(/Paste the question/).fill(
    `${sourceMarker}: design a worker coordination system with explicit scale, failure recovery, and consistency constraints.`,
  );
  await page.getByRole("checkbox", { name: /I removed confidential information/ }).check();
  await page.getByRole("button", { name: "Review contribution" }).click();
  await page.getByText("Not added").waitFor();

  contributionOutcome = "duplicate";
  await page.getByRole("button", { name: "Review contribution" }).click();
  await page.getByText("Already covered").waitFor();
  await page.getByRole("link", { name: /Open existing problem/ }).waitFor();

  contributionOutcome = "accepted";
  await page.getByPlaceholder(/Paste the question/).fill(
    `${sourceMarker}: design a worker coordination system with explicit scale, failure recovery, and consistency constraints.`,
  );
  await page.getByRole("button", { name: "Review contribution" }).click();
  await page.getByText("Added to the bank").waitFor();
  if (contributionRequests !== 3) throw new Error("Contribution form did not exercise all three review outcomes.");
  const storedSource = await page.evaluate((marker) => JSON.stringify({ ...localStorage, ...sessionStorage }).includes(marker), sourceMarker);
  if (storedSource) throw new Error("Contribution source text leaked into browser storage.");
  await page.getByRole("link", { name: /Start problem/ }).waitFor();
  log("✓ contribution intake covers rejected, duplicate, and accepted outcomes without browser persistence");

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Match me a problem/ }).click();
  await page.waitForURL(new RegExp(`/solve/${debug.id}$`));
  if (tailoredGenerationRequests !== 1) throw new Error("An empty JD match did not invoke tailored BYOK generation.");
  if (operatorGenerationRequests !== 0) throw new Error("An empty JD match invoked operator-funded generation.");
  log("✓ a bank miss generates a tailored problem with BYOK and opens it");

  await page.goto(BASE, { waitUntil: "networkidle" });
  returnNoJdMatch = false;
  await page.getByRole("button", { name: /Match me a problem/ }).click();
  await page.waitForURL(new RegExp(`/solve/${debug.id}$`));
  if (tailoredGenerationRequests !== 1) throw new Error("A bank hit generated a duplicate problem.");
  if (operatorGenerationRequests !== 0) throw new Error("Public JD matching invoked operator-funded generation.");
  log("✓ a bank hit avoids duplicate generation and never invokes the operator pipeline");

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

  // The bank is searchable, filterable, shareable, and remains usable on mobile.
  await page.goto(`${BASE}/bank?sort=new`, { waitUntil: "networkidle" });
  await page.getByPlaceholder("Search titles or topics").fill("teleoperation");
  await page.waitForFunction(() => new URL(location.href).searchParams.get("q") === "teleoperation");
  const tailoredRows = await page.locator("main li").count();
  if (tailoredRows < 1) throw new Error("Bank search did not find the seeded teleoperation problem.");
  await page.getByRole("button", { name: "Topics" }).click();
  await page.getByRole("button", { name: /^robotics\s+\d+$/ }).click();
  if (!new URL(page.url()).searchParams.getAll("tag").includes("robotics")) {
    throw new Error("Topic filter did not update the bank URL.");
  }
  await page.getByRole("button", { name: "Reset filters" }).click();
  if (new URL(page.url()).searchParams.has("q")) throw new Error("Reset filters left the bank query in the URL.");
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/problems?") && response.ok()),
    page.getByLabel("Filter by track").selectOption("review"),
  ]);
  await page.waitForFunction(() =>
    [...document.querySelectorAll("main li .pill")].every((pill) => pill.textContent?.trim() === "Review"),
  );
  log("✓ problem bank search, topics, filters, and shareable URL work");

  // The recorded demo runs with no key and no model: the diff, the score, and
  // the follow-up all have to render for a first-time visitor.
  await page.goto(`${BASE}/demo`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "A code review, graded" }).waitFor();
  await page.getByText("SQL injection").first().waitFor();
  await page.getByRole("button", { name: /See how it scored/ }).click();
  await page.getByText("How this was scored").waitFor();
  // The recorded comments catch two of the three seeded flaws and raise one
  // nit, so the real matcher and the real arithmetic must land on 67 − 12 = 55.
  // If either changes, this fails rather than the demo quietly misrepresenting.
  await page.getByText("2/3 seeded").waitFor();
  await page.getByText("1 × −12").waitFor();
  await page.getByText("55/100").waitFor();
  // Rating belongs to someone who solved it; the demo viewer did not.
  if (await page.getByText("Was this a good problem?").count()) {
    throw new Error("Recorded demo offered a curation vote.");
  }
  await page.getByRole("button", { name: /the follow-up/ }).click();
  await page.getByText(/Recorded transcript/).waitFor();
  if (await page.getByPlaceholder(/Ask the interviewer/).count()) {
    throw new Error("Recorded transcript offered a composer that cannot reply.");
  }
  log("✓ keyless demo walks PR → real grade (55, 2/3 caught, 1 false positive) → follow-up");

  // Timed interview mode: armed by URL, started only on consent.
  await page.goto(`${BASE}/solve/${debug.id}?interview=1`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /minutes, one shot/ }).waitFor();
  if (await page.locator("text=/\\d+:\\d\\d/").count()) throw new Error("Interview clock started before consent.");
  await page.getByRole("button", { name: /Start the clock/ }).click();
  await page.getByText(/4[45]:\d\d/).waitFor();
  await page.getByText(/3 runs left/).waitFor();
  await page.getByText(/We've got 45 minutes/).waitFor();
  log("✓ interview mode gates on consent, then runs a clock and a run budget");

  // Ending early submits, and the session shows up on the results.
  await page.getByRole("button", { name: "End early" }).click();
  await page.getByText("Deterministic smoke grade").waitFor();
  await page.getByText(/runs used/).waitFor();
  // The countdown belongs to the session, not to the results it produced.
  if (await page.getByRole("button", { name: "End early" }).count()) {
    throw new Error("Interview clock kept running after submission.");
  }
  log("✓ ending an interview submits and reports time and runs used");

  // Sign-in must not be offered when the server cannot deliver a link. Checked
  // against the real handler with the stub lifted, so this fails if the
  // availability signal stops reaching the UI. Assumes the instance under test
  // has no mail transport configured, which is the default for a checkout.
  await page.unroute("**/api/auth/session", sessionStub);
  await page.goto(`${BASE}/signin`, { waitUntil: "networkidle" });
  await page.getByText(/Coming soon/).waitFor();
  if (await page.getByLabel("Email address").count()) {
    throw new Error("Sign-in form was offered even though no mail transport is configured.");
  }
  log("✓ sign-in reads as coming soon when no mail transport is configured");
  await page.route("**/api/auth/session", sessionStub);

  // Account UI. The mail transport is stubbed the same way the model endpoints
  // are; the token, cookie, and merge behaviour are covered in tests/authRoutes.
  await page.goto(`${BASE}/signin`, { waitUntil: "networkidle" });
  await page.getByLabel("Email address").fill("smoke@anvil.test");
  await page.getByRole("button", { name: /Email me a link/ }).click();
  await page.getByText(/Link sent to smoke@anvil.test/).waitFor();
  if (authRequests !== 1) throw new Error("Sign-in form did not call the request endpoint.");
  if (!lastSignInRequest?.sessionId) {
    throw new Error("Sign-in request omitted the anonymous session id, so nothing could be merged.");
  }
  log("✓ sign-in requests a link and carries the browser's anonymous id");

  signedInAs = "smoke@anvil.test";
  await page.goto(`${BASE}/history`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Signed in as smoke@anvil.test/ }).waitFor();
  if (await page.getByRole("link", { name: /^Sign in/ }).count()) {
    throw new Error("History still advertised sign-in to a signed-in account.");
  }
  log("✓ a signed-in account is reflected across the app chrome");
  signedInAs = null;

  // Keep the responsive regression in the cheap suite that runs on every push.
  await page.setViewportSize({ width: 390, height: 844 });
  const bankOverflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  if (bankOverflow > 1) throw new Error(`Mobile bank overflows by ${bankOverflow}px.`);
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
