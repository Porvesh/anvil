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
import { Prisma, PrismaClient } from "@prisma/client";
import type { AnswerKeyIssue, DiffHunk, PrMeta, SolutionFile, TestSuite } from "../lib/types";
import type { Tag } from "../lib/tags";

const prisma = new PrismaClient();

interface SeedProblem {
  type: "debug" | "review" | "design";
  difficulty: "easy" | "medium" | "hard";
  title: string;
  tags: Tag[];
  prompt: string;
  starterCode?: string; // design: the doc scaffold. debug uses `files`.
  files?: SolutionFile[]; // debug: the multi-file project the user edits
  testSuite?: TestSuite;
  diff?: DiffHunk[];
  prMeta?: PrMeta;
  answerKey: AnswerKeyIssue[];
}

// Concise multi-file helper: build a package from {path: content} entries.
const F = (path: string, content: string, readOnly = false): SolutionFile => ({ path, content, readOnly });

// ---------------------------------------------------------------------------
// DEBUG PROBLEMS — runnable, realistic, symptom-first prompts
// ---------------------------------------------------------------------------

const debugBatcher: SeedProblem = {
  type: "debug",
  difficulty: "medium",
  title: "Webhook batcher silently drops the tail of every flush",
  tags: ["webhooks", "error-handling", "edge-cases", "queueing", "observability"],
  prompt:
    "Support keeps hearing about missing webhook deliveries. Metrics show flush() reports fewer events sent than were queued — and when the queue holds exactly one batch worth, nothing goes out at all. No errors are logged. Find the root cause and make the suite green.",
  files: [
    F("webhooks/__init__.py", `from .batcher import WebhookBatcher, MAX_BATCH\n`),
    F(
      "webhooks/transport.py",
      `"""Downstream transport interface (do not edit — this is the contract)."""


class Transport:
    def send(self, chunk):
        """Deliver one batch of events downstream."""
        raise NotImplementedError
`,
      true,
    ),
    F(
      "webhooks/batcher.py",
      `from .transport import Transport

MAX_BATCH = 8


class WebhookBatcher:
    """Collects webhook events and posts them downstream in fixed-size batches."""

    def __init__(self, transport: Transport, batch_size=MAX_BATCH):
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
        return sent
`,
    ),
  ],
  testSuite: {
    setup: `from webhooks import WebhookBatcher
from webhooks.transport import Transport

class FakeTransport(Transport):
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
      file: "webhooks/batcher.py",
      lineStart: 22,
      lineEnd: 22,
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
  tags: ["rate-limiting", "state-management", "edge-cases"],
  prompt:
    "Two symptoms from prod: (1) after a quiet night, a single client burned through hundreds of requests in one burst even though capacity is 5; (2) a fresh bucket denies the very last token it should grant — clients report being limited one request early. The clock is injected, so everything is deterministic. Make the suite green.",
  files: [
    F("ratelimit/__init__.py", `from .bucket import TokenBucket\n`),
    F(
      "ratelimit/clock.py",
      `"""Default wall-clock source (do not edit)."""
import time


def monotonic() -> float:
    """Seconds from a monotonic source; injected clocks override this in tests."""
    return time.monotonic()
`,
      true,
    ),
    F(
      "ratelimit/bucket.py",
      `from .clock import monotonic


class TokenBucket:
    """Allows \`rate\` requests/second with bursts up to \`capacity\`.

    \`clock\` is injected for testability (returns seconds as a float); it
    defaults to the real monotonic clock in production.
    """

    def __init__(self, rate, capacity, clock=None):
        self.rate = rate
        self.capacity = capacity
        self.clock = clock or monotonic
        self.tokens = capacity
        self.last_refill = self.clock()

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
        return False
`,
    ),
  ],
  testSuite: {
    setup: `from ratelimit import TokenBucket

def make(rate=1, capacity=5):
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
      file: "ratelimit/bucket.py",
      lineStart: 19,
      lineEnd: 19,
      severity: "critical",
      failure:
        "Refill accumulates without capping at capacity, so after an idle period the bucket holds far more than `capacity` tokens and a client can burst way past the limit.",
      explanation:
        "`self.tokens = self.tokens + elapsed * self.rate` must clamp: `min(self.capacity, ...)`. The whole point of the bucket is that idle time can never bank more than one full burst.",
      keywords: ["cap", "capacity", "min(", "clamp", "unbounded", "idle", "burst", "exceeds"],
    },
    {
      id: "allow-off-by-one",
      file: "ratelimit/bucket.py",
      lineStart: 27,
      lineEnd: 27,
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
  tags: ["caching", "state-management", "edge-cases"],
  prompt:
    "Cache hit-rate collapsed after a refactor. Traces show hot keys being evicted moments after they were read, while entries nobody has touched in hours stay resident. Two distinct things are wrong with the recency bookkeeping. Make the suite green.",
  files: [
    F("cache/__init__.py", `from .lru import LRUCache\n`),
    F(
      "cache/policy.py",
      `"""Cache sizing policy (do not edit)."""

DEFAULT_CAPACITY = 128
`,
      true,
    ),
    F(
      "cache/lru.py",
      `from .policy import DEFAULT_CAPACITY


class LRUCache:
    """Fixed-capacity cache that evicts the least-recently-used entry."""

    def __init__(self, capacity=DEFAULT_CAPACITY):
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
        self.order.append(key)
`,
    ),
  ],
  testSuite: {
    setup: `from cache import LRUCache`,
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
      file: "cache/lru.py",
      lineStart: 14,
      lineEnd: 14,
      severity: "major",
      failure: "get() returns the value without refreshing recency, so hot keys look stale and get evicted while cold keys survive.",
      explanation:
        "An LRU read is a *use*: get() must move the key to the most-recent end (`order.remove(key); order.append(key)`) before returning. Without it the order list only reflects writes.",
      keywords: ["refresh", "recency", "move", "order", "get", "touch", "most recent"],
    },
    {
      id: "evict-wrong-end",
      file: "cache/lru.py",
      lineStart: 23,
      lineEnd: 23,
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
  tags: ["validation", "data-modeling", "edge-cases", "error-handling"],
  prompt:
    "Finance flagged that multi-quantity orders are being under-billed: an order of 3 × $2.50 invoices at $2.50. Single-item orders and the discount math look right in spot checks. All amounts are integer cents. Make the suite green.",
  files: [
    F("billing/__init__.py", `from .invoice import invoice_total\n`),
    F(
      "billing/models.py",
      `"""Line-item schema (do not edit)."""
from typing import TypedDict


class LineItem(TypedDict):
    price: int  # unit price in integer cents
    qty: int
`,
      true,
    ),
    F(
      "billing/invoice.py",
      `from .models import LineItem


def invoice_total(items: list[LineItem], discount_pct: int = 0) -> int:
    """Total (in cents) for a list of line items, with an optional whole-order
    percentage discount applied at the end."""
    subtotal = 0
    for item in items:
        subtotal += item["price"]
    discounted = subtotal - subtotal * discount_pct / 100
    return round(discounted)
`,
    ),
  ],
  testSuite: {
    setup: `from billing import invoice_total`,
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
      file: "billing/invoice.py",
      lineStart: 9,
      lineEnd: 9,
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
  tags: ["retry", "error-handling", "state-management"],
  prompt:
    "Two incidents traced back to this helper: a typo (`ValueError`) in a caller got retried three times before vanishing — the on-call saw nothing; and when a downstream stayed hard-down, callers received `None` instead of an exception and happily wrote `None` into the database. The docstring says exactly what it should do. Make the suite green.",
  files: [
    F("resilience/__init__.py", `from .retry import with_retry\n`),
    F(
      "resilience/errors.py",
      `"""Which failures are considered transient (do not edit)."""

# Network-ish failures worth retrying; everything else is a caller bug.
TRANSIENT = (ConnectionError, TimeoutError)
`,
      true,
    ),
    F(
      "resilience/retry.py",
      `from .errors import TRANSIENT


def with_retry(fn, attempts=3, retry_on=TRANSIENT):
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
    return None
`,
    ),
  ],
  testSuite: {
    setup: `from resilience import with_retry

def flaky(fail_times, exc_type=ConnectionError):
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
      file: "resilience/retry.py",
      lineStart: 16,
      lineEnd: 16,
      severity: "major",
      failure: "`except Exception` retries every error type — programmer errors like ValueError get retried and hidden instead of propagating immediately.",
      explanation: "The handler must catch only the transient classes: `except retry_on as exc:`. The `retry_on` parameter exists precisely for this and is currently ignored.",
      keywords: ["except exception", "retry_on", "broad", "catch", "propagate", "transient", "valueerror"],
    },
    {
      id: "silent-none",
      file: "resilience/retry.py",
      lineStart: 18,
      lineEnd: 18,
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
  tags: ["idempotency", "error-handling", "payments", "state-management"],
  prompt:
    "A customer was charged twice for one order. The provider's docs say delivery is at-least-once: the same event WILL occasionally arrive twice, and a delivery attempt can also die mid-flight and be redelivered. There's a `processed` set in the code, so someone thought about this — but chargebacks say otherwise. There are two distinct flaws in how idempotency is handled. Make the suite green.",
  files: [
    F("payments/__init__.py", `from .processor import PaymentProcessor\n`),
    F(
      "payments/gateway.py",
      `"""Payment gateway interface (do not edit — this is the contract)."""


class Gateway:
    def charge(self, customer, amount):
        """Move money. Raises on transient failure; the caller must retry safely."""
        raise NotImplementedError
`,
      true,
    ),
    F(
      "payments/processor.py",
      `from .gateway import Gateway


class PaymentProcessor:
    """Applies \`charge\` webhooks from the payment provider to the gateway.

    Delivery is at-least-once: the same event may arrive multiple times
    (replays, provider retries), and a delivery attempt can fail midway.
    """

    def __init__(self, gateway: Gateway):
        self.gateway = gateway
        self.processed = set()

    def handle(self, event):
        eid = event["id"]
        if event.get("type") != "charge":
            return "ignored"
        self.processed.add(eid)
        result = self.gateway.charge(event["customer"], event["amount"])
        return result
`,
    ),
  ],
  testSuite: {
    setup: `from payments import PaymentProcessor
from payments.gateway import Gateway

class FakeGateway(Gateway):
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
      file: "payments/processor.py",
      lineStart: 17,
      lineEnd: 21,
      severity: "critical",
      failure: "`processed` is written but never READ — replays sail straight through to the gateway and the customer is charged once per delivery.",
      explanation:
        "handle() needs a guard before charging: `if eid in self.processed: return \"duplicate\"`. Recording processed IDs is worthless if nothing checks them.",
      keywords: ["never checked", "duplicate", "replay", "idempotency", "in self.processed", "guard", "double charge"],
    },
    {
      id: "mark-before-charge",
      file: "payments/processor.py",
      lineStart: 20,
      lineEnd: 20,
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
  tags: ["retry", "idempotency", "error-handling", "payments", "webhooks", "distributed", "backpressure"],
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
  tags: ["caching", "state-management", "memory", "concurrency", "data-modeling"],
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
  tags: ["sql-injection", "pagination", "performance", "database", "edge-cases"],
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

// ---------------------------------------------------------------------------
// DESIGN PROBLEMS — open-ended, graded against a seeded rubric (no line anchors)
// ---------------------------------------------------------------------------

const designRobotTeleoperation: SeedProblem = {
  type: "design",
  difficulty: "medium",
  title: "Design low-latency teleoperation for a robot fleet",
  tags: [
    "robotics",
    "real-time",
    "latency",
    "networking",
    "streaming",
    "video",
    "performance",
    "observability",
    "profiling",
    "reliability",
  ],
  prompt:
    "A company operates 500 robots across 40 customer sites. When a robot needs help, a remote operator takes control using three 1080p camera feeds and a 100 Hz command stream. Design the teleoperation system for p95 command-to-actuation under 80 ms and glass-to-glass video under 180 ms, including weak networks, unattended-site safety, observability, and fleet scale. State assumptions, build a latency/capacity budget, choose concrete protocols and components, and explain how the system degrades when conditions get bad.",
  starterCode: `# Design: low-latency robot teleoperation

## Requirements and budgets
<!-- concurrent sessions, video bitrate, control frequency, p95/p99 latency budget -->

## Session and control plane
<!-- operator assignment, auth/lease, command ordering, robot state feedback -->

## Video and network path
<!-- capture/encode/transport/decode, relay placement, jitter and congestion handling -->

## Safety and degraded operation
<!-- dead-man switch, local watchdog, packet loss, disconnects, safe stop -->

## Observability and debugging
<!-- clock sync, per-stage timing, traces, packet/frame metrics, remote diagnostics -->

## Scale and trade-offs
<!-- fleet concurrency, regional placement, bandwidth/compute, quality vs latency -->
`,
  answerKey: [
    {
      id: "budgets",
      lineStart: 0,
      lineEnd: 0,
      severity: "critical",
      failure: "No end-to-end latency and capacity budget.",
      explanation:
        "Breaks the 80 ms command and 180 ms video SLOs into measurable stages (capture, encode, network, queue, decode, actuation), estimates concurrent sessions and aggregate video bandwidth, and distinguishes p50/p95/p99 and jitter rather than discussing latency as one number.",
      keywords: ["latency budget", "p95", "p99", "jitter", "bitrate", "concurrent", "bandwidth", "milliseconds"],
    },
    {
      id: "media-path",
      lineStart: 0,
      lineEnd: 0,
      severity: "major",
      failure: "Video pipeline and transport are hand-waved.",
      explanation:
        "Specifies camera capture, hardware encoding, codec and frame settings, WebRTC or another real-time transport, regional relay/TURN placement, bounded jitter buffers, and decode/render timing. Explains why low latency may matter more than perfect frame delivery.",
      keywords: ["webrtc", "rtp", "codec", "hardware encode", "jitter buffer", "turn", "relay", "frame"],
    },
    {
      id: "control-path",
      lineStart: 0,
      lineEnd: 0,
      severity: "critical",
      failure: "Control commands have no concrete ordering, freshness, or ownership model.",
      explanation:
        "Separates control from bulk media, uses sequence numbers and timestamps so stale commands are dropped, defines a single operator lease and heartbeat, prioritizes commands over telemetry, and closes the loop with robot-state feedback.",
      keywords: ["sequence", "timestamp", "stale", "lease", "heartbeat", "priority", "feedback", "control channel"],
    },
    {
      id: "network-degradation",
      lineStart: 0,
      lineEnd: 0,
      severity: "major",
      failure: "Weak and variable networks do not change system behavior.",
      explanation:
        "Measures bandwidth, RTT, loss, and jitter; adapts bitrate/resolution/frame rate; uses congestion control and selective redundancy appropriately; bounds queues to avoid latency buildup; and defines an explicit degraded mode instead of retrying forever.",
      keywords: ["congestion", "packet loss", "adaptive bitrate", "resolution", "frame rate", "fec", "queue", "degraded"],
    },
    {
      id: "safety",
      lineStart: 0,
      lineEnd: 0,
      severity: "critical",
      failure: "A network or operator failure can leave the robot moving unattended.",
      explanation:
        "Keeps safety enforcement on the robot with a dead-man control, command timeout/watchdog, speed and workspace limits, authenticated sessions, and a deterministic safe-stop or local fallback when the lease, process, or network fails.",
      keywords: ["dead man", "watchdog", "safe stop", "timeout", "local", "limit", "auth", "fail safe"],
    },
    {
      id: "diagnostics",
      lineStart: 0,
      lineEnd: 0,
      severity: "major",
      failure: "Cross-device timing failures cannot be localized after deployment.",
      explanation:
        "Uses synchronized clocks and correlation/session IDs, records per-stage frame and command timestamps, exposes RTT/loss/jitter/queue/drop metrics and traces, retains bounded diagnostic evidence, and supports remote health checks without flooding the weak link.",
      keywords: ["clock sync", "timestamp", "trace", "correlation", "packet loss", "frame drop", "profil", "health"],
    },
    {
      id: "fleet-scale",
      lineStart: 0,
      lineEnd: 0,
      severity: "major",
      failure: "The design works for one lab robot but not a distributed fleet.",
      explanation:
        "Separates signaling/session coordination from real-time media and control, places relays regionally, estimates relay bandwidth and encoder/decoder capacity at expected concurrency, isolates customers, and covers rollout, version skew, and regional failure.",
      keywords: ["signaling", "regional", "relay", "capacity", "tenant", "rollout", "version", "failover"],
    },
  ],
};

const designRateLimiter: SeedProblem = {
  type: "design",
  difficulty: "hard",
  title: "Design a distributed rate limiter",
  tags: ["rate-limiting", "distributed", "concurrency", "state-management", "backend"],
  prompt:
    "An API gateway spread across 12 regions must enforce a per-user limit of 1,000 requests/minute. Design it. The interviewer will push on the parts you gloss over — think out loud in the doc: state your assumptions, show the capacity math, argue the trade-offs, and reason through what happens when things fail.",
  starterCode: `# Design: distributed rate limiter (1,000 req/min per user, 12 regions)

## Requirements & assumptions
<!-- traffic shape, QPS, hard vs soft limit, per-user vs per-key, accuracy tolerance -->

## Approach & data model
<!-- algorithm (token bucket / sliding window?), where counters live, key schema -->

## Handling 12 regions
<!-- local vs centralized counting, how regions share state, consistency -->

## Failure modes
<!-- counter store down, clock skew, hot keys, thundering herd -->

## Trade-offs
<!-- accuracy vs latency vs cost; what you deliberately gave up -->
`,
  answerKey: [
    {
      id: "requirements",
      lineStart: 0,
      lineEnd: 0,
      severity: "major",
      failure: "Requirements & scale not pinned down before designing.",
      explanation:
        "Estimates the request volume (e.g. N users × 1000/min → peak QPS), decides hard vs. soft limiting, and states whether the limit is global-per-user or per-region — the numbers that drive every later choice.",
      keywords: ["qps", "requests per", "assume", "peak", "hard limit", "soft limit"],
    },
    {
      id: "algorithm",
      lineStart: 0,
      lineEnd: 0,
      severity: "major",
      failure: "No concrete limiting algorithm or counter data model.",
      explanation:
        "Picks token bucket or sliding-window (and justifies it over fixed-window's boundary bursts), and specifies the counter key/value and where it lives (e.g. Redis with per-user keys + TTL).",
      keywords: ["token bucket", "sliding window", "fixed window", "redis", "counter", "leaky bucket"],
    },
    {
      id: "distribution",
      lineStart: 0,
      lineEnd: 0,
      severity: "critical",
      failure: "Doesn't address how 12 regions enforce ONE global limit.",
      explanation:
        "Confronts the core tension: local per-region counters are fast but let a user exceed the global limit N-fold; a shared/centralized store is accurate but adds latency. Proposes a real stance (central store, or local buckets with async reconciliation) and owns its cost.",
      keywords: ["central", "shared state", "replicat", "sync", "regions", "global", "eventual", "local counter"],
    },
    {
      id: "atomicity",
      lineStart: 0,
      lineEnd: 0,
      severity: "major",
      failure: "Check-then-decrement race on the shared counter is ignored.",
      explanation:
        "Recognizes that read-then-write on a shared counter races under concurrency and uses an atomic operation (Redis INCR/Lua script, atomic token-bucket refill) so simultaneous requests can't both pass the last token.",
      keywords: ["atomic", "incr", "lua", "race", "compare and swap", "transaction"],
    },
    {
      id: "failure",
      lineStart: 0,
      lineEnd: 0,
      severity: "major",
      failure: "Failure modes (store down, clock skew, hot keys) not reasoned through.",
      explanation:
        "Decides fail-open vs. fail-closed when the counter store is unreachable, handles clock skew across regions for time-windowed limits, and addresses hot-key/thundering-herd for a single popular user.",
      keywords: ["fail open", "fail closed", "clock skew", "hot key", "outage", "unavailable", "degrade"],
    },
  ],
};

const ALL: SeedProblem[] = [
  designRobotTeleoperation,
  designRateLimiter,
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
  let created = 0;
  let updated = 0;
  for (const p of ALL) {
    const data = {
      type: p.type,
      language: "python",
      difficulty: p.difficulty,
      title: p.title,
      tags: p.tags,
      prompt: p.prompt,
      starterCode: p.starterCode ?? null,
      files: p.files ? (p.files as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
      testSuite: p.testSuite ? (p.testSuite as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
      diff: p.diff ? (p.diff as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
      prMeta: p.prMeta ? (p.prMeta as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
      answerKey: p.answerKey as unknown as Prisma.InputJsonValue,
      source: "authored",
    };
    const existing = await prisma.problem.findFirst({
      where: { source: "authored", title: p.title },
      select: { id: true },
    });
    if (existing) {
      await prisma.problem.update({ where: { id: existing.id }, data });
      updated += 1;
    } else {
      await prisma.problem.create({ data });
      created += 1;
    }
  }

  const count = await prisma.problem.count();
  console.log(`Synced ${ALL.length} authored problems (${created} created, ${updated} updated). Bank now holds ${count}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
