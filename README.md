# Anvil ⚒️

**Interview practice for the skills LeetCode ignores** — debugging, code review, and system design. Browser-based and AI-graded.

> LeetCode drills algorithmic puzzles because a unit-test harness says right or wrong instantly. But the skills that actually break candidates — reading unfamiliar code under pressure, catching the subtle bug in a plausible AI-written PR, reasoning through a design out loud — have no such oracle. Anvil builds one.

## The core idea

**The AI plants the flaws, so the grader holds the answer key.** Every problem starts as clean, correct code; realistic flaws are seeded into it and verified real by executing the code. Grading then stops being subjective: *which of the known flaws did you catch, how precisely, and did you raise false positives?*

- **Debug** — runnable code + a bug-report symptom. Edit and re-run in your browser (Python via WebAssembly — nothing leaves your machine) until the tests go green.
- **Code review** — a plausible AI-generated PR hiding 1–3 planted flaws. Leave line comments, submit, then defend them.
- After grading, an **AI interviewer probes exactly what you missed**, one Socratic question at a time — that follow-up is the actual lesson.

## Quick start

```bash
npm install
npm run db:migrate        # create the local SQLite db
npm run seed              # load the hand-authored problem bank
cp .env.example .env
# Set BYOK_ENCRYPTION_KEY; ANTHROPIC_API_KEY is only needed by generation/maintenance scripts.
npm run dev               # → http://localhost:3000
```

Open **Connect key** in the top bar to use grading, hints, Socratic follow-up,
or JD matching. The user-owned Anthropic key is validated once, encrypted into
an eight-hour HttpOnly cookie, and never stored in Prisma or browser-readable
storage. Claude subscriptions do not include API access; the key must come from
an API-enabled Anthropic Console account.

Public browser traffic cannot invoke the operator-funded generation pipeline.
Bank generation uses `ANTHROPIC_API_KEY` only through CLI/worker workflows or
the bearer-protected `/api/generate` operator endpoint.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on :3000 |
| `npm test` | Unit tests (grading matcher) |
| `npm run e2e:smoke` | Deterministic browser flow with mocked model boundaries (needs `dev` running) |
| `npm run e2e` | Live-model full loop in headless Chromium (needs `dev` running) |
| `npm run seed` | Reset the hand-authored problem bank |
| `npm run generate:bank -- --type debug --count 3` | Generate verified problems through the shared pipeline |
| `npm run build` | Production build |

The browser suite targets `http://localhost:3000` by default. Point it at a
different local or deployed instance with `E2E_BASE_URL`, for example:

```bash
E2E_BASE_URL=http://localhost:3001 npm run e2e
```

## How it's put together

The browser is the compute layer: Pyodide in a Web Worker runs untrusted Python and localStorage recovers active drafts. A thin Next.js backend serves stripped problem payloads, uses a request-scoped BYOK client to grade against the seeded key, and streams the interviewer over SSE. Prisma uses SQLite locally; PostgreSQL is the production target. Full details are in [ARCHITECTURE.md](ARCHITECTURE.md), with deployment limits in [SCALING.md](SCALING.md).

*"Anvil" is a working title. The logo is a placeholder. The forge metaphor — hammering raw skill into shape under heat — is the point.*
