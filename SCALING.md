# Scaling Anvil

This document separates properties that already scale from deployment work that is still required.

## Why the solve path is cheap

| Work | Location | Server cost |
|---|---|---|
| Editing and diff interaction | Browser | Static application assets |
| Python execution | Browser Pyodide Web Worker | None |
| Draft recovery | Browser `localStorage` | None |
| Loading a problem | Indexed database read | Low |
| Grading | User-funded model call(s) + attempt write | Database write only |
| Hint/Socratic turn | User-funded streamed model call | Connection time only |
| Tailored generation on a bank miss | User-funded live request, once per bank asset | Amortized, but long-lived |
| Community contribution | User-funded intake and dedupe; generation only for a novel qualified idea | Metadata writes plus optional amortized asset |
| Operator batch generation | Separate worker, once per bank asset | Amortized |
| Sign-in | Two small writes plus one outbound email, per session start | Negligible |
| Interview mode | Browser clock; cues reuse the hint stream | None beyond the hint |
| Recorded demo (`/demo`) | One indexed read plus pure scoring — no model call | Low |

The web tier stores no live editor state and needs no session affinity. A candidate can run tests repeatedly without creating server work.

## Actual request path

```text
load problem      -> one DB read, hidden fields stripped
run tests         -> browser only
ask for hint      -> one efficient-tier provider stream (optional)
submit debug      -> one balanced-tier judgment + transaction
submit review     -> deterministic matcher + one balanced-tier judgment + transaction
submit design     -> two strongest-tier judgments + transaction
follow-up turn    -> one strongest-tier stream (optional)
vote              -> one transactional upsert/tally update
JD bank miss      -> streamed generation + oracle + one problem write
contribution      -> intake gate + shortlist/dedupe + optional generation oracle
```

Drafts are browser-local. BYOK credentials are encrypted in short-lived HttpOnly cookies and are not database records. Community source text is request-local; only derived contribution receipts and verified original exercises persist. Attempts, grades, votes, generation jobs, receipts, and the shared bank live in the database.

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

The sign-in email limit (five per address per hour) is the one whose per-process scope has an *external* cost: without a shared store, N web instances mean N times as many emails can be sent to one address, and the provider's reputation — not just Anvil's CPU — pays for it. Install the shared store before running more than one instance with mail configured.

### 3. Model cost and capacity

Interactive model calls are charged to each user's selected Anthropic or OpenAI API account. The operator Anthropic key is restricted to queued problem generation, maintenance scripts, and live CI. Existing controls:

- Stable problem/key prefixes use prompt-cache breakpoints.
- Every call site has a deadline and explicit SDK retry budget.
- Only transient connection/408/409/429/5xx failures retry.
- Generation is rate-budgeted, verified once, and reused. Operator batches are queued; a BYOK bank miss stays on one streamed request so the key is never persisted.
- JD matching serves an existing tagged problem first and generates only when none clears the relevance gate.
- Domain-specific JDs require at least one shared domain tag; an empty result creates a tailored problem instead of falling back to a random bank item.
- Cancellation propagates to the provider for chat and grading.
- User credentials expire after eight hours and never fall back to the operator key.
- OpenAI Responses API calls disable provider-side response storage with `store: false`.
- Public routes cannot enqueue operator-funded generation; the miss path uses only the connected user's provider.
- Community intake uses the connected user's provider, checks a bounded tag shortlist for duplicates, and runs generation only after privacy and quality thresholds pass.

At higher traffic, record per-call-site tokens, cache reads, latency, status, and retry count. Add grading backpressure before organization TPM limits become user-visible.

### 4. Bank ranking and pagination

The current endpoint loads the filtered set, computes Wilson scores in application code, sorts, and slices. This is reasonable for hundreds or low thousands of problems. Beyond that:

- Store `rankScore` on `Problem` and update it in the vote transaction.
- Add an index covering retirement, filters, rank, and id.
- Use cursor pagination instead of loading the full candidate set.
- Keep a new/problem exploration reserve so zero-vote items can earn signal.

### 5. Worker throughput

Generation jobs already live outside requests and support atomic claims, stale-claim recovery, retry backoff, and terminal JD deletion. PostgreSQL permits multiple workers to claim distinct jobs safely. Scale workers based on queue age and provider limits, not web traffic.

Request-scoped BYOK generation is intentionally different: keeping the key out of storage means keeping the HTTP stream and Node process alive through generation and verification. Deploy the web tier in a Python-capable container with an execution limit above the route's 800-second ceiling. Before moving this path to short-lived serverless functions, add an ephemeral credential broker whose encrypted payload has a strict TTL and is deleted on claim/completion; do not put plaintext keys in `GenerationJob`.

Community generation has the same long-request constraint. Intake and duplicate checks can complete without `python3`, but a novel accepted idea continues in the same request through the execution or rubric oracle so neither the key nor source needs durable job storage.

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
- [ ] `BYOK_ENCRYPTION_KEY` configured as a high-entropy web secret
- [ ] `AUTH_BASE_URL` set, so sign-in links cannot be built from a forged `Host`
- [ ] Mail transport configured (`RESEND_API_KEY` or `SMTP_URL`, plus `AUTH_EMAIL_FROM`) and verified with `npm run mail:test` — without one, production refuses to send sign-in links
- [ ] Shared rate-limit store installed before mail-configured horizontal scaling
- [ ] Expired `LoginToken` rows purged on a schedule (`purgeExpiredLoginTokens`)
- [ ] `ANTHROPIC_API_KEY` configured only for the worker/maintenance environment
- [ ] `GENERATION_ADMIN_TOKEN` configured if the enqueue API is deployed
- [ ] Web container includes `python3` and permits 800-second tailored-generation requests
- [ ] Worker deployed with `python3` and graceful shutdown
- [ ] Weekly live E2E secret configured (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`)
- [ ] Structured provider/worker metrics and alerts installed
- [ ] Cursor pagination and stored rank added before large bank growth
