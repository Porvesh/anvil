# Scaling Anvil across many users

How Anvil is built to serve a large, concurrent user base cheaply — and what changes at each order-of-magnitude. This is the "system design" view of the product itself.

## The property that makes it scale: almost nothing runs on the server

The expensive work is pushed to the edges of the request path:

| Work | Where it runs | Cost to us at scale |
|---|---|---|
| Running untrusted code | The **user's browser** (Pyodide/WASM in a Web Worker) | **$0** — no sandboxes to run, no per-execution compute, no security blast radius |
| Editor, diff viewer, design canvas | The user's browser (Monaco, CDN-served) | $0 — static assets on a CDN |
| Serving a problem | A DB read (answer key stripped) | one indexed row read |
| Grading + Socratic | One Haiku call per submission | pennies, and rate-limited |
| Generating problems | **Offline, batched, one-time** — never in the request path | amortized across every user who ever sees the problem |

So a user solving a problem is, to our infrastructure, **two DB reads and (on submit) one cheap model call.** Ten thousand people solving concurrently is ten thousand people running Python on their own laptops. That is the whole trick.

## Request-path anatomy (per active solver)

```
page load        → 1 read  (GET /solve/[id] → problem row, answer key stripped)
run tests        → 0 server (Pyodide in-browser, N times, free)
ask for a hint   → 1 model call (Haiku, streamed, rate-limited)   [optional]
submit           → 1 model call (Haiku grade) + 1 write (Attempt) + 1 atomic increment
follow-up turn   → 1 model call (Haiku, streamed)                 [optional]
rate the problem → 1 upsert + 1 atomic increment
```

Everything is **stateless** at the app tier (no session affinity, no server-side solve state), so the Next.js routes scale horizontally behind a load balancer with zero coordination. State lives in exactly two places: the DB, and the user's browser (`localStorage` session id).

## Bottlenecks, in the order they'd bite

### 1. The single SQLite file (bites first, ~dozens of concurrent writers)
Local dev uses SQLite. The schema is deliberately portable (string enums, `Json` columns), so production is a **one-line datasource swap to Postgres** (Neon/Supabase) + re-migrate — no model changes. Postgres gives us connection pooling (PgBouncer), read replicas, and real concurrency. **Bank reads** (the hot path) go to replicas; the primary only takes attempt writes and vote upserts.

### 2. Vote/attempt counters under concurrency (solved in the design)
Naïve "read count, add one, write" races and loses votes under load. We never do that:
- Tallies are **denormalized** onto `Problem` (`upvotes`, `downvotes`, `timesAttempted`) and mutated with **atomic `increment`** (`UPDATE … SET upvotes = upvotes + 1`) — correct under any concurrency, no row locks held across a round-trip.
- Votes are **idempotent per session** via a `@@unique([problemId, sessionId])` constraint. Re-voting upserts; the delta math (`lib/curation.ts` `voteDeltas`) turns any transition (first vote / switch / toggle-off) into the right pair of increments. A user mashing the button can't inflate a count.
- **Retirement** is a boolean flag, not a delete — flipping it is O(1), keeps history, and is reversible.

### 3. Ranking the bank (in-code today, indexed tomorrow)
Today the bank list computes the Wilson lower-bound rank in code over the result set — fine for hundreds–low-thousands of problems. The scale move is a stored, indexed `rankScore Float` column recomputed on each vote (inside the same atomic vote transaction), so the list endpoint becomes `WHERE retired = false … ORDER BY rankScore DESC LIMIT n` straight off the `@@index([retired, type, difficulty])`. Pure O(log n) + page size, and cursor-paginated. Random selection already uses `count` + random `skip` (two indexed queries), so "shuffle" doesn't load the table.

### 4. Subsidized grading tokens (the only real variable cost)
Grading is the one thing that costs money per use. Controls, cheapest-first:
- **Prompt caching** on the stable problem+answer-key prefix — repeat grades of the same problem read the prefix at ~10% cost.
- **Rate limiting** per session/IP. Today it's an in-memory fixed window (fine for one instance); at multi-instance scale it moves to **Upstash/Redis or Cloudflare KV** with the identical `rateLimit(key)` interface — the call sites don't change.
- **BYOK** unlock for power users (spec §14) offloads token cost entirely for the heavy tail.
- **Batch API** for generation halves that (already offline).

### 5. Model provider limits
All model calls are Haiku (grading/Socratic/hint) except offline Sonnet generation. Streaming responses keep connections short and avoid HTTP timeouts. If we approach org TPM limits, grading is a natural fit for a queue + graceful "grading is busy, retry" backpressure, since it's already async from the user's point of view.

## How the community bank lets us stop leaning on the model

Generation is a **one-time cost per problem**, but not every generated problem is good. The curation loop closes that:

1. Generate offline, self-checked (debug problems are *executed* to prove the bug is real).
2. Serve from the bank; every solve is an implicit "was this worth doing" and an explicit 👍/👎.
3. Wilson ranking floats the good ones to the top of the bank; `shouldRetire` buries the clearly-bad ones (net-negative with enough signal) so they stop being served.
4. Over time the bank converges on a curated core of strong problems that get **reused across all users** — so cost per problem-served trends toward zero and we generate *less*, not more.

This is the spec's "generate once, persist in a shared bank" (§3) plus "upvoting good problems" (§16 v2), and it's what makes the economics improve with scale instead of degrade.

## What's implemented vs. deferred

**Implemented now:** browser execution, stateless routes, answer-key stripping, atomic denormalized counters, idempotent per-session voting, auto-retirement, Wilson ranking, efficient random selection, indexed bank filter, prompt-cached grading, per-session rate limiting, offline batched generation with executed self-check.

**Deferred (the honest asterisks):** Postgres swap + read replicas (one-line provider change); stored `rankScore` column (in-code ranking works up to low-thousands); Redis/KV-backed rate limiter and counts (in-memory is single-instance only); optional accounts/BYOK; a CDN in front of the app. None of these require schema or API-shape changes — they're operational swaps behind interfaces that already exist.
