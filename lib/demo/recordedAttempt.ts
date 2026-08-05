/**
 * The recorded attempt behind /demo.
 *
 * Anvil's first-run problem is structural: every AI path needs the visitor's own
 * provider key, so someone evaluating the product has to go get an API key
 * before they can see a single graded result. This is the answer — a real
 * problem from the bank, a plausible reviewer's comments, and the grade those
 * comments actually earn.
 *
 * How much of it is real matters, because a fabricated demo would be claiming
 * exactly the thing Anvil says it can prove:
 *
 * - The PR, the diff, and the answer key are the live bank row, read from the
 *   database at request time. Nothing here restates them.
 * - Which comments count as catches is computed by the shipping matcher, and
 *   the score by the shipping arithmetic (`assembleReviewGrade`). If either
 *   changes, this demo changes with it.
 * - Only the qualitative layer is scripted: the headline, the summary, the
 *   verdict on the one comment that isn't a seeded flaw, and the follow-up
 *   conversation. Those are what the model would have written, and the UI says
 *   so rather than implying a live grade.
 *
 * The comments are chosen to produce the most instructive outcome rather than
 * the most flattering one: the reviewer catches the frightening bug and the
 * slow one, walks straight past a boring off-by-one that makes page 1
 * unreachable, and loses points for a nit. That is the actual failure mode this
 * product exists to train.
 */
import type { ChatMessage, Problem, ReviewComment } from "../types";
import type { ReviewJudgment } from "../anthropic/grade";
import { matchReviewComments } from "../grading/matcher";
import { assembleReviewGrade } from "../grading";

/** The seeded review problem the recording is against, by authored title. */
export const DEMO_PROBLEM_TITLE = "Add pagination to the orders endpoint";

/** What the recorded reviewer left on the PR. */
export const DEMO_COMMENTS: ReviewComment[] = [
  {
    file: "api/orders.py",
    line: 18,
    body: "This drops the bind parameters that were here before — `user_id` is interpolated straight into the SQL with an f-string. That's a SQL injection, and it reads as a mechanical rewrite so it'll sail through review. Use placeholders for every value.",
  },
  {
    file: "api/orders.py",
    line: 21,
    body: "The total loads every order row and takes len() in Python. That's the full table scan this PR is supposed to remove, and now it runs on every page request. `SELECT COUNT(*)` instead.",
  },
  {
    file: "api/orders.py",
    line: 22,
    body: "Response shape changed — old clients reading `orders` still work, but I'd version this endpoint rather than adding fields in place.",
  },
];

/**
 * The judgment the grading model returned for those comments.
 *
 * `index` refers to the unmatched-comment list, not `DEMO_COMMENTS`: the first
 * two comments land on seeded flaws and never reach the judge, so index 0 is
 * the versioning nit. It is a reasonable remark and still a false positive —
 * the exercise is about flaws that break something, and the scoring says so.
 */
export const DEMO_JUDGMENT: ReviewJudgment = {
  headline: "Caught the dangerous one, missed the boring one",
  summary:
    "Strong instincts on severity: you found the injection and the count that re-introduces the timeout, which are the two comments that would matter most in a real review. But the off-by-one in the offset is the kind of defect that ships — it makes the first page of results unreachable, and nothing about it looks alarming. The versioning remark is a preference, not a defect, and this exercise scores it as a false positive.",
  assessments: [
    {
      index: 0,
      isRealIssue: false,
      matchedIssueId: null,
      note: "A defensible API-design preference, but the PR is backwards compatible as written — nothing breaks for existing clients.",
    },
  ],
};

/** The Socratic follow-up, aimed at the flaw the reviewer walked past. */
export const DEMO_TRANSCRIPT: ChatMessage[] = [
  {
    role: "interviewer",
    content:
      "You went straight for the injection, which is the right first move. Let's stay on the part you passed over. Walk me through what `list_orders(user_id, page=1)` returns for a user with exactly 30 orders.",
  },
  { role: "user", content: "Page 1, so offset is 1 * 50 = 50... and there are only 30 rows, so it returns nothing." },
  {
    role: "interviewer",
    content:
      "Right. And that's the whole feature returning empty for every user with fewer than 50 orders. What would you have had to notice in the diff to catch it — was the information there?",
  },
  {
    role: "user",
    content:
      "It was on the line right above the SQL. I think I anchored on the f-strings and stopped reading the arithmetic once I'd found something serious.",
  },
  {
    role: "interviewer",
    content:
      "That's the pattern worth naming: a critical finding ends the search. In a real review the injection gets fixed in one commit and the off-by-one ships. Next PR, try finishing the read before you write the first comment.",
  },
];

/** The grade those comments earn — matcher and arithmetic run for real. */
export function buildDemoGrade(problem: Problem) {
  const match = matchReviewComments(DEMO_COMMENTS, problem.answerKey);
  return assembleReviewGrade(problem, match, DEMO_JUDGMENT);
}
