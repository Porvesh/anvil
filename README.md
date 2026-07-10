# Anvil ⚒️

**Interview practice for the skills LeetCode ignores** — debugging, code review, and (soon) system design. Free, browser-based, AI-graded.

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
echo 'ANTHROPIC_API_KEY=sk-ant-…' >> .env   # grading + interviewer need it
npm run dev               # → http://localhost:3000
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on :3000 |
| `npm test` | Unit tests (grading matcher) |
| `npm run e2e` | Full-loop check in headless Chromium (needs `dev` running) |
| `npm run seed` | Reset the hand-authored problem bank |
| `npm run generate:bank -- --type debug --count 3` | Generate new problems offline (Sonnet + executed self-check) |
| `npm run build` | Production build |

## How it's put together

Browser = compute layer (Pyodide in a Web Worker runs untrusted code); a thin Next.js backend serves problems (answer keys stripped), grades against the seeded key (deterministic line-anchor matcher + Haiku judgment), and streams the Socratic follow-up over SSE. Full details in [ARCHITECTURE.md](ARCHITECTURE.md); product rationale in [docs/spec.md](docs/spec.md).

*"Anvil" is a working title. The logo is a placeholder. The forge metaphor — hammering raw skill into shape under heat — is the point.*
