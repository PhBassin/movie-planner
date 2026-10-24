# 0010. TheaterSubmission retry and stale-pending expiry

- **Status:** Accepted
- **Date:** 2026-10-24

## Context

A failed TheaterSubmission left two dead ends (issue #119):

1. **Failed submissions could not be retried.** A failed `add_theater` scrape leaves the Theater row in `provisioning` (see *Theater lifecycle* in `CONTEXT.md`). `SubmissionService.submit` rejected any URL whose Theater row already existed with `409 This cinema is already being added to the catalog`, so after one failure the URL was blocked for **every** Member until Staff deleted the Theater. `CONTEXT.md` claimed that "a later scrape or re-submission can still succeed"; it could not.
2. **A pending submission could stay pending forever.** The worker deletes a `scrape_jobs` row when it claims it (`scraper/src/bus/pg-job-consumer.ts`). If the worker dies mid-scrape, the ScrapeReport stays `running`. ADR 0005's reconciliation (sub-decision 8) only resolves pending submissions joined to a *terminal* report, so this submission never resolved.

The Member view of submissions (issue #120, story 25 of #2) needs both to work: a failed row must offer "retry", and a retry must not be blocked by a stuck attempt.

## Decision

**A failed submission's URL may be submitted again, as a new attempt against the existing `provisioning` Theater; a submission still pending after 30 minutes is expired to `failed` by the reconciliation sweep.**

1. **Retry rule.** Submitting a URL whose Theater row exists is accepted as a retry when the Theater is `provisioning`, it has **at least one** TheaterSubmission, and **none is `pending`** (the last attempt is terminal). The retry enqueues a new `add_theater` ScrapeJob against the existing row, without inserting a duplicate Theater. Otherwise the 409 stays. This covers a pending attempt, a Theater that went `active` while the request was in flight, and a `provisioning` row introduced by Staff (no submission: its scrape is not tracked through `theater_submissions`, so a Member must not start a second scrape behind it).
2. **Concurrency.** The decision runs under `SELECT … FOR UPDATE` on the Theater row (`lockTheaterForSubmission`), after the existing Member lock. Concurrent retries of the same URL, by the same or different Members, serialize: exactly one sees "no pending attempt" and enqueues the scrape, and the others get the 409.
3. **One row per attempt.** A retry inserts a **new** `theater_submissions` row with its own `report_id`, `created_at` and status. The failed row is kept. The resolver, the reconciliation and the `report_id` join (ADR 0005) are unchanged.
4. **Retries count toward the throttle.** The per-Member throttle (ADR 0003) counts rows by `created_at`, so a retry consumes a slot like a new cinema. Verification and suspension gates apply unchanged; the dedup fast path for `active` Theaters is unchanged.
5. **Stale-pending expiry.** Each reconciliation run (startup and the ~60s sweep) first marks `failed` the still-`running` ScrapeReport of every pending submission created more than **30 minutes** ago (`STALE_PENDING_SUBMISSION_TIMEOUT_MS`, a `const`). It also deletes that report's queued job if the worker never claimed it, so no scrape runs after the expiry. The same run then resolves those submissions `failed` through the normal routine: terminal status, sanitized `failed` Member notification, and the URL becomes retryable. Only submission-linked reports are touched. A Staff-triggered scrape stuck in `running` is out of scope.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Reset the failed row to `pending` with a new `report_id` | Overwrites the attempt history and `created_at`; the throttle would need a new column (`attempted_at`) and a migration to count retries. |
| Persist a `succeeded_selection_full` status | It only describes the moment of resolution; the Member view derives "in / not in Selection" from `member_selections` at read time instead (issue #120), which stays true after later Selection changes. |
| Keep submissions when Staff delete the Theater (`ON DELETE SET NULL`) | Needs a nullable `theater_id` and touches the resolver, the export and the throttle. ADR 0001's cascade stays; deleting the Theater also unblocks the URL. |
| Retry on any `provisioning` row, Staff-introduced included | A Staff add in flight has no submission to tell us it is pending, so a Member could start a duplicate scrape behind it. |
| Expiry decided in the view ("stuck" label + allow retry while pending) | Leaves a pending row that never resolves next to a new attempt. |
| Env-tunable timeout | A single-theater scrape finishes within minutes. A fixed `const` keeps the surface small, like the ADR 0006 token lifetime. |

## Consequences

- `CONTEXT.md` → TheaterSubmission defines **attempt**, the retry rule and stale-pending expiry, and no longer claims an impossible re-submission.
- A scrape that legitimately runs longer than 30 minutes and then succeeds leaves the submission `failed` while the Theater becomes `active`. The resolver finds no pending row and does nothing. A retry then degrades to the dedup Selection add. Accepted: rare, and self-healing on the Member's next action.
- The expired report's `errors` records `Submission scrape timed out` for Staff; Members see only the sanitized reason.

## Cross-references

- ADR 0003 (Member submission triggers an immediate scrape; throttle)
- ADR 0005 (resolution routine and reconciliation sweep)
- ADR 0001 (hard-delete Theaters, cascade)
- `server/src/services/submission-service.ts`, `server/src/services/submission-resolver.ts`, `server/src/db/submission-queries.ts`
