/**
 * v0 seed bank — hand-authored problems (spec §16, "v0: 5 hand-authored debug
 * problems, skip generation"). Each has a real answer key and, for debug, a
 * Pyodide-runnable test suite that FAILS on the seeded bug and PASSES on the fix.
 *
 * Line numbers in every answerKey are 1-based against the `starterCode` (debug)
 * or the new-file `lineNo` of the diff (review) — the coordinate system the
 * editor and diff viewer render and the grader matches against.
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
// DEBUG PROBLEMS
// ---------------------------------------------------------------------------

const debugBatch: SeedProblem = {
  type: "debug",
  difficulty: "medium",
  title: "Webhook handler drops every 8th event",
  prompt:
    "process_events dispatches events in fixed-size batches, but the last batch never goes out — the final events silently vanish. Make the tests pass.",
  starterCode: `def process_events(events, batch_size=8):
    # dispatch events in fixed-size batches
    sent = []
    i = 0
    while i < len(events) - batch_size:
        chunk = events[i:i + batch_size]
        dispatch(chunk)
        sent.extend(chunk)
        i += batch_size
    return sent`,
  testSuite: {
    setup: `_dispatched = []
def dispatch(chunk):
    _dispatched.extend(list(chunk))`,
    cases: [
      { name: "test_empty_input", body: `assert process_events([], 8) == []` },
      { name: "test_exact_multiple", body: `assert process_events(list(range(16)), 8) == list(range(16))` },
      { name: "test_partial_last_batch", body: `assert process_events(list(range(20)), 8) == list(range(20))` },
    ],
  },
  answerKey: [
    {
      id: "off-by-one-bound",
      lineStart: 5,
      lineEnd: 5,
      severity: "major",
      failure: "The loop stops a full batch early, so the final window (and any exact final batch) is never dispatched.",
      explanation:
        "`while i < len(events) - batch_size` exits before the last window. It should be `while i < len(events)`, so the final slice — even a partial one — still dispatches.",
      keywords: ["off by one", "boundary", "len(events)", "loop condition", "last batch", "partial", "- batch_size"],
    },
  ],
};

const debugMovingAvg: SeedProblem = {
  type: "debug",
  difficulty: "easy",
  title: "Moving average returns wrong window count at the edges",
  prompt:
    "moving_average should return one average per full window of size k. It's returning extra, wrong values at the tail. Fix it.",
  starterCode: `def moving_average(nums, k):
    # average of each full window of size k
    out = []
    for i in range(len(nums)):
        window = nums[i:i + k]
        out.append(sum(window) / k)
    return out`,
  testSuite: {
    cases: [
      { name: "test_basic_windows", body: `assert moving_average([1, 2, 3, 4], 2) == [1.5, 2.5, 3.5]` },
      { name: "test_window_count", body: `assert len(moving_average([1, 2, 3, 4, 5], 3)) == 3` },
      { name: "test_single_window", body: `assert moving_average([2, 4], 2) == [3.0]` },
    ],
  },
  answerKey: [
    {
      id: "tail-windows",
      lineStart: 4,
      lineEnd: 6,
      severity: "major",
      failure: "Iterating the full range produces short tail windows and divides them by k, yielding too many, incorrect averages.",
      explanation:
        "The loop should run `range(len(nums) - k + 1)` so only full windows are produced. As written it emits `len(nums)` outputs and averages truncated tail slices over the wrong denominator.",
      keywords: ["range", "len(nums) - k", "tail", "window count", "off by one", "full window"],
    },
  ],
};

const debugMutableDefault: SeedProblem = {
  type: "debug",
  difficulty: "medium",
  title: "Basket accumulates items across unrelated calls",
  prompt:
    "add_item should start each caller with a fresh basket, but items leak between calls. Track down why.",
  starterCode: `def add_item(item, basket=[]):
    basket.append(item)
    return basket`,
  testSuite: {
    cases: [
      { name: "test_first_call", body: `assert add_item("a") == ["a"]` },
      {
        name: "test_calls_are_independent",
        body: `add_item("x")\nassert add_item("y") == ["y"]`,
      },
    ],
  },
  answerKey: [
    {
      id: "mutable-default-arg",
      lineStart: 1,
      lineEnd: 1,
      severity: "major",
      failure: "The default list is created once at definition time and shared across every call, so baskets accumulate.",
      explanation:
        "`basket=[]` is a classic mutable-default-argument bug. Use `basket=None` and create a new list inside: `if basket is None: basket = []`.",
      keywords: ["mutable default", "default argument", "basket=[]", "shared", "none", "sentinel"],
    },
  ],
};

const debugBinarySearch: SeedProblem = {
  type: "debug",
  difficulty: "medium",
  title: "Binary search misses elements at the boundary",
  prompt:
    "binary_search works for most inputs but returns -1 for some values that are actually present. Find the boundary bug.",
  starterCode: `def binary_search(arr, target):
    lo, hi = 0, len(arr) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if arr[mid] == target:
            return mid
        elif arr[mid] < target:
            lo = mid + 1
        else:
            hi = mid - 1
    return -1`,
  testSuite: {
    cases: [
      { name: "test_found_middle", body: `assert binary_search([1, 3, 5, 7, 9], 5) == 2` },
      { name: "test_found_last", body: `assert binary_search([1, 3, 5, 7, 9], 9) == 4` },
      { name: "test_missing", body: `assert binary_search([1, 3, 5], 4) == -1` },
    ],
  },
  answerKey: [
    {
      id: "loop-condition",
      lineStart: 3,
      lineEnd: 3,
      severity: "major",
      failure: "`while lo < hi` skips the final single-element window, so a target sitting at lo == hi is never checked.",
      explanation:
        "With an inclusive `hi = len(arr) - 1`, the loop must continue while `lo <= hi`. As written, once the range narrows to one element the loop exits and returns -1.",
      keywords: ["lo < hi", "lo <= hi", "loop condition", "boundary", "off by one", "single element"],
    },
  ],
};

const debugWordCounts: SeedProblem = {
  type: "debug",
  difficulty: "easy",
  title: "Word counter treats 'The' and 'the' as different words",
  prompt:
    "word_counts should be case-insensitive, but capitalized words are counted separately. Fix the normalization.",
  starterCode: `def word_counts(text):
    counts = {}
    for word in text.split():
        counts[word] = counts.get(word, 0) + 1
    return counts`,
  testSuite: {
    cases: [
      { name: "test_case_insensitive", body: `assert word_counts("The the THE") == {"the": 3}` },
      { name: "test_mixed", body: `assert word_counts("Cat cat Dog") == {"cat": 2, "dog": 1}` },
    ],
  },
  answerKey: [
    {
      id: "no-case-normalization",
      lineStart: 4,
      lineEnd: 4,
      severity: "minor",
      failure: "Words are counted as-is, so different casings become separate keys.",
      explanation:
        "Normalize before counting: key on `word.lower()`. Without it, 'The', 'the', and 'THE' are three distinct dictionary keys.",
      keywords: ["lower", "case", "normalize", "case-insensitive", "word.lower()"],
    },
  ],
};

// ---------------------------------------------------------------------------
// REVIEW PROBLEMS (diff-centric, no editing)
// ---------------------------------------------------------------------------

/** Helper to build a context/add/del diff line. */
const ctx = (lineNo: number, content: string): DiffHunk["lines"][number] => ({ kind: "context", lineNo, content });
const add = (lineNo: number, content: string): DiffHunk["lines"][number] => ({ kind: "add", lineNo, content });
const del = (content: string): DiffHunk["lines"][number] => ({ kind: "del", lineNo: null, content });

const reviewRetry: SeedProblem = {
  type: "review",
  difficulty: "medium",
  title: "Add retry logic to payment webhook",
  prompt:
    "Adds automatic retries when the downstream ledger service is unavailable, so we stop losing payment confirmations during brief outages. Retries on any exception with a short sleep between attempts.",
  prMeta: { number: 4192, branch: "feat/webhook-retries", additions: 6, deletions: 1, files: 1, aiGenerated: true },
  diff: [
    {
      file: "services/payments/webhook.py",
      lines: [
        ctx(40, "def handle(event):"),
        ctx(41, "    payload = verify(event)"),
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
      failure: "`while True` with no max-attempt cap blocks the worker forever if the ledger stays down.",
      explanation:
        "Retries need a bounded attempt count plus backoff. An unbounded loop ties up the worker (and the webhook's own timeout) indefinitely during a sustained outage.",
      keywords: ["while true", "unbounded", "max attempts", "retry forever", "cap", "backoff", "no limit"],
    },
    {
      id: "no-idempotency",
      lineStart: 44,
      lineEnd: 44,
      severity: "critical",
      failure: "Re-calling ledger.record() after a partial success double-charges the customer — the retry has no idempotency key.",
      explanation:
        "If record() succeeds but the ack is lost, the retry records the payment again. The call needs a stable idempotency key so the ledger dedupes — this is the one that actually loses money.",
      keywords: ["idempotency", "idempotent", "double charge", "duplicate", "dedupe", "exactly once", "at least once"],
    },
    {
      id: "broad-except",
      lineStart: 46,
      lineEnd: 46,
      severity: "minor",
      failure: "`except Exception` swallows programming errors, not just transient outages.",
      explanation:
        "Catching bare Exception hides bugs (e.g. a KeyError in verify) and retries them pointlessly. Catch the specific transient/network error class instead.",
      keywords: ["except exception", "broad except", "bare except", "swallow", "too broad", "specific exception"],
    },
  ],
};

const reviewCache: SeedProblem = {
  type: "review",
  difficulty: "medium",
  title: "Cache user lookups to cut DB load",
  prompt:
    "Adds an in-memory cache in front of get_user so repeated lookups don't hit the database. Keeps update_user writing straight through to the DB.",
  prMeta: { number: 5310, branch: "perf/user-cache", additions: 5, deletions: 1, files: 1, aiGenerated: true },
  diff: [
    {
      file: "services/users/cache.py",
      lines: [
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
      ],
    },
  ],
  answerKey: [
    {
      id: "stale-cache",
      lineStart: 19,
      lineEnd: 20,
      severity: "major",
      failure: "update_user writes to the DB but never invalidates _cache, so callers keep reading stale user data after an update.",
      explanation:
        "Any write path must evict or refresh the cache entry (`_cache.pop(user_id, None)` after save). Without it, the cache serves the pre-update value indefinitely.",
      keywords: ["invalidate", "stale", "cache invalidation", "evict", "update", "pop", "refresh"],
    },
    {
      id: "unbounded-cache",
      lineStart: 16,
      lineEnd: 16,
      severity: "major",
      failure: "_cache grows without bound — no eviction, TTL, or max size — a memory leak that eventually exhausts the process.",
      explanation:
        "A process-lifetime dict keyed by user_id will accumulate every user ever looked up. Needs an LRU/size cap or TTL (e.g. functools.lru_cache or an explicit bounded cache).",
      keywords: ["unbounded", "memory leak", "eviction", "ttl", "max size", "lru", "grows", "bounded"],
    },
  ],
};

const ALL: SeedProblem[] = [
  debugBatch,
  debugMovingAvg,
  debugMutableDefault,
  debugBinarySearch,
  debugWordCounts,
  reviewRetry,
  reviewCache,
];

async function main() {
  // Idempotent: clear previously-authored problems (cascades to their attempts).
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
