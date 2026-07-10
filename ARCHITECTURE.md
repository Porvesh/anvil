# Anvil — Architecture

Anvil is "LeetCode for the skills LeetCode ignores": **debugging**, **code review**, and (phase 2) **system design**. Free, browser-based, AI-graded. This document describes how the implemented system is put together. Product rationale lives in [`docs/spec.md`](docs/spec.md); the original static UI prototype is [`docs/v1.html`](docs/v1.html).

## The load-bearing idea

The AI **plants the flaws** during offline generation, so it holds the **answer key**. Grading therefore collapses from a subjective judgment into a near-deterministic comparison: *which of the known, seeded issues did the user catch, how precisely, and did they raise false positives?* Debug and Review are **two modes of one engine** — same generation pipeline, same answer-key model, same grading core.

## The browser is the compute layer

The server never runs user code. Untrusted Python executes in **Pyodide inside a Web Worker** on the user's machine, so the security burden disappears and compute is free. Only two calls leave the browser: fetch a problem, and submit for grading.

```
┌───────────────────────── BROWSER ─────────────────────────┐
│  Monaco editor / PR diff viewer / chat                     │
│  Pyodide in a Web Worker  ── runs tests, terminate()s      │
│                              runaway loops                 │
└───────────────┬────────────────────────────┬──────────────┘
                │ GET /api/problems[...]        │ POST /api/grade  (JSON)
                │ (bank read, key stripped)     │ POST /api/socratic, /api/hint (SSE)
                ▼                                ▼
┌──────────── Next.js route handlers (Node runtime) ─────────┐
│  rate limit · request validation (zod) · keys stay here    │
└──────────┬─────────────────────────────────┬──────────────┘
           ▼                                   ▼
   ┌──────────────┐                    ┌──────────────────┐
   │ Prisma/SQLite │                    │  Anthropic API   │
   │ bank + answer │                    │  Haiku = grading │
   │ keys + attempts│                   │  + Socratic/hint │
   └──────┬────────┘                    └──────────────────┘
          ▲
   ┌──────┴─────────────────────────────────────────────┐
   │ OFFLINE GENERATION (scripts/generate-bank.ts)       │
   │ Sonnet injects flaws → answer key + tests →         │
   │ self-check (python3 runs code, verifies bug real) → │
   │ writes to bank. Not user-facing.                    │
   └─────────────────────────────────────────────────────┘
```

## Directory map

```
app/
  layout.tsx, globals.css        design system (forge identity, ported from v1.html)
  page.tsx                       home — server component, reads the bank
  solve/[id]/page.tsx            solve — server component, strips the answer key
  api/
    problems/route.ts            GET bank list (filters)
    problems/[id]/route.ts       GET one public problem (no answer key)
    grade/route.ts               POST grade a submission → { attemptId, grade }
    socratic/route.ts            POST stream the Socratic follow-up (SSE)
    hint/route.ts                POST stream a solve-time hint (SSE, no answer key)

components/
  shell/       TopBar, Logo                    constant app chrome
  home/        Home                             hero, JD card, bank, tracks
  solve/       SolveWorkspace                   the phase machine (solve → results)
               DebugPane                        Monaco + Run + tests panel
               ReviewPane                       PR diff + inline comment threads
  ai/          InterviewerPanel                 persistent chat (hints & Socratic)
  results/     Results                          score ring + caught/missed/FP

lib/
  types.ts                       single source of truth for cross-boundary shapes
  db.ts                          Prisma client singleton
  problem.ts                     row → typed view mappers (strips the answer key)
  pyodide/                       harness.ts (all Python), runner.ts (warm worker), worker
  grading/                       matcher.ts (deterministic), index.ts (assembly + score)
  anthropic/                     client, models, grade (structured), socratic, hint, stream
  generation/                    generate.ts (Sonnet), selfcheck.ts (python3 oracle)
  validation.ts, ratelimit.ts, session.ts, sseClient.ts

prisma/         schema.prisma, migrations/, seed.ts (7 hand-authored problems)
scripts/        generate-bank.ts (offline generation CLI)
tests/          matcher.test.ts (vitest)
```

## Execution model (debug)

`lib/pyodide/harness.ts` is the **single source of truth** for how code runs: it `exec`s `setup → user code → each test` in a shared namespace (tests run in a shallow copy so they can't clobber each other), and returns structured per-test pass/fail. Data crosses the JS→Python boundary via Pyodide **globals**, never string interpolation, so user code with quotes/backslashes can't break the harness.

`lib/pyodide/runner.ts` keeps **one warm worker** so the ~15MB runtime stays hot between runs, and applies the watchdog timeout only to *execution* (boot is awaited first). On timeout it `terminate()`s and respawns — the only way to actually kill a runaway loop. A timeout is itself a signal: the infinite loop is often the bug.

## Grading (spec §12)

1. **Deterministic core** (`lib/grading/matcher.ts`): a review comment catches an issue if it lands **on the buggy line** (exact), or **within ±1 line AND its text hits the issue's keywords** — the keyword gate on adjacency prevents an unrelated neighbouring comment from being miscredited (spec §17).
2. **Model judgment** (`lib/anthropic/grade.ts`, Haiku, structured output): judges whether *unmatched* comments are real issues or false positives (review), and whether the fix targets the root cause vs. masks the symptom (debug). The problem + answer key sit in a cached system prefix.
3. **Score assembly** (`lib/grading/index.ts`): the number is computed **in code** (recall − false-positive penalty for review; objective tests-pass + approach for debug) so it's reproducible and defensible. The model contributes qualitative judgment, not the grade.

The **objective** debug signal (did tests go green) is derived from the client-reported run history — by design, since execution is client-side and the server can't re-run.

## Socratic follow-up & hints (SSE)

`lib/anthropic/stream.ts` streams Haiku token-by-token as SSE frames (`data: {type:"delta"|"done"|"error"}`). The **Socratic** follow-up (`socratic.ts`) probes the *missed* issues one question at a time, loading the grade + answer key from the persisted attempt so ground truth is never trusted from the client. **Hints** (`hint.ts`) are given the *public* problem only (no answer key) — so they physically can't leak the solution. Both guarantee `messages[0]` is a user turn (`ensureUserFirst`), since transcripts naturally begin with an interviewer greeting.

## Generation (offline, spec §11)

`scripts/generate-bank.ts` calls Sonnet (`lib/generation/generate.ts`) to produce a structured problem, then **self-checks** it (`lib/generation/selfcheck.ts`): for debug, it *executes* the code via local `python3` — the correct code must pass every test and the buggy code must fail at least one, or the problem is rejected and regenerated. This is what makes generation trustworthy ("generation quality is make-or-break"). Only problems that pass are written to the bank with a `quality_score`.

## Data model

`Problem` (bank) and `Attempt` (per-session) — see `prisma/schema.prisma`. Enum-like columns are strings and structured content is `Json`, so the schema is portable: **SQLite for local dev**, **Postgres for prod** by flipping the datasource provider and re-migrating. The `answer_key` is structured (line range + severity + failure + explanation + keywords), which is what makes grading near-deterministic.

## Tech stack

Next.js 16 (App Router) · TypeScript · Prisma 6 + SQLite (→ Postgres) · `@monaco-editor/react` · Pyodide (Web Worker) · Anthropic SDK (Sonnet generation, Haiku 4.5 grading/Socratic) · zod (validation + structured outputs) · vitest.

## Status vs. spec milestones

- **v0 (prove the loop)** — done: Pyodide+Monaco run panel, hand-authored debug problems, submit → run → grade, no accounts.
- **v1 (the real engine)** — largely done: generation pipeline + self-check, Debug *and* Review modes with the shared morphing shell, Socratic follow-up, subsidized grading + rate limits, anonymous session history, JD paste (selects from bank; on-miss generation is the CLI today).
- **v2 (breadth)** — not started: system design + rubric + canvas, JS/TS via WebContainers, accounts + BYOK, public/shareable bank.

### Known limitations

- Rate limiting is in-memory (per-process) — fine for local/single-instance; move to Upstash/KV for serverless prod.
- JD "Generate" on the home page selects a matching bank problem; live on-miss generation runs via the CLI, not yet wired into the request path.
- The debug objective grade trusts client-reported test results (inherent to client-side execution).
