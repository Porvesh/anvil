# Anvil — System Spec v3

**As of:** 2026-07-30 · base `db948a7` · 33 commits · ~6.3k lines of TS/TSX
**Supersedes:** spec v1 and spec v2 (previously concatenated in this file), `docs/anvil-spec-v0.2.md`. This is the only architecture doc; if it disagrees with the code, fix whichever is wrong and say so here.
**Purpose:** implementable. §1–§9 describe the system as it exists (every claim verified against the code and the live DB). §10–§15 are the build contracts. §16 is the order to build them in.

Facts corrected from v2 during verification: the public problem payload leaks `answerKeyCount` and `jdContext` (→ B0); `difficulty` is a `String`, not `Int`; debug scores are 45% model-emitted, not "arithmetic over deterministic input"; the CLI *has* been executed (2 of 8 generated problems carry no JD); there are 2 votes, not zero.

---

## 1. The three ideas everything follows from

**① The generator plants the flaw, so it owns the answer key.**
Grading is not "is this a good review?" It is "which of these N known, seeded issues did you find, how precisely, and what did you invent?" True for debug and review. **Not true for design** — see ③.

**② The browser is the compute layer.**
The server never executes user code. Python runs in Pyodide inside a Web Worker on the user's machine. Sandboxing burden → zero. Compute cost → zero. Price paid: the server trusts the client's report of test results (INV-4).

**③ Two modes on one spine; a third on the same chassis.**

| | Debug | Review | Design |
|---|---|---|---|
| Answer key | ✅ | ✅ | ❌ rubric |
| Execution oracle | ✅ | ⚠️ B7 | ❌ B7 |
| Deterministic layer 1 | tests green | matcher | none |
| Model's share of the score | 45% (`approachScore`) | FP count only (12 pts each) | 100% |
| Shell · routes · persistence · SSE · curation | ✅ | ✅ | ✅ |

Design shares everything structural and nothing epistemic. Note the middle column of the score row is honest now: **no mode is fully model-free** — review is closest (recall is deterministic; only the FP penalty is model-supplied), debug weights a model-emitted `approachScore` at 45%, design is entirely judged. This is why judge model quality (B3) matters in every mode, not just review.

Everything else — Wilson ranking, warm workers, SSE streaming, the keyword gate — is plumbing in service of those three.

---

## 2. The system today, one picture

```
        OFFLINE / BATCH                             LIVE / PER-REQUEST
   ┌──────────────────────────┐              ┌──────────────────────────────┐
   │ npm run generate:bank    │              │ user pastes a job description│
   │ scripts/generate-bank.ts │              │ POST /api/generate  (~100s)  │
   └────────────┬─────────────┘              └───────────────┬──────────────┘
                └──────────────┬──────────────────────────────┘
                               ▼
   ╔═══════════════════════════════════════════════════════════════════════╗
   ║  ① GENERATION            lib/generation/                              ║
   ║                                                                       ║
   ║   Sonnet 5 ──► correct project + buggy project + tests + ANSWER KEY   ║
   ║                               │                                       ║
   ║                               ▼                                       ║
   ║   SELF-CHECK (local python3 — real execution, not a vibe check)       ║
   ║     · correct code must pass EVERY test        ┐                      ║
   ║     · buggy code must fail AT LEAST ONE test   │  any failure         ║
   ║     · correct/buggy file sets must match       ├─►  REJECT + retry    ║
   ║     · buggy file must be editable              │                      ║
   ║     · no unsafe paths, no crash-only bugs      ┘                      ║
   ╚═══════════════════════════════╤═══════════════════════════════════════╝
                                   ▼ passed
   ╔═══════════════════════════════════════════════════════════════════════╗
   ║  ② THE BANK              prisma/ · SQLite now, Postgres at B6         ║
   ║   Problem { type, files|diff|rubric, testSuite, ANSWER KEY, tallies } ║
   ║   Attempt { submission, runHistory, grade, transcript }               ║
   ║   Vote    { unique per (problem, session) }                           ║
   ╚═══════════════════════════════╤═══════════════════════════════════════╝
                                   │
                    ┌──────────────┴───────────────┐
                    │  ◄── ANSWER KEY STRIPPED HERE │   lib/problem.ts
                    │   (INV-1 — but see B0: count  │
                    │    and jdContext still leak)  │
                    └──────────────┬───────────────┘
                                   ▼
   ╔═══════════════════════════════════════════════════════════════════════╗
   ║  ③ SERVER            Next.js 16 route handlers, runtime = "nodejs"   ║
   ║   zod validation · in-memory rate limit 20/60s · anon sessionId      ║
   ║   API keys live here and only here                                   ║
   ╚═══╤═══════════════════════════════════════════════════════════════╤═══╝
       │ GET  /api/problems            POST /api/grade      (JSON)     │
       │ GET  /api/problems/[id]       POST /api/socratic   (SSE)      │
       │ GET  /api/problems/random     POST /api/hint       (SSE)      │
       │ POST /api/problems/[id]/vote  POST /api/generate   (SSE)      │
       ▼                                                               ▼
   ╔══════════════════════════════════╗          ╔════════════════════════╗
   ║  ④ BROWSER  (the compute layer)  ║          ║  ⑤ ANTHROPIC API       ║
   ║  Monaco multi-file editor        ║          ║  sonnet-5  → generate  ║
   ║  PR diff + inline comments       ║          ║  haiku-4-5 → judges,   ║
   ║  design-doc pane + rubric        ║          ║    Socratic, hints     ║
   ║  voice (Web Speech API)          ║          ║  (rerouted at B3)      ║
   ║                                  ║          ╚════════════════════════╝
   ║  Pyodide in a Web Worker         ║
   ║   · ONE warm worker, ~15MB hot   ║          ╔════════════════════════╗
   ║   · watchdog on exec only        ║          ║  ⑥ CURATION            ║
   ║   · timeout → terminate+respawn  ║          ║  👍/👎 → Wilson rank   ║
   ╚══════════════════════════════════╝          ║  net-negative → retire ║
                                                 ╚════════════════════════╝
```

---

## 3. Every moving piece

Six subsystems. If a change doesn't fit in one of these, the map is wrong and needs updating.

| # | Subsystem | Owns | Lives in | Fails how |
|---|---|---|---|---|
| ① | **Generation** | turning a prompt (or a JD) into a verified problem + answer key | `lib/generation/`, `scripts/generate-bank.ts`, `api/generate` | silently banks an unsolvable or flawless problem |
| ② | **Bank / data** | the shared problem pool, attempts, votes; stripping the answer key | `prisma/`, `lib/db.ts`, `lib/problem.ts` | leaks ground truth to the client (see B0 — it currently does) |
| ③ | **Server edge** | validation, rate limiting, sessions, key custody | `app/api/*`, `lib/validation.ts`, `ratelimit.ts`, `session.ts` | in-memory limiter breaks the moment there's >1 instance |
| ④ | **Solve surface** | editor, diff viewer, design pane, running code | `components/solve/`, `lib/pyodide/` | a runaway loop hangs the tab; stale modules make a fix look like a no-op |
| ⑤ | **Grading** | matcher → model judgment → in-code assembly | `lib/grading/`, `lib/anthropic/grade.ts` | under-credits good reviewers (B4); judge errors move scores (B3) |
| ⑥ | **Interviewer + curation** | hints, Socratic probing, voice; votes, ranking, retirement | `lib/anthropic/{socratic,hint,stream}.ts`, `lib/useVoice.ts`, `lib/curation.ts` | hints leak the answer; votes punish hard-but-good problems |

Two cross-cutting files that aren't subsystems but are load-bearing:

- **`lib/types.ts`** — single source of truth for every shape that crosses a boundary. Client, server, DB, and model all agree here or nowhere.
- **`lib/pyodide/harness.ts`** — single source of truth for *how code runs*. All the Python lives here. If execution semantics change, they change in exactly one place.

---

## 4. Journey A — how a problem gets born

```
  prompt (or job description)
        │
        ▼
  ┌─────────────────────────────────────────────────────┐
  │ Sonnet 5, adaptive thinking, MAX_TOKENS = 32000     │
  │ (the project is emitted TWICE — correct and buggy — │
  │  plus tests plus the key. Hence the token ceiling.) │
  └─────────────────┬───────────────────────────────────┘
                    ▼
  ┌─────────────────────────────────────────────────────┐
  │ STRUCTURAL GATES                                    │
  │   file sets match? · buggy file editable? ·         │
  │   paths safe? · bug is not crash-only?              │
  └────────┬────────────────────────────────┬───────────┘
           │ fail                           │ pass
           ▼                                ▼
      regenerate            ┌─────────────────────────────────────┐
                            │ EXECUTION ORACLE  (local python3)   │
                            │   run tests vs CORRECT → all pass?  │
                            │   run tests vs BUGGY   → ≥1 fail?   │
                            └────────┬───────────────────┬────────┘
                                     │ no                │ yes
                                     ▼                   ▼
                                regenerate        persist to bank
                                                  with qualityScore
```

**Why the oracle matters more than the prompt.** A generated problem can be wrong in two directions: unsolvable (the "correct" code doesn't actually pass) or pointless (the "bug" doesn't actually break anything). Both are invisible to inspection and fatal to the user's trust. Executing both versions catches both. This is the single highest-value component in the system.

**The gap:** the oracle only runs for **debug**. Review problems are generated and banked unverified — most of why the bank is 13 debug / 4 review / 1 design. Review items are also a correct-vs-buggy pair, so the same oracle applies with no new machinery (B7).

---

## 5. Journey B — how a session runs

```
 BROWSER                          SERVER                    MODEL
   │                                │                         │
   │ GET /solve/[id]                │                         │
   │───────────────────────────────►│                         │
   │                                │ read Problem            │
   │                                │ STRIP answerKey ◄─ INV-1│
   │◄───── public problem ──────────│                         │
   │                                │                         │
 ┌─┴──────────────────────────┐     │                         │
 │ SOLVE PHASE                │     │                         │
 │  edit files / leave inline │     │                         │
 │  comments / write doc      │     │                         │
 │                            │     │                         │
 │  Run ──► Pyodide worker    │     │                         │
 │    write files to VFS      │     │                         │
 │    purge stale modules     │     │                         │
 │    exec setup→code→tests   │     │                         │
 │    each test in a shallow  │     │                         │
 │      copy of the namespace │     │                         │
 │    ◄── per-test pass/fail  │     │                         │
 │    (appends to runHistory) │     │                         │
 │                            │     │                         │
 │  stuck? ──► POST /api/hint │────►│ public problem ONLY ───►│  (no key,
 │            ◄──── SSE ──────│◄────│◄──────── stream ────────│   INV-5)
 └─┬──────────────────────────┘     │                         │
   │                                │                         │
   │ POST /api/grade                │                         │
   │  {submission, runHistory}      │                         │
   │───────────────────────────────►│                         │
   │                                │ 1. matcher (pure code)  │
   │                                │ 2. judge unmatched ────►│  key in
   │                                │◄─── verdicts ───────────│  cached
   │                                │ 3. assemble score       │  prefix
   │                                │    IN CODE ◄─ INV-3     │
   │                                │ persist Attempt         │
   │◄──── {attemptId, grade} ───────│                         │
   │                                │                         │
 ┌─┴──────────────────────────┐     │                         │
 │ RESULTS PHASE              │     │                         │
 │  score ring                │     │                         │
 │  caught / missed / FP      │     │                         │
 │  ScoreLine breakdown       │     │                         │
 └─┬──────────────────────────┘     │                         │
   │ POST /api/socratic {attemptId} │                         │
   │───────────────────────────────►│ load grade + key from   │
   │                                │ the PERSISTED attempt   │
   │                                │ ◄─ INV-2                │
   │                                │ probe MISSED issues ───►│
   │◄──── SSE, one question ────────│◄──────── stream ────────│
   │      at a time                 │                         │
   │                                │                         │
   │ POST /api/problems/[id]/vote   │                         │
   │───────────────────────────────►│ interactive txn,        │
   │                                │ tallies recomputed      │
   │                                │ from count()            │
```

**Phase machine.** `SolveWorkspace` owns exactly three phases: `solve → grading → results`. `GradingOverlay` is the middle one. No other component holds phase state.

**`ensureUserFirst`.** Transcripts naturally open with an interviewer greeting, but the API 400s if `messages[0]` isn't a user turn. Both streaming paths normalize this (`lib/anthropic/stream.ts:23`). Easy to reintroduce; don't.

---

## 6. Journey C — how a score gets computed

Three layers, strictly ordered. The score is *assembled* in code (INV-3), but be precise about which inputs are deterministic and which are model-supplied — v2 got this wrong twice before landing here.

```
  submission (comments / edited files / design doc)
        │
        ├─► LAYER 1  matcher.ts (pure, 6 tests, no model)
        │     exact line hit → CAUGHT
        │     ±1 line AND keyword hit → CAUGHT        ← adjacency gate
        │     in answerKey.anchors AND keyword hit → CAUGHT   (NEW, B4)
        │     else → unmatched
        │
        ├─► LAYER 2  model judgment, structured output, key in cached prefix
        │     judgeReview: unmatched → real issue (+ matchedIssueId?, B4) | FP
        │     judgeDebug:  root cause | symptom mask → approachScore 0–100
        │     judgeDesign: rubric aspects addressed? + depthScore 0–100
        │
        └─► LAYER 3  grading/index.ts — assembly, in code
              review: round(recall × 100) − 12 × falsePositives
              debug:  testsPassed × 55 + approachScore × 0.45
              design: coverage × 70 + depthScore × 0.30
              emits ScoreLine[] → rendered component-by-component
```

**Where the model touches the number (be honest about this):**

| Mode | Deterministic input | Model-supplied input | Model's leverage |
|---|---|---|---|
| Review | recall (matcher) | FP verdicts | −12 pts per FP call |
| Debug | testsPassed (55%) | `approachScore`, per-issue `addressed` | 45 pts + the caught/missed chips |
| Design | none | everything | 100 pts |

A judge that mistakes a legitimate insight for an FP costs the user 12 real points; a judge that low-balls `approachScore` costs a debugger up to 45. **The judge is the least appropriate place in the system for the cheapest model** — that's B3, and it applies to all three modes.

**Mitigations:** better judge model + thinking (B3); persist `falsePositives[]` with reasons so deductions are auditable (done — they're in the grade blob); `matchedIssueId` lets a judge rescue a conceptually-correct comment the matcher missed (B4).

**B4 — the matcher under-credits strong reviewers.** The ±1 window assumes people comment *at* the defect. Strong reviewers comment at the conceptual site — function signature, `with` block header, top of the handler — for exactly the flaws that matter most (missing idempotency key, missing lock, unbounded retry). That's 5–15 lines away, so the issue scores **missed** while the comment correctly scores **not an FP**. Recall is biased against your best users. Fix: generator declares `anchors: number[]`; judge may return `matchedIssueId`.

---

## 7. Data model — as it exists (SQLite, `prisma/schema.prisma`)

Three tables. Enum-like columns are plain **strings**, structured blobs are **`Json`** (TEXT on SQLite, jsonb on Postgres) — that's the whole portability story. This section describes the *actual* schema; §11 lists the deltas to apply.

```
┌────────────────────────────────────────────────────────────────┐
│ Problem                                                        │
│   type          "debug" | "review" | "design"  (one table)     │
│   language      String @default("python")                      │
│   difficulty    "easy" | "medium" | "hard"   ← STRING, not Int │
│   title, prompt String                                         │
│   jdContext     String?  ← the pasted JD. Server-only after B0 │
│   starterCode   String?  ← legacy single-file; superseded by   │
│                            files (toProblem wraps it, keep)    │
│   files         Json?  ← debug: the multi-file project         │
│   diff, prMeta  Json?  ← review: the PR                        │
│   testSuite     Json?                                          │
│   rubric        Json?  ← design: the scoring dimensions        │
│   answerKey     Json   ← GROUND TRUTH. never leaves the server │
│   qualityScore  Float? ← from generation self-check            │
│   source        "authored" | "generated"                       │
│   upvotes / downvotes / timesAttempted  Int, denormalized      │
│   retired       Boolean                                        │
│   @@index([retired, type, difficulty])  ← matches bank query   │
└───────────────┬────────────────────────────────────────────────┘
                │ 1..n                        │ 1..n
                ▼                             ▼
┌───────────────────────────────┐  ┌──────────────────────────────┐
│ Attempt                       │  │ Vote                         │
│   sessionId  (anon)           │  │   sessionId                  │
│   submission   Json           │  │   value      +1 / -1         │
│   runHistory   Json?          │  │   createdAt, updatedAt       │
│   grade        Json?          │  │   @@unique([problemId,       │
│   transcript   Json?          │  │             sessionId])      │
│   @@index([sessionId])        │  │   ← this unique constraint   │
│   @@index([problemId])        │  │     IS the idempotency       │
└───────────────────────────────┘  └──────────────────────────────┘
```

**The answer key shape is the product.** Everything downstream depends on it being structured, not prose:

```ts
type Issue = {
  id: string;            // "IDEM-1"
  file?: string;         // multi-file debug
  lineStart: number;
  lineEnd: number;
  anchors?: number[];    // NEW (B4) — other legitimate comment sites
  severity: "critical" | "major" | "minor";
  failure: string;       // observable consequence
  explanation: string;
  keywords: string[];    // drives the adjacency gate
};
```

`lineStart/lineEnd` drive the matcher. `keywords` drive the adjacency gate. `severity` could weight the score (it currently doesn't — deferred, §16).

---

## 8. Invariants — with honest enforcement status

These are the rules that, if broken, break the product rather than a feature. Worth a test each.

| ID | Invariant | Enforced by | Status |
|---|---|---|---|
| INV-1 | The answer key never reaches the client during solve | `lib/problem.ts` — single strip point | ⚠️ key itself: yes. But `toPublicProblem` ships `answerKeyCount` and `jdContext` → **B0** |
| INV-1a | Corollary: grading cannot run client-side, ever. The matcher is pure and *could*, but feeding it the key would breach INV-1. Not a gap — a property. Don't "optimize" it | — | ✅ |
| INV-2 | Ground truth never trusted from the client | grade/socratic read from `Problem` / persisted `Attempt` | ✅ verified |
| INV-3 | The score is *assembled* in code, never emitted whole by a model | `grading/index.ts` — but model-supplied inputs per §6 table | ✅ as stated |
| INV-4 | The server never executes user code | Pyodide is the only executor; accepted cost: trusting `runHistory` | ✅ |
| INV-5 | Hints receive the public problem only | `hint.ts` signature takes `PublicProblem` | ✅ verified — structural, not prompt-level |
| INV-6 | `messages[0]` is always a user turn | `ensureUserFirst`, both stream paths | ✅ verified |
| INV-7 | A vote is idempotent per session | DB unique constraint + interactive txn, tallies via `count()`, `deleteMany` for toggle | ✅ verified |
| INV-8 | A banked problem is solvable and its flaw is real | `selfcheck.ts` execution oracle | ⚠️ debug only — B7 |
| INV-9 | The user is never told how many flaws were planted | de-spoil pass (UI) | ❌ **broken at the API layer** — `answerKeyCount` is in every problem response, one devtools tab away → B0 |
| INV-10 | *(NEW, at B8)* Generation never runs in a request handler | worker tier; enforced by absence of python3 in web | pending |
| INV-11 | *(NEW, at B1)* Every score records its `graderModel`; every problem its `generatorModel` | schema fields | pending |
| INV-12 | *(NEW, at B0)* A pasted JD is never served to any client | strip from `PublicProblem`; JD moves to `GenerationJob` at B8 | pending |

**Privacy note (why INV-12 exists).** No accounts, no email, no PII; `sessionId` is client-generated and anonymous. But a pasted JD may contain a real company's internal role details — and today it is (a) persisted on `Problem.jdContext` and (b) **served to every client** who loads that problem, because `toPublicProblem` spreads it through. This is not a future `GenerationJob` concern; it's live. B0 fixes the serving path immediately; the retention decision (drop the JD after generation vs. scrub-pass before banking) is B9 and still blocks the first public deploy.

---

## 9. State of play — accurate tense

**There is no operating bank.** 18 rows in a local dev SQLite file: 13 debug (6 authored / 7 generated) · 4 review (3 / 1) · 1 design (authored). 6 attempts, 2 votes, none retired, one user. The pasted-JD field is set on 6 rows.

**The CLI has run, but never at batch scale.** 2 of the 8 generated problems carry no `jdContext` (the CLI-path signature; the live route always has a JD). So `scripts/generate-bank.ts` executes — B2 is about scale and measuring the oracle's reject rate, not proving the script works.

Consequences, unchanged from v2 and still true:
- Every curation claim (Wilson ranking works, the bank self-curates) is a property of **pure functions with 18 passing tests**, not observed behavior. Do not cite it as evidence.
- Cost per problem served is currently the worst it will ever be.
- The real evidence the loop works is the e2e harness and 24 unit tests. That's genuine, and it's enough.

**Tests:** 6 matcher (caught/missed/FP/adjacency gate) + 18 curation (Wilson, ranking, retirement), vitest. Plus a headless-Chromium Playwright e2e (`npm run e2e`, `scripts/e2e.mjs`) driving the real loop: home → debug solve → Monaco mounts → Pyodide runs (buggy fails → fix → green) → grade → results → Socratic streamed → review solve → inline comment → grade → results → design → rating → shuffle. Zero console errors.

**Stack:** Next.js 16.2 (App Router, all routes `runtime = "nodejs"`) · TypeScript · React 19.2 · Prisma 6.19 + SQLite (→ Postgres, B6) · `@monaco-editor/react` · Pyodide (Web Worker) · Anthropic SDK 0.110 · zod 4 · vitest 4 · Playwright (e2e only).

> Repo rule (AGENTS.md): this Next.js version has breaking changes vs. its docs online — read the relevant guide in `node_modules/next/dist/docs/` before writing route/app code.

**Current models** (`lib/anthropic/models.ts`): generation `claude-sonnet-5` (adaptive thinking, MAX_TOKENS 32000 — the project is emitted twice); grading/Socratic/hints `claude-haiku-4-5`, which 400s on `thinking`/`effort`, so those calls omit them. Both facts verified; both change at B3.

---

# Part II — the build

## 10. Target architecture

```
┌─ BROWSER ────────────────────────────────────────────────────────────────┐
│  Monaco multi-file · PR diff + inline comments · design doc · voice      │
│  Pyodide in a Web Worker — one warm worker, watchdog on exec only,       │
│  timeout → terminate() + respawn                                         │
└──┬────────────────────────────────────────────────────────────────┬──────┘
   │ reads / grade / stream                                          │ SSE
   ▼                                                                 ▲
┌─ WEB TIER ──────────────────────────────────── serverless-able ────┴─────┐
│  Next.js 16 route handlers · zod · KV rate limit · anon sessionId        │
│  GET  /api/problems · /api/problems/[id] · /api/problems/random          │
│  POST /api/problems/[id]/vote · /api/grade · /api/socratic · /api/hint   │
│  POST /api/jd/match          ← ~1s, Haiku, no generation                 │
│  POST /api/generate          ← enqueues only, returns jobId, instant     │
│  GET  /api/generate/[id]/stream                                          │
│  NO python3 · NO long-running calls · API keys live here                 │
└──┬──────────────────────────────────────────────────────────────┬────────┘
   │                                                              │
   ▼                                                              ▼
┌─ POSTGRES (Neon, pooled) ────────────────┐      ┌─ ANTHROPIC ────────────┐
│ Problem · Attempt · Vote · GenerationJob │      │ opus-5    generate,    │
│ also serves as the job queue:            │      │           socratic,    │
│ SELECT … FOR UPDATE SKIP LOCKED          │      │           design judge │
│ (raw SQL via prisma.$queryRaw — Prisma   │      │ sonnet-5  judges, hints│
│  has no native SKIP LOCKED)              │      │ haiku-4-5 jd tagging   │
└──┬───────────────────────────────────────┘      └────────────────────────┘
   ▲
   │ poll / claim / update
┌──┴─ WORKER TIER ─────────────────────────────────── container required ──┐
│  has python3 · unbounded runtime · no HTTP surface                       │
│  lib/generation/index.ts → generate → selfcheck (execute) → persist      │
└───────────────────────────────────────────────────────────────────────────┘
```

**Why two tiers.** Generation needs local `python3` (the oracle) and 200–300s (Opus emitting a project twice). Neither is available in a serverless request handler. Skipping the oracle to fit the request path would put unverified problems in front of a live user — the worst possible place to drop a gate (INV-8).

**Why Postgres for the queue.** `FOR UPDATE SKIP LOCKED` is a fine queue at this volume and costs zero new services. Redis buys you a push instead of a poll; not worth a dependency yet. Implementation notes: `claimJob()` is `prisma.$queryRaw` inside a transaction (Prisma's query API can't express SKIP LOCKED); the SSE job stream learns of phase changes by **polling the `GenerationJob` row every ~1s** — simple, correct, and cheap at this volume. `LISTEN/NOTIFY` is the upgrade if polling ever shows up in a bill; don't start there.

**Deployment**

| Tier | Target | Needs |
|---|---|---|
| Web | Vercel / any serverless | `DATABASE_URL` (pooled), `ANTHROPIC_API_KEY`, KV creds |
| Worker | Railway / Fly / any container | same + `python3` on PATH |
| DB | Neon | pooled endpoint for web, direct for migrations |

Prisma + serverless + Postgres exhausts connection pools fast — use the pooled endpoint everywhere except `prisma migrate`.

---

## 11. Schema deltas (B1, B6, B8)

v2 presented a "target schema" that silently diverged from the real one (`difficulty Int`, `prompt`→`brief`, five dropped columns). Don't do that. The rule: **the migration is additive**; nothing existing is renamed or dropped until there's a data-migration story for it.

**Keep as-is:** `difficulty String` ("easy"|"medium"|"hard" — it works, renaming to Int buys nothing), `prompt` (no rename), `language`, `timesAttempted`, `source`, `Vote.updatedAt`. `starterCode` stays until a one-off migration folds legacy rows into `files` (optional cleanup, not on the critical path).

**Add at B1 (SQLite, before the batch run, so all new problems carry provenance):**

```prisma
model Problem {
  // ... existing fields unchanged ...
  tags           Json    @default("[]")  // B5 — fixed vocabulary, §13
  generatorModel String?                 // INV-11
  sourceJobId    String?                 // provenance for live-generated items
}
```

`grade` blob gains `graderModel: string` (it's Json — no migration needed, just write it). For review it already persists `falsePositives[]` with notes, so the 12-point deductions are auditable — keep that.

**Add at B8 (Postgres):**

```prisma
model GenerationJob {
  id          String   @id @default(cuid())
  sessionId   String
  jd          String   // retention policy: B9. The ONLY place a JD lives after B8
  tags        Json     @default("[]")
  type        String   @default("debug")
  status      String   @default("pending") // pending|claimed|writing|verifying|done|failed
  attempts    Int      @default(0)
  problemId   String?
  error       String?
  claimedAt   DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([status, createdAt])
}
```

At B8, `Problem.jdContext` migrates into `GenerationJob.jd` (linked via `sourceJobId`) and the column is dropped. Until then it stays — server-only after B0.

**B6 (Postgres flip):** datasource `provider = "postgresql"`, delete the SQLite migration history, `prisma migrate dev` fresh, re-seed. Exercise locally in Docker before Neon. This is the one step where "portable by design" gets tested rather than asserted. (`@db.Text` annotations only make sense here, not on SQLite.)

---

## 12. Route contracts

| Route | In | Out | Cost | Limit |
|---|---|---|---|---|
| `POST /api/jd/match` | `{jd: string}` | `{tags, matches: PublicProblem[], confidence}` | ~$0.001 | 20/60s |
| `POST /api/generate` | `{jd, tags?, type?}` | `{jobId}` **immediately** (after B8; today it streams the whole ~100s generation) | $0 | **5/day/session** |
| `GET /api/generate/[id]/stream` | — | SSE phases | $0 | 20/60s |
| `POST /api/grade` | `{problemId, submission, runHistory, sessionId}` | `{attemptId, grade}` | ~$0.02 | 20/60s |
| `POST /api/socratic` | `{attemptId, messages}` | SSE | ~$0.05 | 20/60s |
| `POST /api/hint` | `{problemId, messages, level}` | SSE | ~$0.01 | 20/60s |

Existing bank/vote routes unchanged. New routes copy the existing pattern: `runtime = "nodejs"`, zod-validated body, `rateLimit(clientKey(req))`.

**SSE frames for generation** (reuse `lib/anthropic/stream.ts` frame shape):

```
data: {"type":"phase","phase":"writing"}
data: {"type":"phase","phase":"verifying","attempt":1}
data: {"type":"done","problemId":"clx…"}
data: {"type":"error","message":"rejected after 3 attempts"}
```

**Rate limiting splits.** `lib/ratelimit.ts` already isolates the backing `Map`; swap it for KV at deploy time and add a second, much tighter bucket keyed `gen:{sessionId}:{yyyy-mm-dd}`. Generation is the only endpoint that can produce a real bill, so it's the only one that needs a real budget.

---

## 13. JD flow (match-first)

```
 JDCard state:  idle → matching → (serving | generating) → ready | failed

 paste ─► POST /api/jd/match                                    ~1s
            │
            │ haiku-4-5, zod enum-constrained structured output
            │ tags ⊆ FIXED_VOCAB          ← consistency > richness
            │ query: tag overlap ∧ ¬retired ∧ ¬alreadyAttempted(sessionId),
            │        Wilson-ranked
            ▼
     ┌──────────────┬────────────────────────────────────┐
     │ overlap ≥ T  │ overlap < T                        │
     ▼              ▼                                    │
  serve now    POST /api/generate → {jobId}              │
  redirect     AND serve nearest bank problem NOW ───────┘
  /solve/[id]  (user solves while theirs builds)
  $0                │
                    └─► SSE toast: "your tailored problem is building"
                        on done → toast becomes a link
                        on fail → silent, user is already solving
```

**Never block on generation.** The user is routed into a problem within ~1s in every branch. A failed job is invisible.

**`FIXED_VOCAB`** — a zod enum, ~40 tags, e.g. `idempotency`, `caching`, `concurrency`, `rate-limiting`, `retry`, `sql-injection`, `pagination`, `auth`, `distributed`, `billing`, `webhooks`, `python`, `typescript`. Constrained output is why Haiku is *correct* here rather than merely cheap: a stronger model produces richer, more varied tags, which makes set-overlap matching worse.

**Backfill:** one Haiku pass to tag the 18 existing problems. Required before match-first does anything.

**Why match-first is load-bearing.** It converts each tailored generation into a permanent shared asset. Payments JD → idempotency problem → tagged → next payments JD gets it for a tenth of a cent. Without it, every user pays full generation forever and the bank never becomes anything.

---

## 14. Worker

```ts
// worker/index.ts — no HTTP surface
while (true) {
  const job = await claimJob();            // $queryRaw: FOR UPDATE SKIP LOCKED, status=pending
  if (!job) { await sleep(2000); continue; }
  try {
    await setStatus(job, "writing");
    const problem = await generateAndSelfCheck(job.jd, job.tags, job.type);
    //   ↑ lib/generation/index.ts — UNCHANGED, just not called from a request
    await setStatus(job, "done", { problemId: problem.id });
  } catch (e) {
    job.attempts >= 3 ? await fail(job, e) : await requeue(job);
  }
}
```

Reclaim jobs stuck in `claimed` past a timeout — a crashed worker must not orphan a job.

**Oracle gates (unchanged, debug):** correct passes all tests · buggy fails ≥1 · file sets match · buggy file editable · no unsafe paths · no crash-only bugs. Reject → regenerate.

---

## 15. Model routing (B3)

`lib/anthropic/models.ts` grows from 2 entries to per-call-site routing:

| Call site | Model | Thinking | Why |
|---|---|---|---|
| `generation/generate.ts` | `claude-opus-5` | adaptive (default-on) | oracle catches mechanical failure only — not "boring bug," "typo dressed as a design flaw," "findable with ctrl-F." Those failures are permanent and sit in the bank |
| `grade.ts` `judgeReview` / `judgeDebug` | `claude-sonnet-5` | adaptive (default-on) | judge errors are score errors in every mode (§6 table). Root-cause-vs-symptom-mask improves markedly with thinking |
| `grade.ts` `judgeDesign` | `claude-opus-5` ×2 | adaptive | the one mode where the model owns the whole number needs an ensemble + divergence flag (B7) |
| `socratic.ts` | `claude-opus-5` | adaptive | this is the actual product |
| `hint.ts` | `claude-sonnet-5` | `{type:"disabled"}` | upgrading further breaks de-spoiling — see below |
| `jd/match` | `claude-haiku-4-5` | none (unsupported) | constrained extraction; consistency > quality |

**Implementation notes, verified against current API docs:**

- **Delete the Haiku `thinking`/`effort` workaround** for the judge/Socratic paths once they're on Sonnet/Opus. On Sonnet 5 and Opus 5, adaptive thinking is **on by default** — the change is literally removing the omission, not adding config. Haiku 4.5 keeps the omission (it genuinely 400s on those params) and only serves `jd/match`.
- **Opus 5 generation must handle `stop_reason: "refusal"`.** Opus 5 ships elevated cybersecurity safeguards, and this product *deliberately generates security-flawed code* (there's an SQLi review problem in the bank today). Check `stop_reason` before reading content; on refusal, retry the job on `claude-sonnet-5` (or use the server-side `fallbacks` beta). A refusal must count as a rejected attempt, not a crash.
- **Prompt caching becomes real at B3.** `grade.ts` already puts problem+key in a `cache_control` system prefix, but Haiku 4.5's minimum cacheable prefix is **4096 tokens** — most problems silently don't cache today. Sonnet 5's minimum is 1024, so the existing `cache_control` starts actually working. Verify with `usage.cache_read_input_tokens`, don't assume.
- **Cost:** Opus 5 $5/$25 per MTok → a 32k-token generation ≈ $0.80/call before retries; budget ~$1.50–3 per *banked* problem at realistic reject rates. Sonnet 5 is $3/$15 (intro $2/$10 through 2026-08-31). Haiku $1/$5.
- **Hint ceiling is deliberate.** INV-5 stops hints *seeing* the answer key. It does not stop a stronger model independently solving the problem and handing over the answer. Opus on a hint call will just find the bug. Fix prompt-side first — escalating `level`, name the *region* or the *class of concern*, never the defect. Then reconsider the model.

---

## 16. Build order

Sequenced so nothing waits on a deployment you don't have. B0 is new (found in review); everything after shifts by one from v2, with the v2 B1/B2 ordering contradiction fixed (provenance fields go first — the batch run must carry them).

**B0 — Stop the two leaks.** *(one commit, do before anything else)*
`toPublicProblem` currently ships `answerKeyCount` (breaks INV-9 — flaw count in every response, one devtools tab away) and `jdContext` (breaks INV-12 — one user's pasted JD served to every client). Strip both from `PublicProblem` in `lib/problem.ts` + `lib/types.ts`, fix any UI that read them, extend the e2e to assert neither field appears in a problem response. Independent of every other item.

**B1 — Provenance fields: `generatorModel`, `sourceJobId`, `tags` on Problem; `graderModel` in the grade blob.** *(small)*
Before the batch run, so the 60–100 new problems carry provenance. Without it, every future score is incomparable and "did Opus generation help" is permanently unanswerable.

**B2 — Run the CLI at scale. Get to 60–100 problems.** *(afternoon, zero new architecture)*
The CLI works (it's produced 2 banked problems already) — this is about scale: measure the oracle's real reject rate → cost per *banked* problem; give curation something to rank; give a deployed app something to serve on day one. Match-first (B5) is a cache — building it against 18 problems is building a cache with nothing in it.

**B3 — Model routing + thinking on the judges.** *(small — `models.ts` + refusal handling)*
Per §15. Includes deleting the Haiku workaround on rerouted paths, the Opus-refusal retry in generation, and the hint prompt fix (escalating levels, region-not-defect). Verify cache reads turn nonzero.

**B4 — `anchors` + `matchedIssueId`.** *(small, additive)*
Matcher takes `anchors`; generator emits them; `judgeReview` may return `matchedIssueId`. Add matcher tests for the anchor path. Then **re-grade the 6 stored attempts** and see if scores moved — this is the payoff for persisting raw `submission`, and now every re-grade records its `graderModel` (B1).

**B5 — `FIXED_VOCAB` + `POST /api/jd/match` + tag backfill.** *(medium)*
Serves from bank only. No generation, no worker, no queue. Ships value immediately after B2 and is fully testable locally.

**B6 — Postgres migration.** *(medium, before B8)*
Per §11. Docker locally before Neon.

**B7 — Review oracle + design oracle.** *(medium)*
Review: same `selfcheck.ts` gates on the correct/buggy pair — no new machinery, and 4 review items is not a product. Design: generate a strong reference answer *and* a deliberately weak one, score both against the rubric, require minimum separation or reject — a rubric that can't distinguish good from bad design is the design-mode equivalent of a bug that doesn't break a test. Plus `judgeDesign` ×2 with a divergence flag.

**B8 — `GenerationJob` + worker + queue + SSE + KV limiter + tight gen budget.** *(largest; do at deploy time)*
Per §10/§12/§14. Migrate `jdContext` → `GenerationJob.jd`, drop the column. It's a deployment problem and you don't have a deployment — only now.

**B9 — JD retention/scrub decision.** *(small, blocks first public deploy)*
B0 already stopped the serving-path leak. This is the persistence decision: drop `jd` after the job completes, or scrub-pass before banking. Pick one; don't ship without deciding.

**Deferred until there are users:** Wilson cold-start reserve in shuffle (zero votes → bottom of ranking → no attempts → no votes; reserve a fraction of shuffle picks for items under N votes); splitting the vote into *broken/unsolvable* vs *good problem* so auto-retirement stops selectively killing hard-but-good items; async re-run of persisted attempts through `selfcheck.ts` to measure the INV-4 false-pass rate (never synchronously); `severity`-weighted scoring; JS/TS via WebContainers; accounts + BYOK.

---

## 17. Glossary

| Term | Plain version |
|---|---|
| Answer key | structured list of flaws the generator planted, with line ranges and keywords |
| Matcher | pure code deciding whether a comment lands on a known flaw. No model |
| Adjacency gate | a comment 1 line off counts only if its text mentions the right keywords |
| Anchors | additional lines where a legitimate comment about a flaw may land (B4) |
| False positive | flagging something that isn't a flaw. −12 pts — a reviewer who flags everything catches everything |
| Recall | fraction of planted flaws found |
| Oracle / self-check | actually executing generated code to prove correct passes and buggy fails |
| Wilson lower bound | ranking that accounts for vote *count*, not just ratio. Stops 1-vote items topping the list |
| Pyodide | CPython compiled to WebAssembly. Python in the browser |
| Warm worker | keeping one Web Worker alive so the ~15MB runtime doesn't reload per run |
| SKIP LOCKED | Postgres clause letting many workers claim distinct rows without blocking |
| SSE | Server-Sent Events — one-way streaming HTTP. How the interviewer types token-by-token |
| Socratic pass | post-grade questioning about what you missed, one question at a time. The actual teaching moment |
| De-spoil | removing anything that reveals the answer's shape — flaw counts, guidance bars, leading greetings |
