# Anvil — Technical & Product Spec

**Version 0.2 · consolidated** · *working title*

*A "LeetCode for the skills LeetCode ignores": debugging, code review, and system design — the open-ended, judgment-heavy skills that actually decide modern interviews and real engineering work. Free, browser-based, AI-graded.*

---

## 1. Thesis

LeetCode drills algorithmic puzzles because they have an objective oracle: a unit-test harness says right or wrong instantly. But the skills that actually break candidates — and matter on the job — have no such oracle: reading unfamiliar code under pressure, catching the subtle bug in a plausible AI-written PR, and reasoning through a system design out loud. Nobody has built a good drilling ground for those. Anvil is that ground.

## 2. The core insight

**For debug and code review, the AI plants the flaws — so the AI holds the answer key.** Grading stops being subjective and becomes "which of the known, seeded issues did the user catch, how precisely, and did they raise false positives." System design stays genuinely open-ended and is the one type graded against a rubric rather than an answer key.

Generate the flaw, keep the ground truth. That single property is what makes the whole product tractable.

## 3. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Cost model | **Free**, no login to start | Goal is adoption, not revenue |
| Code execution | **Browser (Pyodide)**, never server-side | $0 compute; untrusted code runs on the *user's* machine, so the security burden disappears |
| Grading tokens | Subsidized free tier (cheap model + rate limits) + **optional BYOK** unlock | Money is trivial at small scale; the real cost of BYOK is signup friction, so don't require it |
| Problem generation | Generate **once**, persist in a shared bank | Amortizes cost across all users; this *is* the "save good problems" bank |
| v1 engine | **Debug + Code Review** together | They share ~all infra: generation, execution, answer-key grading |
| Phase 2 | System design | Architecturally different: no sandbox, rubric grading, diagram canvas |
| Build language | **TypeScript / Next.js** | The backend is thin I/O glue; the real work is in the browser (Monaco, Pyodide, diff) and in the generation/grading prompts |
| Problem language | **Python first** | Runs cleanly in Pyodide; JS/TS is the fast-follow |

## 4. Product scope

### Debug (v1)
Runnable code + a symptom (failing test, wrong output, crash). The user edits, re-runs in the browser, and iterates until tests pass. Objective half of the grade is "do the tests go green"; the rest is approach quality (root cause vs. symptom-masking, iteration count).

### Code review (v1)
A plausible AI-generated "PR" (git diff) containing planted bugs and deliberate ambiguity. The user leaves line comments, submits, then defends them in a Socratic Q&A. Grade = seeded issues caught − false positives, plus reasoning quality in the follow-up.

> Debug and review are **two modes of one engine**: same generation pipeline, same code, same answer key. Debug = "fix until green." Review = "annotate, then defend." Build the engine once, expose two modes.

### System design (phase 2)
An open-ended prompt, optionally seeded from a pasted JD. The AI acts as interviewer — pushing on requirements gathering, capacity math, high-level design, deep dives, failure modes, tradeoffs. Graded per-rubric-dimension with justifications, never a single trust-me score. Needs a lightweight diagram canvas.

### JD tailoring
The user pastes a job description; Anvil extracts stack, domain, and seniority to select (retrieval-first) or generate (on-miss) matching problems.

## 5. The core loop (reusable across all types)

```
JD / topic / difficulty ─→ GENERATE (offline, once, self-checked) ─→ BANK
                                                                       │
        user picks a problem ──────────────────────────────────────────┘
              │
              ▼
          SOLVE ──(browser exec for debug/review)── edit / run / comment
              │
              ▼
          GRADE (against hidden answer key, or rubric for design)
              │
              ▼
          SOCRATIC FOLLOW-UP (interviewer probes the gaps)
              │
              ▼
          SCORE / SAVE ─→ feeds user history + the shared bank
```

Interaction style: **hint-on-demand while solving, interviewer-driven during follow-up** — quiet while you work, probing once you submit.

## 6. Form factor & UX

**There is no single form factor — the work surface morphs by problem type inside a shared shell.** A generic one-size IDE would be worse at all three.

Constant chrome: a problem-statement header (title, breadcrumb, timer), a persistent **AI interviewer panel** (first-class, since the Socratic follow-up is the differentiator), and a Submit/Grade action.

Center pane, swapped per mode:
- **Debug** → Monaco editor + Run + a tests/console panel. Editor-centric.
- **Review** → PR diff viewer with inline comment threads + Submit review. Diff-centric, no editing.
- **Design** → diagram canvas + structured notes + interviewer chat. Canvas-centric.

```
┌──────────────────────────────────────────────────────────────┐
│  [problem title]                              [Submit / Grade] │  ← shared shell
├───────────────────────────────────────────┬──────────────────┤
│   CENTER PANE — swaps by mode:            │   AI interviewer  │
│     debug  → Monaco editor + Run + tests   │   panel           │
│     review → PR diff + comments            │   (persistent,    │
│     design → canvas + notes                │   streams the     │
│                                            │   Socratic Q&A)   │
└───────────────────────────────────────────┴──────────────────┘
```

Desktop-first web app. Mobile is fine for browsing/reading the bank, not for solving.

## 7. Architecture

**The browser is the compute layer. The server never runs user code.** That one decision is what makes Anvil cheap and safe.

```
┌────────────────── BROWSER (heavy lifting) ──────────────────┐
│ Monaco editor │ Pyodide in a Web Worker │ diff viewer │ chat │
│   ↑ user edits & RUNS code locally — zero server involvement  │
└───────────────────────────────┬──────────────────────────────┘
                                 │  only 2 calls leave the browser:
                                 │  (1) fetch a problem  (2) submit for grading
                                 ▼
┌───────────── THIN SERVERLESS API (Next.js routes) ──────────┐
│ GET /problem   POST /grade (streams Socratic via SSE)        │
│ model proxy · rate limiter (per IP/session) · keys live here │
└──────────┬───────────────────────────────────┬───────────────┘
           ▼                                     ▼
   ┌──────────────┐                     ┌──────────────────┐
   │  Postgres    │                     │  Anthropic API   │
   │ bank + answer│                     │ Haiku = grading  │
   │ keys + history│                    │ (in request path)│
   └──────┬───────┘                     └──────────────────┘
          ▲
   ┌──────┴──────────────────────────────────────────┐
   │ OFFLINE GENERATION JOB (not user-facing)         │
   │ Sonnet injects bugs → emits answer key + tests → │
   │ self-check (runs code, verifies bug is real) →   │
   │ writes to bank. Batched, on your key.            │
   └──────────────────────────────────────────────────┘
```

Generation is fully decoupled from the request path: offline, on your key, once per problem, self-verified before saving. The only live model call a user triggers is grading (Haiku, pennies). Everything else is a static DB read or runs on the user's own machine — which is why it scales on free infrastructure.

## 8. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js (React + API routes) | One repo, one deploy |
| Editor | `@monaco-editor/react` | VS Code's editor; familiarity = interview realism |
| Execution | Pyodide in a Web Worker | CPython → WASM, client-side, sandboxed |
| Output/console | Plain styled panel | Add `xterm.js` only for a real terminal feel |
| Diff/review | `react-diff-view` | Consumes git unified-diff; has comment-widget system |
| Design canvas (ph2) | Excalidraw or tldraw | Embeddable React canvas |
| AI panel | Custom chat, SSE from `/grade` | Streams the Socratic follow-up |
| DB | Postgres (Supabase / Neon / Turso) | Free tier covers bank + anonymous history |
| Rate limit / KV | Upstash or Cloudflare KV | Free tier |
| Hosting | Vercel / Netlify / Cloudflare | Free tier for static + serverless functions |
| Models | Sonnet (generation), Haiku 4.5 (grading + Socratic) | Prompt caching on the stable problem prefix |

## 9. Code execution (the sandbox)

Pyodide is a sandbox by construction: CPython compiled to WebAssembly, running in the browser's WASM sandbox — no host filesystem, no network, no syscalls. Run it inside a **Web Worker** for a second boundary (no DOM, `postMessage` only) and, critically, the ability to `terminate()` a runaway loop.

Untrusted user code physically cannot touch the user's files, reach the network, or hit your server (there is no server in the loop). The worst a malicious submission can do is burn CPU/memory in the user's own tab.

```js
// pyodide.worker.js
importScripts("https://cdn.jsdelivr.net/pyodide/v0.28.0/full/pyodide.js"); // pin version
let pyodide; const ready = (async () => { pyodide = await loadPyodide(); })();
self.onmessage = async ({ data: { userCode, testCode } }) => {
  await ready;
  let out = "";
  pyodide.setStdout({ batched: s => out += s + "\n" });
  pyodide.setStderr({ batched: s => out += s + "\n" });
  try {
    pyodide.FS.writeFile("solution.py", userCode);
    const result = pyodide.runPython(testCode); // structured pass/fail
    self.postMessage({ ok: true, out, result });
  } catch (err) { self.postMessage({ ok: false, out, error: err.message }); }
};
```

```js
// main thread — timeout kills infinite loops
function run(userCode, testCode, ms = 5000) {
  return new Promise(resolve => {
    const w = new Worker("pyodide.worker.js");
    const t = setTimeout(() => { w.terminate(); resolve({ ok:false, error:"Timed out" }); }, ms);
    w.onmessage = e => { clearTimeout(t); w.terminate(); resolve(e.data); };
    w.postMessage({ userCode, testCode });
  });
}
```

Notes: the ~15MB Pyodide runtime loads once per user (lazy, then browser-cached, served free from jsdelivr's CDN). No-network is a design constraint — problems must be self-contained, and "prod-sim" telemetry is injected as data files the user reads, not a live service. A timeout is itself a signal: an infinite loop is often the bug the user is meant to find.

## 10. Code review / diff approach

Use git's **unified diff format**, but no actual git anywhere (no repo, no binary, no VCS ops). The format is just the standard representation of "these lines changed," and it lets the review UI look like a real GitHub PR — the authentic experience for reviewing AI code.

The payoff beyond cosmetics: **a unified diff gives a line-number coordinate system, and the answer key is already keyed by line.** So grading a review reduces to "did the user attach a comment inside the hunk where a seeded issue lives" — caught / missed / false-positive falls out of comparing comment anchors to answer-key line ranges.

Generation emits `before` + `after` (or the diff directly), dressed as a real PR: title, description, and a commit message that's subtly misleading — the "plausible PR hiding a bug" is exactly the AI-slop-review skill being trained.

## 11. Generation pipeline (quality lives or dies here)

Per problem, offline, on your key:

1. Start from clean, correct, idiomatic code (topic- or JD-derived).
2. Sonnet injects **1–3 realistic flaws** — the kind that pass a casual read: off-by-one under a condition, unbounded retry, race on shared state, silent exception swallow, subtle coercion, a plausible-but-wrong AI-style "fix," a missing idempotency guard.
3. Emit a **structured answer key** alongside: each flaw's location, severity, the failure it causes, and the reasoning a strong reviewer would give.
4. For debug: emit a **test suite** that fails on the bug and passes when fixed (runs in Pyodide — the objective half of the grade).
5. **Self-check pass:** a second model call verifies the code runs, the tests fail-then-pass, and the flaws are real (not hallucinated). Reject and regenerate on failure.

Because output is cached into the bank, the extra verification call is worth it — paid once, benefits everyone. A `quality_score` prunes weak generations.

## 12. Grading pipeline

- **Debug** — objective layer first (tests pass in Pyodide?), then a cheap model pass on approach quality using run history (root-cause vs. masking, iterations).
- **Review** — match comments to answer-key issues by line anchor (caught / missed / false-positive), then model-judge comment precision and run the Socratic Q&A targeting the *missed* issues. The follow-up is the teaching moment.
- **Design (ph2)** — score each rubric dimension separately, each with a short justification. Never a single number.

## 13. Model layer & cost model

Current rates: Haiku 4.5 = $1/$5 per M input/output tokens; Sonnet = ~$3/$15; prompt caching cuts cached input ~90%; batch API halves everything.

- **Generation (your one-time cost):** ~10K in + 6K out on Sonnet ≈ **$0.10–0.20 per problem**, batchable to half. A 500-problem launch bank = **$50–100, once.**
- **Grading (per session):** grade + Socratic on Haiku, with the code + answer key in a cached prefix ≈ **2–5¢ per problem.** 100 problems/month ≈ a couple dollars.
- New API accounts get **$5 free credits**, covering 100+ sessions before a user pays anything.

## 14. Free-tool economics & key handling

Cost surface: execution = $0 (browser); hosting/DB/KV = free tiers; Pyodide runtime = free CDN; generation = one-time ~$50–100; grading = pennies.

**Recommendation:** launch with **no login, no key** — subsidize grading on Haiku, rate-limit per IP/session to cap abuse. At small scale this costs tens of dollars total; you can eat it for a long time before it stings. Keep **BYOK as an optional "unlock unlimited"** for power users, not a front-door requirement — the real cost of requiring keys is signup drop-off, not dollars.

Key handling when BYOK is used: keys encrypted at rest (envelope encryption / KMS), never in the browser, all model calls proxied through the backend. Note the one honest asterisk — BYOK offloads *token* cost, but there is no server compute to offload because execution is client-side, so the free tier's only variable cost is the subsidized grading tokens.

## 15. Data model (sketch)

```
Problem
  id, type (debug|review|design), language, difficulty
  jd_context      -- nullable; the JD it was tailored from
  prompt          -- symptom / PR description / design ask
  starter_code    -- buggy/ambiguous code, or the diff (before+after)
  answer_key      -- structured: [{line_range, severity, failure, explanation}]
  rubric          -- design only
  test_suite      -- debug only; runs in Pyodide
  quality_score   -- curation/pruning signal

Attempt
  id, problem_id, session_id
  submission      -- final code, or list of {line, comment}
  run_history     -- debug: each run + result
  grade           -- {issues_caught, missed, false_positives, dimension_scores}
  transcript      -- the Socratic follow-up
  created_at
```

A structured (not prose) `answer_key` is what makes grading near-deterministic: match fixes/comments against known issues, then use the model only for precision judgment and the Q&A.

## 16. Milestones

**v0 — prove the loop (one type, no polish)**
- Pyodide + Monaco run panel in the browser.
- 5 hand-authored debug problems (skip generation).
- Submit → run tests → basic grade. No accounts.

**v1 — the real engine**
- Generation pipeline + self-check → populate the bank.
- Debug *and* Review modes; the shared shell + morphing pane.
- Socratic follow-up.
- Subsidized grading + rate limits; anonymous session history.
- JD paste → tailored selection/generation.

**v2 — breadth**
- System design type + rubric grading + diagram canvas.
- JS/TS via WebContainers (verify commercial licensing first).
- Optional accounts + BYOK unlock.
- Public/shareable bank, upvoting good problems.

## 17. Open questions & risks

- **Generation quality is make-or-break.** A hallucinated or unrealistic bug erodes trust instantly. The self-check pass and `quality_score` prune are the mitigations — budget real iteration here.
- **Pyodide limits.** Pure-Python + select compiled packages (NumPy/Pandas-class) only, no network. Scope generated problems to what runs in-browser.
- **JD → problem mapping.** Retrieval-first over the bank (cheap, fast), generate-on-miss.
- **Review-comment matching.** Anchoring free-text comments to structured issues needs a carefully tuned caught/missed threshold to avoid frustrating false "you missed it" calls.
- **WebContainers licensing** must be checked before any hosted JS/TS support.

## 18. Naming

"Anvil" is a working title (forge metaphor: hammer raw skill into shape under heat, which also drives the UI's visual identity). Confirm availability before committing.

---

*Next deliverable: the v0 build plan — repo layout, the Monaco + Pyodide worker wiring, the tests-panel contract, and the first generation prompt.*