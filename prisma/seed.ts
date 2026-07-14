/**
 * Hand-authored seed bank (spec §16). These are interview-grade problems, not
 * toys: realistic module-style code (classes, injected dependencies, docstrings),
 * 1–3 seeded flaws each, and test suites that jointly force ALL flaws to be
 * fixed — a partial fix still fails at least one test.
 *
 * Line numbers in every answerKey are 1-based against `starterCode` (debug) or
 * the new-file `lineNo` of the diff (review) — the coordinate system the editor
 * and diff viewer render and the grader matches against. If you edit any code
 * string here, re-verify the line numbers and re-run the oracle check.
 *
 * Run with: npm run seed
 */
import { PrismaClient } from "@prisma/client";
import type { AnswerKeyIssue, DiffHunk, PrMeta, TestSuite } from "../lib/types";

const prisma = new PrismaClient();

interface SeedProblem {
  type: "debug" | "review";
  difficulty: "easy" | "medium" | "hard";
  title: string;
  prompt: string;
  starterCode?: string;
  testSuite?: TestSuite;
  diff?: DiffHunk[];
  prMeta?: PrMeta;
  answerKey: AnswerKeyIssue[];
}

// ---------------------------------------------------------------------------
// DEBUG PROBLEMS — runnable, realistic, symptom-first prompts
// ---------------------------------------------------------------------------

const debugBatcher: SeedProblem = {
  type: "debug",
  difficulty: "medium",
  title: "Webhook batcher silently drops the tail of every flush",
  prompt:
    "Support keeps hearing about missing webhook deliveries. Metrics show flush() reports fewer events sent than were queued — and when the queue holds exactly one batch worth, nothing goes out at all. No errors are logged. Find the root cause and make the suite green.",
  starterCode: `MAX_BATCH = 8

class WebhookBatcher:
    """Collects webhook events and posts them downstream in fixed-size batches."""

    def __init__(self, transport, batch_size=MAX_BATCH):
        self.transport = transport
        self.batch_size = batch_size
        self.pending = []
        self.delivered = 0

    def add(self, event):
        if not isinstance(event, dict) or "id" not in event:
            raise ValueError("event must be a dict with an 'id'")
        self.pending.append(event)

    def flush(self):
        """Dispatch every pending event downstream. Returns how many were sent."""
        sent = 0
        i = 0
        while i < len(self.pending) - self.batch_size:
            chunk = self.pending[i:i + self.batch_size]
            self.transport.send(chunk)
            sent += len(chunk)
            i += self.batch_size
        self.pending = self.pending[i:]
        self.delivered += sent
        return sent`,
  testSuite: {
    setup: `class FakeTransport:
    def __init__(self):
        self.batches = []
    def send(self, chunk):
        self.batches.append(list(chunk))

def make(batch_size=8):
    t = FakeTransport()
    return WebhookBatcher(t, batch_size), t

def ev(i):
    return {"id": i}`,
    cases: [
      { name: "test_flush_empty_queue", body: `b, t = make()\nassert b.flush() == 0\nassert t.batches == []` },
      {
        name: "test_flush_exact_batch",
        body: `b, t = make(4)\nfor i in range(4):\n    b.add(ev(i))\nassert b.flush() == 4, "an exact batch worth of events must be dispatched"\nassert b.pending == []`,
      },
      {
        name: "test_flush_partial_tail",
        body: `b, t = make(4)\nfor i in range(10):\n    b.add(ev(i))\nassert b.flush() == 10, "every queued event must go out, including the partial tail"\nassert b.pending == []\nassert sum(len(c) for c in t.batches) == 10`,
      },
      {
        name: "test_add_validates_events",
        body: `b, t = make()\ntry:\n    b.add("not-an-event")\n    assert False, "expected ValueError"\nexcept ValueError:\n    pass`,
      },
    ],
  },
  answerKey: [
    {
      id: "flush-boundary",
      lineStart: 21,
      lineEnd: 21,
      severity: "major",
      failure:
        "The flush loop exits one full batch early, so the final window — including an exact final batch — is never dispatched and lingers in `pending`.",
      explanation:
        "`while i < len(self.pending) - self.batch_size` stops before the last window. It must be `while i < len(self.pending)`: the slice `pending[i:i+batch_size]` already handles a short tail safely.",
      keywords: ["off by one", "boundary", "loop condition", "- self.batch_size", "last batch", "tail", "len(self.pending)"],
    },
  ],
};

const debugTokenBucket: SeedProblem = {
  type: "debug",
  difficulty: "hard",
  title: "Rate limiter lets huge bursts through after idle periods",
  prompt:
    "Two symptoms from prod: (1) after a quiet night, a single client burned through hundreds of requests in one burst even though capacity is 5; (2) a fresh bucket denies the very last token it should grant — clients report being limited one request early. The clock is injected, so everything is deterministic. Make the suite green.",
  starterCode: `class TokenBucket:
    """Allows \`rate\` requests/second with bursts up to \`capacity\`.

    \`clock\` is injected for testability (returns seconds as a float).
    """

    def __init__(self, rate, capacity, clock):
        self.rate = rate
        self.capacity = capacity
        self.clock = clock
        self.tokens = capacity
        self.last_refill = clock()

    def _refill(self):
        now = self.clock()
        elapsed = now - self.last_refill
        self.tokens = self.tokens + elapsed * self.rate
        self.last_refill = now

    def allow(self):
        """Consume one token if available."""
        self._refill()
        if self.tokens > 1:
            self.tokens -= 1
            return True
        return False`,
  testSuite: {
    setup: `def make(rate=1, capacity=5):
    t = {"now": 0.0}
    def clock():
        return t["now"]
    def advance(sec):
        t["now"] += sec
    return TokenBucket(rate, capacity, clock), advance`,
    cases: [
      {
        name: "test_full_burst_at_start",
        body: `b, advance = make(rate=1, capacity=5)\ngrants = sum(1 for _ in range(6) if b.allow())\nassert grants == 5, f"a fresh bucket must grant exactly its capacity, granted {grants}"`,
      },
      {
        name: "test_last_token_is_usable",
        body: `b, advance = make(rate=1, capacity=1)\nassert b.allow() is True, "the last remaining token must be grantable"\nassert b.allow() is False`,
      },
      {
        name: "test_refill_over_time",
        body: `b, advance = make(rate=1, capacity=1)\nb.allow()\nassert b.allow() is False\nadvance(1.0)\nassert b.allow() is True, "one second at rate=1 should refill one token"`,
      },
      {
        name: "test_idle_never_exceeds_capacity",
        body: `b, advance = make(rate=1, capacity=5)\nfor _ in range(6):\n    b.allow()\nadvance(3600.0)\ngrants = sum(1 for _ in range(20) if b.allow())\nassert grants == 5, f"after an hour idle the burst must still cap at capacity=5, granted {grants}"`,
      },
    ],
  },
  answerKey: [
    {
      id: "refill-uncapped",
      lineStart: 17,
      lineEnd: 17,
      severity: "critical",
      failure:
        "Refill accumulates without capping at capacity, so after an idle period the bucket holds far more than `capacity` tokens and a client can burst way past the limit.",
      explanation:
        "`self.tokens = self.tokens + elapsed * self.rate` must clamp: `min(self.capacity, ...)`. The whole point of the bucket is that idle time can never bank more than one full burst.",
      keywords: ["cap", "capacity", "min(", "clamp", "unbounded", "idle", "burst", "exceeds"],
    },
    {
      id: "allow-off-by-one",
      lineStart: 23,
      lineEnd: 23,
      severity: "major",
      failure: "`if self.tokens > 1` refuses to spend the final token — every bucket effectively has capacity−1.",
      explanation: "Spending one token requires `tokens >= 1`, not `> 1`. The strict comparison strands the last token forever.",
      keywords: [">=", "off by one", "last token", "strict", "comparison", "tokens > 1"],
    },
  ],
};

const debugLruCache: SeedProblem = {
  type: "debug",
  difficulty: "medium",
  title: "LRU cache evicts the entry you just used",
  prompt:
    "Cache hit-rate collapsed after a refactor. Traces show hot keys being evicted moments after they were read, while entries nobody has touched in hours stay resident. Two distinct things are wrong with the recency bookkeeping. Make the suite green.",
  starterCode: `class LRUCache:
    """Fixed-capacity cache that evicts the least-recently-used entry."""

    def __init__(self, capacity):
        self.capacity = capacity
        self.store = {}
        self.order = []  # least-recently-used first

    def get(self, key):
        if key not in self.store:
            return None
        return self.store[key]

    def put(self, key, value):
        if key in self.store:
            self.store[key] = value
            self.order.remove(key)
            self.order.append(key)
            return
        if len(self.store) >= self.capacity:
            evicted = self.order.pop()
            del self.store[evicted]
        self.store[key] = value
        self.order.append(key)`,
  testSuite: {
    cases: [
      {
        name: "test_basic_roundtrip",
        body: `c = LRUCache(2)\nc.put("a", 1)\nassert c.get("a") == 1\nassert c.get("missing") is None`,
      },
      {
        name: "test_evicts_least_recent",
        body: `c = LRUCache(2)\nc.put("a", 1)\nc.put("b", 2)\nc.put("c", 3)\nassert c.get("a") is None, "oldest entry (a) should be evicted"\nassert c.get("b") == 2, "newer entry (b) must survive"\nassert c.get("c") == 3`,
      },
      {
        name: "test_get_refreshes_recency",
        body: `c = LRUCache(2)\nc.put("a", 1)\nc.put("b", 2)\nc.get("a")\nc.put("c", 3)\nassert c.get("a") == 1, "a was just read - it must not be the eviction victim"\nassert c.get("b") is None, "b was the least recently used"`,
      },
      {
        name: "test_update_refreshes_recency",
        body: `c = LRUCache(2)\nc.put("a", 1)\nc.put("b", 2)\nc.put("a", 10)\nc.put("c", 3)\nassert c.get("a") == 10\nassert c.get("b") is None`,
      },
    ],
  },
  answerKey: [
    {
      id: "get-no-refresh",
      lineStart: 12,
      lineEnd: 12,
      severity: "major",
      failure: "get() returns the value without refreshing recency, so hot keys look stale and get evicted while cold keys survive.",
      explanation:
        "An LRU read is a *use*: get() must move the key to the most-recent end (`order.remove(key); order.append(key)`) before returning. Without it the order list only reflects writes.",
      keywords: ["refresh", "recency", "move", "order", "get", "touch", "most recent"],
    },
    {
      id: "evict-wrong-end",
      lineStart: 21,
      lineEnd: 21,
      severity: "major",
      failure: "`self.order.pop()` removes the MOST-recently-used key — eviction targets exactly the wrong end of the list.",
      explanation:
        "`order` is least-recent-first, so eviction must `pop(0)`. A bare `pop()` takes the newest entry, which is why fresh keys vanish immediately.",
      keywords: ["pop(0)", "wrong end", "most recent", "pop()", "evict", "oldest", "front"],
    },
  ],
};

const debugInvoice: SeedProblem = {
  type: "debug",
  difficulty: "easy",
  title: "Invoice totals ignore line-item quantities",
  prompt:
    "Finance flagged that multi-quantity orders are being under-billed: an order of 3 × $2.50 invoices at $2.50. Single-item orders and the discount math look right in spot checks. All amounts are integer cents. Make the suite green.",
  starterCode: `def invoice_total(items, discount_pct=0):
    """Total (in cents) for a list of {'price': cents, 'qty': int} line items,
    with an optional whole-order percentage discount applied at the end."""
    subtotal = 0
    for item in items:
        subtotal += item["price"]
    discounted = subtotal - subtotal * discount_pct / 100
    return round(discounted)`,
  testSuite: {
    cases: [
      { name: "test_empty_invoice", body: `assert invoice_total([]) == 0` },
      {
        name: "test_quantities_multiply",
        body: `assert invoice_total([{"price": 250, "qty": 3}]) == 750, "3 x 250c must bill 750c"`,
      },
      {
        name: "test_discount_applies_to_full_subtotal",
        body: `assert invoice_total([{"price": 1000, "qty": 2}], discount_pct=10) == 1800`,
      },
      {
        name: "test_mixed_lines",
        body: `items = [{"price": 199, "qty": 2}, {"price": 500, "qty": 1}]\nassert invoice_total(items) == 898`,
      },
    ],
  },
  answerKey: [
    {
      id: "qty-ignored",
      lineStart: 6,
      lineEnd: 6,
      severity: "major",
      failure: "The subtotal adds each line's unit price once, ignoring `qty` — every multi-quantity line is under-billed.",
      explanation: "The accumulation must be `subtotal += item[\"price\"] * item[\"qty\"]`. As written, quantity is read from the schema but never used.",
      keywords: ["qty", "quantity", "multiply", "* item", "unit price", "ignores"],
    },
  ],
};

const debugRetry: SeedProblem = {
  type: "debug",
  difficulty: "medium",
  title: "Retry helper swallows real bugs and returns None",
  prompt:
    "Two incidents traced back to this helper: a typo (`ValueError`) in a caller got retried three times before vanishing — the on-call saw nothing; and when a downstream stayed hard-down, callers received `None` instead of an exception and happily wrote `None` into the database. The docstring says exactly what it should do. Make the suite green.",
  starterCode: `def with_retry(fn, attempts=3, retry_on=(ConnectionError, TimeoutError)):
    """Call \`fn\`, retrying transient failures up to \`attempts\` times.

    Only exceptions in \`retry_on\` are transient; anything else is a bug in the
    caller and must propagate immediately. If every attempt fails, the last
    transient error must surface — never a silent None.
    """
    last_exc = None
    for _ in range(attempts):
        try:
            return fn()
        except Exception as exc:
            last_exc = exc
    return None`,
  testSuite: {
    setup: `def flaky(fail_times, exc_type=ConnectionError):
    state = {"calls": 0}
    def fn():
        state["calls"] += 1
        if state["calls"] <= fail_times:
            raise exc_type("transient failure")
        return "ok"
    fn.state = state
    return fn`,
    cases: [
      { name: "test_success_passthrough", body: `fn = flaky(0)\nassert with_retry(fn) == "ok"\nassert fn.state["calls"] == 1` },
      {
        name: "test_retries_transient_errors",
        body: `fn = flaky(2)\nassert with_retry(fn) == "ok"\nassert fn.state["calls"] == 3, "two transient failures then success = 3 calls"`,
      },
      {
        name: "test_programmer_errors_propagate_immediately",
        body: `fn = flaky(5, ValueError)\ntry:\n    with_retry(fn)\n    assert False, "ValueError is not transient - it must propagate"\nexcept ValueError:\n    pass\nassert fn.state["calls"] == 1, f"a non-transient error was retried ({fn.state['calls']} calls)"`,
      },
      {
        name: "test_exhausted_retries_raise",
        body: `fn = flaky(99)\ntry:\n    with_retry(fn)\n    assert False, "exhausted retries must raise the last error, not return None"\nexcept ConnectionError:\n    pass\nassert fn.state["calls"] == 3`,
      },
    ],
  },
  answerKey: [
    {
      id: "broad-except",
      lineStart: 12,
      lineEnd: 12,
      severity: "major",
      failure: "`except Exception` retries every error type — programmer errors like ValueError get retried and hidden instead of propagating immediately.",
      explanation: "The handler must catch only the transient classes: `except retry_on as exc:`. The `retry_on` parameter exists precisely for this and is currently ignored.",
      keywords: ["except exception", "retry_on", "broad", "catch", "propagate", "transient", "valueerror"],
    },
    {
      id: "silent-none",
      lineStart: 14,
      lineEnd: 14,
      severity: "critical",
      failure: "After exhausting attempts the helper returns None, so hard failures masquerade as a successful call returning None — corrupting callers' data.",
      explanation: "Exhaustion must re-raise the captured error: `raise last_exc`. A retry wrapper may delay an error; it must never convert one into a value.",
      keywords: ["return none", "raise", "last_exc", "swallow", "silent", "exhaust"],
    },
  ],
};

const debugPayments: SeedProblem = {
  type: "debug",
  difficulty: "hard",
  title: "Payment processor double-charges on webhook replay",
  prompt:
    "A customer was charged twice for one order. The provider's docs say delivery is at-least-once: the same event WILL occasionally arrive twice, and a delivery attempt can also die mid-flight and be redelivered. There's a `processed` set in the code, so someone thought about this — but chargebacks say otherwise. There are two distinct flaws in how idempotency is handled. Make the suite green.",
  starterCode: `class PaymentProcessor:
    """Applies \`charge\` webhooks from the payment provider to the gateway.

    Delivery is at-least-once: the same event may arrive multiple times
    (replays, provider retries), and a delivery attempt can fail midway.
    """

    def __init__(self, gateway):
        self.gateway = gateway
        self.processed = set()

    def handle(self, event):
        eid = event["id"]
        if event.get("type") != "charge":
            return "ignored"
        self.processed.add(eid)
        result = self.gateway.charge(event["customer"], event["amount"])
        return result`,
  testSuite: {
    setup: `class FakeGateway:
    def __init__(self, fail_first=0):
        self.charges = []
        self.fail_remaining = fail_first
    def charge(self, customer, amount):
        if self.fail_remaining > 0:
            self.fail_remaining -= 1
            raise ConnectionError("gateway unavailable")
        self.charges.append((customer, amount))
        return "charged"

def charge_event(eid, amount=1000):
    return {"id": eid, "type": "charge", "customer": "cus_1", "amount": amount}`,
    cases: [
      {
        name: "test_charges_once",
        body: `gw = FakeGateway()\np = PaymentProcessor(gw)\nassert p.handle(charge_event("evt_1")) == "charged"\nassert len(gw.charges) == 1`,
      },
      {
        name: "test_ignores_non_charge_events",
        body: `gw = FakeGateway()\np = PaymentProcessor(gw)\nassert p.handle({"id": "evt_2", "type": "refund"}) == "ignored"\nassert gw.charges == []`,
      },
      {
        name: "test_replay_is_idempotent",
        body: `gw = FakeGateway()\np = PaymentProcessor(gw)\ne = charge_event("evt_3")\np.handle(e)\np.handle(e)\nassert len(gw.charges) == 1, f"replayed event charged {len(gw.charges)} times - customers get double-charged"`,
      },
      {
        name: "test_failed_delivery_is_retryable",
        body: `gw = FakeGateway(fail_first=1)\np = PaymentProcessor(gw)\ne = charge_event("evt_4")\ntry:\n    p.handle(e)\n    assert False, "the gateway error should propagate so the provider redelivers"\nexcept ConnectionError:\n    pass\nassert p.handle(e) == "charged", "a failed delivery must remain retryable - money was never moved"\nassert len(gw.charges) == 1`,
      },
    ],
  },
  answerKey: [
    {
      id: "no-replay-guard",
      lineStart: 13,
      lineEnd: 17,
      severity: "critical",
      failure: "`processed` is written but never READ — replays sail straight through to the gateway and the customer is charged once per delivery.",
      explanation:
        "handle() needs a guard before charging: `if eid in self.processed: return \"duplicate\"`. Recording processed IDs is worthless if nothing checks them.",
      keywords: ["never checked", "duplicate", "replay", "idempotency", "in self.processed", "guard", "double charge"],
    },
    {
      id: "mark-before-charge",
      lineStart: 16,
      lineEnd: 16,
      severity: "major",
      failure:
        "The event is marked processed BEFORE the charge attempt — if the gateway call fails, the event is permanently 'processed' and the redelivery will be skipped: the customer is never charged at all.",
      explanation:
        "Mark idempotency state only after the side effect succeeds: charge first, then `processed.add(eid)`. Marking first turns any transient gateway failure into silently lost revenue.",
      keywords: ["before", "order", "after success", "mark", "add(eid)", "failed charge", "lost"],
    },
  ],
};

// ---------------------------------------------------------------------------
// REVIEW PROBLEMS — plausible AI-generated PRs with seeded flaws
// ---------------------------------------------------------------------------

const ctx = (lineNo: number, content: string): DiffHunk["lines"][number] => ({ kind: "context", lineNo, content });
const add = (lineNo: number, content: string): DiffHunk["lines"][number] => ({ kind: "add", lineNo, content });
const del = (content: string): DiffHunk["lines"][number] => ({ kind: "del", lineNo: null, content });

const reviewRetry: SeedProblem = {
  type: "review",
  difficulty: "medium",
  title: "Add retry logic to payment webhook",
  prompt:
    "We've been losing payment confirmations during brief ledger-service blips. This adds automatic retries around the ledger write so transient outages stop dropping money events. Tested locally by killing the ledger container mid-run — confirmations were delivered once it came back. Low-risk change, isolated to the handler.",
  prMeta: { number: 4192, branch: "feat/webhook-retries", additions: 6, deletions: 1, files: 1, aiGenerated: true },
  diff: [
    {
      file: "services/payments/webhook.py",
      lines: [
        ctx(36, "import time"),
        ctx(37, ""),
        ctx(38, "def handle(event):"),
        ctx(39, '    """Apply a payment confirmation from the provider to our ledger."""'),
        ctx(40, "    payload = verify(event)          # raises SignatureError on tampered events"),
        ctx(41, '    log.info("webhook received", event_id=payload["id"])'),
        del("    ledger.record(payload)"),
        add(42, "    while True:"),
        add(43, "        try:"),
        add(44, "            ledger.record(payload)"),
        add(45, "            break"),
        add(46, "        except Exception:"),
        add(47, "            time.sleep(1)"),
        ctx(48, "    return ok()"),
      ],
    },
  ],
  answerKey: [
    {
      id: "unbounded-retry",
      lineStart: 42,
      lineEnd: 42,
      severity: "major",
      failure: "`while True` with no attempt cap or backoff blocks the worker forever during a sustained ledger outage — one bad event wedges the whole webhook queue.",
      explanation:
        "Retries need a bounded attempt count and exponential backoff, then a dead-letter path. An unbounded tight loop also ignores the webhook's own delivery timeout — the provider will redeliver while we're still spinning.",
      keywords: ["while true", "unbounded", "max attempts", "retry forever", "cap", "backoff", "no limit", "blocks"],
    },
    {
      id: "no-idempotency",
      lineStart: 44,
      lineEnd: 44,
      severity: "critical",
      failure: "Retrying `ledger.record()` with no idempotency key double-books the payment when the first write succeeded but its ack was lost.",
      explanation:
        "Success-then-lost-ack is the classic partial failure: the retry records the same payment again. The write needs a stable idempotency key (the event id) so the ledger dedupes. This is the flaw that actually loses money.",
      keywords: ["idempotency", "idempotent", "double charge", "double-book", "duplicate", "dedupe", "exactly once", "at least once", "ack"],
    },
    {
      id: "broad-except",
      lineStart: 46,
      lineEnd: 46,
      severity: "minor",
      failure: "`except Exception` retries programming errors (a KeyError in the payload, a bug in record()) identically to outages — hiding real bugs in an infinite retry loop.",
      explanation: "Catch the specific transient/network error class the ledger client raises. Everything else should propagate loudly.",
      keywords: ["except exception", "broad except", "bare except", "swallow", "too broad", "specific exception", "keyerror"],
    },
  ],
};

const reviewCache: SeedProblem = {
  type: "review",
  difficulty: "medium",
  title: "Cache user lookups to cut database load",
  prompt:
    "get_user is our hottest DB query (60% of read QPS) and users barely change. This memoizes lookups in-process — repeat reads are served from memory and writes keep going straight through to the DB, so there's no consistency risk. Saw a 40x latency win on the benchmark.",
  prMeta: { number: 5310, branch: "perf/user-cache", additions: 5, deletions: 1, files: 1, aiGenerated: true },
  diff: [
    {
      file: "services/users/cache.py",
      lines: [
        ctx(8, "from services.users import db"),
        ctx(9, ""),
        ctx(10, "_cache = {}"),
        ctx(11, ""),
        ctx(12, "def get_user(user_id):"),
        del("    return db.fetch_user(user_id)"),
        add(13, "    if user_id in _cache:"),
        add(14, "        return _cache[user_id]"),
        add(15, "    user = db.fetch_user(user_id)"),
        add(16, "    _cache[user_id] = user"),
        add(17, "    return user"),
        ctx(18, ""),
        ctx(19, "def update_user(user_id, data):"),
        ctx(20, "    db.save_user(user_id, data)"),
        ctx(21, ""),
        ctx(22, "def delete_user(user_id):"),
        ctx(23, "    db.remove_user(user_id)"),
      ],
    },
  ],
  answerKey: [
    {
      id: "stale-cache",
      lineStart: 19,
      lineEnd: 23,
      severity: "critical",
      failure:
        "update_user and delete_user write straight to the DB but never invalidate `_cache` — readers keep getting the old user (or a deleted one) indefinitely. The PR claim of 'no consistency risk' is exactly backwards.",
      explanation:
        "Every write path must evict the entry (`_cache.pop(user_id, None)`). Deleted users continuing to resolve is also a security problem, not just staleness.",
      keywords: ["invalidate", "stale", "cache invalidation", "evict", "update", "delete", "pop", "consistency"],
    },
    {
      id: "unbounded-cache",
      lineStart: 16,
      lineEnd: 16,
      severity: "major",
      failure: "`_cache` grows forever — no max size, TTL, or eviction. Every user ever read stays resident until the process OOMs.",
      explanation: "An in-process cache needs a bound: LRU with a max size or a TTL (e.g. functools.lru_cache or a bounded dict). Unbounded growth is a slow-motion memory leak.",
      keywords: ["unbounded", "memory leak", "eviction", "ttl", "max size", "lru", "grows", "bounded", "oom"],
    },
    {
      id: "shared-mutable",
      lineStart: 14,
      lineEnd: 14,
      severity: "minor",
      failure: "The cache hands every caller the same mutable dict — one caller mutating its 'copy' silently corrupts what every future caller reads.",
      explanation: "Return a copy (or an immutable view) from the cache, or document the aliasing loudly. Shared mutable cache entries are a classic action-at-a-distance bug.",
      keywords: ["mutable", "copy", "reference", "mutation", "aliasing", "shared object", "deepcopy"],
    },
  ],
};

const reviewPagination: SeedProblem = {
  type: "review",
  difficulty: "hard",
  title: "Add pagination to the orders endpoint",
  prompt:
    "The orders list endpoint currently returns a user's entire history in one response, which is timing out for power users with 10k+ orders. This adds standard limit/offset pagination plus a total count so the frontend can render page controls. Backwards compatible — page defaults keep old clients working.",
  prMeta: { number: 5817, branch: "feat/orders-pagination", additions: 7, deletions: 2, files: 1, aiGenerated: true },
  diff: [
    {
      file: "api/orders.py",
      lines: [
        ctx(12, "PER_PAGE_DEFAULT = 50"),
        ctx(13, ""),
        ctx(14, "def list_orders(user_id, page=1, per_page=PER_PAGE_DEFAULT):"),
        ctx(15, '    """Return one page of a user\'s orders, newest first."""'),
        del('    rows = db.query("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC", user_id)'),
        del('    return {"orders": rows}'),
        add(16, "    offset = page * per_page"),
        add(17, "    rows = db.execute("),
        add(18, '        f"SELECT * FROM orders WHERE user_id = {user_id} "'),
        add(19, '        f"ORDER BY created_at DESC LIMIT {per_page} OFFSET {offset}"'),
        add(20, "    )"),
        add(21, '    total = len(db.execute(f"SELECT * FROM orders WHERE user_id = {user_id}"))'),
        add(22, '    return {"orders": rows, "total": total, "page": page}'),
      ],
    },
  ],
  answerKey: [
    {
      id: "sql-injection",
      lineStart: 18,
      lineEnd: 19,
      severity: "critical",
      failure:
        "user_id is interpolated into the SQL with an f-string — a crafted user_id walks straight into the query. The deleted code used bind parameters; this PR silently removed them.",
      explanation:
        "Use parameterized queries (`?` placeholders / bind params) for every value, including LIMIT/OFFSET. The regression is easy to miss because the diff *looks* like a mechanical rewrite.",
      keywords: ["injection", "sql injection", "parameterized", "f-string", "bind", "placeholder", "sanitize", "escape"],
    },
    {
      id: "offset-off-by-one",
      lineStart: 16,
      lineEnd: 16,
      severity: "major",
      failure: "`offset = page * per_page` with 1-based pages skips the first page entirely — page 1 starts at row 50 and the newest 50 orders are unreachable.",
      explanation: "With 1-based page numbers the offset is `(page - 1) * per_page`. As written, no page value can ever return rows 0–49.",
      keywords: ["off by one", "page - 1", "first page", "skips", "offset", "1-based"],
    },
    {
      id: "count-loads-table",
      lineStart: 21,
      lineEnd: 21,
      severity: "major",
      failure:
        "The total is computed by SELECTing every order row and len()-ing it in Python — the exact full-table scan this PR exists to eliminate, now on every page request.",
      explanation: "Use `SELECT COUNT(*)` (and consider caching it). Fetching all rows for a count re-introduces the 10k-row timeout behind a feature that claims to fix it.",
      keywords: ["count(*)", "select count", "loads every", "full table", "len(", "performance", "scan"],
    },
  ],
};

const ALL: SeedProblem[] = [
  debugBatcher,
  debugTokenBucket,
  debugLruCache,
  debugInvoice,
  debugRetry,
  debugPayments,
  reviewRetry,
  reviewCache,
  reviewPagination,
];

async function main() {
  // Idempotent: replace previously-authored problems (cascades to their attempts).
  await prisma.problem.deleteMany({ where: { source: "authored" } });

  for (const p of ALL) {
    await prisma.problem.create({
      data: {
        type: p.type,
        language: "python",
        difficulty: p.difficulty,
        title: p.title,
        prompt: p.prompt,
        starterCode: p.starterCode ?? null,
        testSuite: (p.testSuite ?? undefined) as object | undefined,
        diff: (p.diff ?? undefined) as object | undefined,
        prMeta: (p.prMeta ?? undefined) as object | undefined,
        answerKey: p.answerKey as unknown as object,
        source: "authored",
      },
    });
  }

  const count = await prisma.problem.count();
  console.log(`Seeded ${ALL.length} authored problems. Bank now holds ${count}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
