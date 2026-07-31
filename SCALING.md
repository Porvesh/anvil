# Scaling Anvil

This document separates properties that already scale from deployment work that is still required.

## Why the solve path is cheap

| Work | Location | Server cost |
|---|---|---|
| Editing and diff interaction | Browser | Static application assets |
| Python execution | Browser Pyodide Web Worker | None |
| Draft recovery | Browser `localStorage` | None |
| Loading a problem | Indexed database read | Low |
| Grading | Model call(s) + attempt write | Variable |
| Hint/Socratic turn | Streamed model call | Variable |
| Generation | Separate worker, once per bank asset | Amortized |

The web tier stores no live editor state and needs no session affinity. A candidate can run tests repeatedly without creating server work.

## Actual request path

```text
load problem      -> one DB read, hidden fields stripped
run tests         -> browser only
ask for hint      -> one Sonnet stream (optional)
submit debug      -> one Sonnet judgment + transaction
submit review     -> deterministic matcher + one Sonnet judgment + transaction
submit design     -> two Opus judgments + transaction
follow-up turn    -> one Opus stream (optional)
vote              -> one transactional upsert/tally update
```

Drafts are browser-local. Persisted attempts, grades, votes, generation jobs, and the shared bank live in the database.

## Bottlenecks in order

### 1. SQLite write concurrency

The checked-in datasource is SQLite for zero-setup development. That is not the multi-instance production database. Before public deployment:

1. Run `npm run db:postgres` on a branch.
2. Regenerate PostgreSQL migrations rather than reusing SQLite SQL.
3. Test worker claims, grading transactions, votes, and JD clearing under concurrency.
4. Use a pooled application URL and a direct migration URL.

The domain schema is portable by design, but the operational migration has not been completed merely because a rewrite script exists.

### 2. Per-process rate limits

`lib/ratelimit.ts` currently uses an in-memory `Map`. It is correct for local or one-instance deployments and ineffective across a fleet. The existing `Store.bump` boundary must be backed by Redis/KV before horizontal scaling. Generation's daily budget and interactive burst limits both need the shared store.

### 3. Model cost and capacity

Model calls are the principal marginal cost. Existing controls:

- Stable problem/key prefixes use prompt-cache breakpoints.
- Every call site has a deadline and explicit SDK retry budget.
- Only transient connection/408/409/429/5xx failures retry.
- Generation is rate-budgeted, queued, verified once, and reused.
- JD matching serves existing tagged problems before generating.
- Cancellation propagates to the provider for chat and grading.

At higher traffic, record per-call-site tokens, cache reads, latency, status, and retry count. Add grading backpressure before organization TPM limits become user-visible.

### 4. Bank ranking and pagination

The current endpoint loads the filtered set, computes Wilson scores in application code, sorts, and slices. This is reasonable for hundreds or low thousands of problems. Beyond that:

- Store `rankScore` on `Problem` and update it in the vote transaction.
- Add an index covering retirement, filters, rank, and id.
- Use cursor pagination instead of loading the full candidate set.
- Keep a new/problem exploration reserve so zero-vote items can earn signal.

### 5. Worker throughput

Generation jobs already live outside requests and support atomic claims, stale-claim recovery, retry backoff, and terminal JD deletion. PostgreSQL permits multiple workers to claim distinct jobs safely. Scale workers based on queue age and provider limits, not web traffic.

## Correctness under concurrency

- `timesAttempted`, `upvotes`, and `downvotes` use atomic increments.
- Votes are unique per `(problemId, sessionId)` and update through delta math.
- Attempt creation and `timesAttempted` increment share a transaction.
- Generation claims are atomic and stale claims are reclaimable.
- Retirement is a reversible flag rather than deletion.

## Verification strategy

- Deterministic unit and DB tests run on isolated SQLite.
- Provider-independent browser smoke runs on every push and PR.
- Live model E2E runs weekly/manual so provider/model drift is visible without making every commit slow or expensive.
- Production build verification runs before browser smoke in CI.

## Deployment checklist

- [ ] PostgreSQL migration tested under concurrent writers
- [ ] Pooled and direct database URLs configured
- [ ] Redis/KV rate-limit store installed
- [ ] `ANTHROPIC_API_KEY` configured as a secret
- [ ] Worker deployed with `python3` and graceful shutdown
- [ ] Weekly live E2E secret configured
- [ ] Structured provider/worker metrics and alerts installed
- [ ] Cursor pagination and stored rank added before large bank growth
