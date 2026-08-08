# Scaling Anvil

The default setup is for local development or one application instance. A
public multi-instance deployment needs the upgrades below.

## Work placement

| Work | Location |
|---|---|
| Editing and diff review | Browser |
| Python execution | Browser Web Worker |
| Draft recovery | Browser local storage |
| Problem reads and attempts | Database |
| Grading and hints | User-funded provider call |
| Batch generation | Operator worker and provider key |

## Deployment constraints

### Database

The checked-in schema and migrations use SQLite. It is convenient locally but
not suitable for concurrent application and worker instances. Production should
use PostgreSQL with a tested migration history, pooled application URL, and
direct migration URL.

### Rate limiting

`lib/ratelimit.ts` uses process memory. Replace its store with Redis or another
shared atomic counter before running more than one instance.

### Long requests

Grading and tailored generation stream over SSE. The proxy and hosting platform
must support long-lived responses, cancellation, and the configured timeouts.

### Worker

The generation worker needs `python3`, an operator provider key, graceful
shutdown, and one shared database. Queue claims are atomic and stale claims can
be recovered.

### Bank size

Current filtering and ranking are adequate for a small bank. Add cursor
pagination and stored rank before the table becomes large.

## Concurrency guarantees

- Attempt creation and attempt-count updates share a transaction.
- Votes are unique per problem and owner; tallies use atomic deltas.
- Generation jobs are claimed atomically.
- Retirement is reversible and does not delete attempt history.
- Sign-in tokens are conditionally consumed once.

## Production checklist

- [ ] Test PostgreSQL migrations and rollback.
- [ ] Configure pooled and direct database URLs.
- [ ] Replace in-memory rate limiting.
- [ ] Set high-entropy `BYOK_ENCRYPTION_KEY` and `AUTH_SECRET` values.
- [ ] Set `AUTH_BASE_URL` and configure mail delivery.
- [ ] Keep `ANTHROPIC_API_KEY` out of the web request environment.
- [ ] Configure `GENERATION_ADMIN_TOKEN` if the enqueue API is enabled.
- [ ] Deploy the worker with `python3` and graceful shutdown.
- [ ] Schedule expired login-token cleanup.
- [ ] Configure deterministic CI and optional live E2E.
- [ ] Add structured logs, metrics, and alerts.
