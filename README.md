# Anvil ⚒️

**Interview practice for the skills LeetCode ignores** — debugging, code review, and system design. Browser-based and AI-graded.

> LeetCode drills algorithmic puzzles because a unit-test harness says right or wrong instantly. But the skills that actually break candidates — reading unfamiliar code under pressure, catching the subtle bug in a plausible AI-written PR, reasoning through a design out loud — have no such oracle. Anvil builds one.

## The core idea

**The AI plants the flaws, so the grader holds the answer key.** Every problem starts as clean, correct code; realistic flaws are seeded into it and verified real by executing the code. Grading then stops being subjective: *which of the known flaws did you catch, how precisely, and did you raise false positives?*

- **Debug** — runnable code + a bug-report symptom. Edit and re-run in your browser (Python via WebAssembly — nothing leaves your machine) until the tests go green.
- **Code review** — a plausible AI-generated PR hiding 1–3 planted flaws. Leave line comments, submit, then defend them.
- **System design** — a written brief, graded against a generated rubric by two independent judges.

After grading, an **AI interviewer probes exactly what you missed**, one Socratic question at a time. That follow-up is the actual lesson.

## At a glance

```mermaid
flowchart LR
    you["You<br/>edit · comment · write"]
    py["Pyodide<br/>runs the tests in your browser"]
    serve["Anvil<br/>serves the problem<br/>minus the answer key"]
    grade["Grading<br/>matches your work against the key,<br/>score assembled in code"]
    model["Anthropic / OpenAI<br/>your key, request-scoped"]

    serve --> you
    you <-->|"run · nothing leaves the tab"| py
    you -->|"submission"| grade
    grade -->|"bounded judgment"| model
    model -->|"verdicts, never the score"| grade
    grade -->|"grade + Socratic follow-up"| you
```

Three properties fall out of that shape, and the rest of the design follows from them: **your code never runs on our server**, **the answer key never reaches your browser**, and **the score is arithmetic in code, not a number a model chose**. The full picture — every component, the end-to-end request sequence, the generation pipeline, sign-in, and interview mode — is in **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Try it without setting anything up

Every AI feature spends *your* provider key, so `/demo` exists to be read first: a recorded attempt at a real problem from the bank — the PR, the grade, the follow-up — with no key required. Only the interviewer's wording is recorded; the score is computed on the spot by the same matcher and scoring code the product uses.

## Quick start

```bash
npm install
npm run db:migrate        # create the local SQLite db
npm run seed              # sync the hand-authored bank without deleting attempts
cp .env.example .env      # set BYOK_ENCRYPTION_KEY
npm run dev               # → http://localhost:3000
```

`ANTHROPIC_API_KEY` is only needed by operator generation and maintenance scripts — the web app itself needs neither provider credential.

## How the pieces work

**Bring your own key.** Open *Connect key* in the top bar to enable grading, hints, the Socratic follow-up, JD matching, and tailored generation. Pick Anthropic or OpenAI; the key is validated once, sealed into an eight-hour HttpOnly cookie, and never written to Prisma, localStorage, or logs. Consumer Claude/ChatGPT subscriptions do not include API billing — the key must come from the provider's API platform account.

**Accounts are optional.** Anvil starts anonymous, keyed by a `localStorage` id, and works that way indefinitely. Signing in — a single-use emailed link, no password — exists for one reason: the attempts, ratings, and contribution receipts made on that browser are adopted by the account, so they survive cleared site data and follow you to another machine.

To make sign-in email actually arrive, configure one transport:

```bash
RESEND_API_KEY=re_...                            # or
SMTP_URL=smtps://user:pass@smtp.example.com:465  # any account you already have
AUTH_EMAIL_FROM="Anvil <no-reply@your-domain>"   # most relays require this
npm run mail:test -- you@example.com             # check delivery on its own
```

With neither set, the link is written to the terminal running the dev server, and production refuses to sign anyone in at all rather than logging a live credential. **The link is never returned to the browser that requested it** — being able to read the inbox is the whole proof, so handing the credential back to whoever asked would make the verification meaningless.

**Interview mode** runs the same problems under the constraints of the real event: 45 minutes on a clock, three test runs for the whole session instead of iterating to green, and an interviewer who opens, checks in, and calls time. Opt in from the solve page or link straight to it with `?interview=1`. Practice mode stays clock-free.

**Paste a job description** and Anvil checks the verified shared bank first. On a genuine miss, the browser holds one streamed request open while your provider generates *and verifies* a tailored problem; only the finished problem is banked, never the key or the JD. Public traffic cannot invoke the operator-funded pipeline, which reaches `ANTHROPIC_API_KEY` only through CLI/worker workflows or the bearer-protected `/api/generate`.

**Contribute a real interview question** and the source text stays request-local while your provider extracts a sanitized skill brief, applies privacy and quality gates, and checks for an existing equivalent. Anvil stores a metadata receipt and — when the idea is novel — an original exercise that passed the normal oracle. There are no database fields for the submitted text.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on :3000 |
| `npm run build` | Production build |
| `npm test` | Unit and DB-backed tests — scoring, matcher, curation, auth, interview clock, routes |
| `npm run e2e:smoke` | Deterministic browser flow with mocked model boundaries (needs the app running) |
| `npm run e2e` | Live-model full loop in headless Chromium (needs the app running) |
| `npm run seed` | Insert/update the hand-authored bank without deleting attempts |
| `npm run db:migrate` | Create/apply Prisma migrations locally |
| `npm run db:postgres` | Rewrite the datasource for the PostgreSQL production target |
| `npm run generate:bank -- --type debug --count 3` | Generate verified problems through the shared pipeline |
| `npm run worker` | Drain the generation queue (needs `python3` and the operator key) |
| `npm run regrade` | Re-score stored attempts through the current grading path |
| `npm run backfill:tags` | Tag untagged bank problems from the fixed vocabulary |
| `npm run retire:thin` | Retire problems too small to be worth serving |
| `npm run purge:jds` | Clear pasted JDs retained on older rows |
| `npm run purge:tokens` | Drop spent and expired sign-in tokens |
| `npm run mail:test -- you@example.com` | Send a test email through the configured transport |

The browser suites target `http://localhost:3000`. Point them elsewhere with `E2E_BASE_URL`:

```bash
E2E_BASE_URL=http://localhost:3001 npm run e2e
```

## Documentation

| Document | What's in it |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The implemented system: diagrams, data model, API surface, security invariants |
| [SCALING.md](SCALING.md) | What already scales, what doesn't yet, and the deployment checklist |
| [docs/spec.md](docs/spec.md) | The product thesis the build follows |

*"Anvil" is a working title. The logo is a placeholder. The forge metaphor — hammering raw skill into shape under heat — is the point.*
