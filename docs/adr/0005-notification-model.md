# 0005. Notification model — transient SSE over the durable "Mes soumissions" record

- **Status:** Accepted
- **Date:** 2026-07-23

## Context

Issue #2 (the SaaS transformation) opens a self-registering **Member** actor who can submit a new cinema (a **TheaterSubmission**). A submission is asynchronous: it is *submitted* the moment the URL is accepted, *pending* while its `add_theater` ScrapeJob runs, and resolves to `succeeded`, `succeeded`-but-cap-blocked, or `failed` (CONTEXT.md → TheaterSubmission; the Selection-cap decision). The Member needs to learn the outcome — most of all a **failure**, which is invisible otherwise.

Three resolved decisions in issue #2 already defer to a notification model and half-assume "SSE" without committing it:

- *Homepage content model* — "success/failure is surfaced on the homepage only as a transient SSE notice."
- *Selection cap* — "this decision assumes SSE for the cap-blocked auto-add notice."
- *Member self-deletion* — flags the notification model as out-of-scope-for-later.

The open questions were: *email vs. in-app inbox vs. SSE? Is "a notification" itself a durable concept? How does a resolved submission reach the right Member's screen, and what delivery guarantees does it have?* These are load-bearing because the scraper runs out-of-process and writes results straight to PostgreSQL, so the live push is a real cross-process routing problem, not a function call.

The existing infrastructure is lopsided: a **global, unauthenticated, broadcast SSE stream** (`/api/scraper/progress` → `ProgressTracker` singleton → fan-out to every listener) carries Staff scraper telemetry (`ProgressEvent`s), fed by the PostgreSQL `scrape:progress` `LISTEN/NOTIFY` channel. There is **no** per-user routing, no persistence of events, and **no mailer** (only `email_from_*` branding fields in `app_settings`).

## Decision

**There is no notification entity. Durability lives in "Mes soumissions" (the `theater_submissions` row); the live push is purely transient SSE. Email stays auth-only.** The decision was reached by grilling (issue #2, *Notification model*); the nine sub-decisions below are the resolution.

1. **No notification entity; durability = "Mes soumissions."** The submission row is the single durable source of outcome truth. The live push is best-effort, fire-and-forget SSE with no replay and no read/unread state. A Member who misses a live push (tab closed, offline) discovers the outcome next time they open "Mes soumissions." This avoids inventing a notifications table, inbox machinery, and ack state for a SaaS whose only durable outcome surface is already specced elsewhere. The submission row already records `succeeded | failed` durably, so a dropped push defers discovery — it does not lose a fact.

2. **Email is auth-only.** The mailer (SMTP, introduced by issue #2) carries **verification** and **password-reset** mail and nothing else. Submission outcomes never go to email. This keeps email's cost/abuse surface pinned to auth, where issue #2 scoped it, and avoids a fourth mailer use case with its own bounce/complaint loop. (The password-reset flow's own mechanics are a separate grilling topic.)

3. **A new per-Member auth-gated SSE stream, separate from `/api/scraper/progress`.** The Member stream lives at `/api/me/notifications` (the `/api/me/*` Member-scoped convention). The existing global tracker is left untouched; a new per-`memberId`-keyed sink is added. The `attachProgressStream` / `ProgressListenerSink` seam (`server/src/services/sse-bridge.ts`) extends cleanly to a second tracker instance. Rationale: the scraper stream is unauthenticated Staff telemetry (per-theater/per-date attempts, rate-limit cascades); a Member notice is per-user, requires Member auth, and carries an end-user outcome. Conflating them invites leakage and couples two unrelated evolution paths.

4. **A dedicated `member:notices` PostgreSQL `LISTEN/NOTIFY` channel; the SSE router is dumb.** Whoever resolves a submission publishes a Member-shaped notice on `member:notices`; the SSE router's entire job is "subscribe, route by `memberId` to that Member's live connections." The router never touches `ProgressEvent` vocabulary. This separates the Member-domain payload from the scraper-domain event, keeps the fanout hot path single-responsibility, and means future outcome sources (a Staff-deprecated cinema, etc.) add a new `type` arm on the same channel instead of dragging through scraper vocabulary. It is the established codebase pattern (`scrape:progress`, `scraper:schedule:changed`) — a purpose-specific channel, not a new mechanism.

5. **Three async outcomes fire a notice; synchronous rejections do not.** Notices fire for `succeeded`, `succeeded_selection_full` (scrape ok, Selection full, **not** auto-added — a distinct outcome because the Member's next action differs: "free a slot and add from `/cinemas`" vs. nothing), and `failed`. **Throttle rejection and dedup downgrade are not notices** — both resolve synchronously in the `POST` submission response (throttle → an error status; dedup → 200 "added to Selection"), so they never enter the async resolver and have no terminal event to publish.

6. **Discriminated payload, Member-shaped.** The notice is a discriminated union keyed on `type`, with `outcome` a distinct string (not `status` + a flag) so the client branches cleanly:
   ```ts
   type MemberNotice =
     | { type: 'submission_resolved';
         submissionId: number;
         theaterId: number;        // cap-blocked needs it; succeeded can highlight the new card
         theaterName: string;      // toast copy, no client round-trip
         outcome: 'succeeded' | 'succeeded_selection_full' | 'failed';
         reason?: string; }        // only on 'failed'; short, sanitized, Member-facing
   // future outcome sources add a new `type` arm
   ```
   `theaterId`/`theaterName` are inlined so the client can render a toast without a fetch. `reason` on `failed` is sanitized and Member-facing ("Source injoignable"); the scrape error type / HTTP status never rides the wire (the `AGENTS.md` rule on not exposing internal errors) — full failure detail lives on "Mes soumissions."

7. **The server owns the terminal-status write + Selection auto-add + notice publish; the scraper stays domain-agnostic.** The server already subscribes to `scrape:progress`; on a terminal event whose `reportId` joins a `theater_submissions` row, it (1) writes the submission's terminal status, (2) performs the Selection auto-add (or marks cap-block) **under the existing cap transaction** (`SELECT … FOR UPDATE` on the Member's `users` row), (3) publishes the notice on `member:notices` — in that order, so the durable facts (status, selection) commit before the ephemeral push. The scraper is a generic fetch-and-persist worker; teaching it about Members, Selections, the cap, or cap-blocked outcomes was rejected as dragging Member-domain policy across a process boundary and splitting one transaction.

8. **Reconciliation closes the at-most-once gap.** `scrape:progress` is PostgreSQL `LISTEN/NOTIFY` — at-most-once. If the server is down (deploy, crash) or its subscriber briefly drops at the moment a terminal event fires, the submission would otherwise stay `pending` forever. On server startup **and** a slow ~60s periodic sweep, the server scans `theater_submissions` in `pending` whose `report_id` joins a terminal `ScrapeReport`, and runs each through the **same** resolution routine (status write → auto-add/cap-block → publish). Idempotency lives in `UPDATE … WHERE status = 'pending'` (rowcount guards the rare notification-vs-reconcile race). Reconciliation re-publishes notices best-effort — they harmlessly drop if the Member is offline, consistent with sub-decision 1. It does **not** persist notices; that would re-introduce the rejected entity.

9. **Connection lifecycle: handshake-only auth; per-Member cap of 5, evict-oldest; multi-device fan-out; live-only on connect.**
   - **Handshake-only auth.** Auth at connect time; once open, the stream stays open until the client closes it, regardless of access-token expiry. Revocation (suspension, password change) takes effect at the next auth boundary — consistent with the codebase's revoke-at-refresh posture (`CONTEXT.md` → Session). The 15s heartbeat reaps half-open pipes. Notices are non-sensitive outcome confirmations, so a stream lingering open after revocation until tab-close is acceptable.
   - **Per-Member concurrent cap of 5, evict-oldest on overrun** (a `const`, not env-tuned). The connect-rate limiter gates frequency, not concurrency; spaced-out connects would otherwise accumulate unbounded live pipes. 5 is invisible to honest users (desktop + phone + laptop + stray tabs) and bounds per-notice fanout to a constant. Evict-oldest means the new tab the Member just opened always wins; their stalest pipe closes.
   - **Multi-device fan-out.** The router keys by `memberId` and pushes to **all** of that Member's live connections.
   - **Live-only on connect.** No backlog frame, no unread count. The page loads its own state via REST (homepage, "Mes soumissions"); SSE carries only events that fire while connected. Direct consequence of sub-decision 1.

## Schema implication

`theater_submissions` stores the **`report_id`** of its `add_theater` ScrapeJob. It is the join key that lets the resolver find the submission from a terminal `ProgressEvent`, and that lets reconciliation cross-reference `ScrapeReport` terminal status.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| A durable notification entity / inbox (read/unread rows, SSE as live layer over it) | Reinvents a notifications table + ack machinery for a SaaS whose only durable outcome surface ("Mes soumissions") already records succeeded/failed durably. A dropped push defers discovery, not loses a fact — the extra durability buys nothing for outcomes that are not time-critical. |
| Email for failed submissions (no inbox; failures also email) | Adds a fourth mailer use case (vs. verification + reset) with its own bounce/complaint/abuse surface; a failed submission is not time-critical (the Member can retry whenever), undermining the case for pushing it off-platform. |
| Reuse `/api/scraper/progress` with a discriminated payload | The scraper stream is unauthenticated global broadcast of Staff telemetry. Per-user routing would have to be bolted on anyway, and either every Member client receives every other Member's notice or the server filters by user — reinventing a separate stream on a shared wire with leakage risk. |
| Derive notices from `scrape:progress` terminal events (no new channel) | Forces the SSE router to speak scraper vocabulary (theaters/dates/counts), own the reportId→submission→member mapping, and translate "what does this failure mean to the Member." Bundles resolution logic into the fanout hot path instead of one resolver publishing a ready Member-shaped notice. |
| The scraper writes submission status (it already writes results to Postgres) | Couples Member-domain lifecycle (submissions, Selection auto-add, the cap transaction) to a microservice whose value is being a generic worker; splits one transaction across a process boundary. |
| Reconcile on-demand only (when "Mes soumissions" is opened) | Leaves restart-time resolutions invisible until the Member happens to look; a submission stuck in `pending` after a deploy is a real, visible bug. |
| Make `scrape:progress` durable (Redis Streams + consumer groups) | Real infrastructure change for a low-volume, non-dollar-sensitive path; reconciliation covers the same gap at a fraction of the cost. |
| `failed` carries the raw scrape error type / HTTP status | Violates the `AGENTS.md` rule against exposing internal error detail; full failure detail already lives on "Mes soumissions." Only a sanitized hint rides the notice. |
| `succeeded_selection_full` as `succeeded` + an `autoAdded: false` flag | Every consumer re-derives "succeeded AND autoAdded===false AND reason==='selection_full'" to branch on a different Member action. A distinct outcome string makes the branch unambiguous. |
| Throttle/dedup as notices | Both resolve synchronously in the `POST` response; they never enter the async resolver and have no terminal event. Making them notices invents a synthetic async channel for what the HTTP response already carries. |
| Close the SSE stream on access-token expiry (tighter revocation) | Raw `EventSource` drops auth headers on auto-reconnect, forcing a hand-rolled reconnect-with-fresh-token loop; revocation-at-boundary is already the codebase posture for refresh tokens. The marginal tightness isn't worth the reconnect churn for non-sensitive notice content. |
| No per-Member connection cap | The connect-rate limiter gates frequency, not concurrency; spaced-out connects accumulate unbounded live pipes (sockets + heartbeat writes) — a cheap accidental or hostile resource drain. |

## Consequences

**Easier:**
- One uniform resolution routine serves both the live path and reconciliation — no second code path for "catch up after downtime."
- The scraper microservice stays domain-agnostic; Member-domain lifecycle stays server-side.
- The SSE router is dumb (subscribe + route by `memberId`), which is trivially testable and reuse of the existing `ProgressListenerSink` seam.
- Email's scope stays minimal (verification + reset), keeping the mailer's bounce/abuse surface bounded.
- Future outcome sources slot in as a new `type` arm on `member:notices` without rewiring router or existing clients.

**Harder:**
- A Member who was offline when their submission resolved gets no push; they must open "Mes soumissions" to see it. Accepted: outcomes are not time-critical.
- The submission's terminal status depends on the server seeing a terminal `ProgressEvent`. If the server is down past one reconciliation interval (~60s after it comes back), a submission can show `pending` longer than the scrape actually took — self-healing, but temporarily stale.
- `theater_submissions.report_id` becomes load-bearing as the join key; a null/missing report_id on a submission row is a real bug (the resolver cannot find it).
- A revoked Member's already-open SSE tab keeps receiving notices until they close it; revocation is not instant on the live-pipe layer (consistent with the rest of the system, but worth knowing).
- The `reason` string on a failed notice is sanitized copy that must be maintained (a translation/localization concern later).

## Cross-references

- CONTEXT.md — *Member data*: **Member notification** (new); *Scraping* / pub-sub vocabulary: **`member:notices`** channel (new).
- ADR 0003 — the submission/throttle model whose outcomes this ADR routes.
- ADR 0004 — Member erasure; this ADR confirms notices are not persisted (erasure removes `theater_submissions` rows and nothing else notification-related).
- issue #2 — *Homepage content model* and *Selection cap* decisions, whose "transient SSE notice" assumption this ADR makes concrete.
