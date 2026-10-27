# 0011. Billing behind a `BillingProvider` port, provider choice deferred

- **Status:** Proposed — the port (decision 1) is approved by the owner; the provider-independent policies (decision 2) are proposed defaults awaiting owner validation in #96.
- **Date:** 2026-10-27

## Context

The freemium epic (#95) approves a paid monthly offer: **3 active Selection Theaters free, 50 premium**, Admin-published immutable tariff versions, grandfathered price for continuous subscriptions, paid-through access on cancellation and an explicit "Choisissez vos 3 cinémas" chooser at expiry. The decision ticket #96 bundled two very different kinds of decision:

1. **Provider-dependent:** which payment provider, fees, currency, tax handling, invoicing, legal billing-record retention, refunds, hosted customer portal.
2. **Provider-independent:** what happens to existing Members above 3 Theaters, how remembered choices behave, failed-payment continuity, cancellation vs. resubscription, paid-account suspension and erasure, out-of-order events.

The project is in R&D. Choosing a provider now would lock commercial and legal terms (merchant-of-record or not, tax liability, retention obligations) before the product is validated. The provider-independent rules, on the other hand, are needed to build #97–#101 at all.

The codebase already has a precedent for this shape: the **Bus port** (`BusProducer` / `BusConsumer`, ADR 0009) keeps role code independent of the transport.

## Decision

**Billing goes behind a server-side `BillingProvider` port. The domain (Subscription, tariff version, Entitlement) lives in PostgreSQL and is the only thing the rest of the code reads. The provider is chosen later (separate issue) and arrives as one more adapter. Until then, a `FakeBillingProvider` drives dev, tests and e2e, and production runs with billing disabled.**

### 1. The port

1. **Domain owns the truth.** Subscription state, the accepted tariff version, the paid-through instant and the derived Entitlement are local rows. Routes, Selection policy and projections never call the provider; only the billing service does.
2. **Port shape** (canonical home `server/src/billing/billing-provider.ts`, shipped with the first billing slice, not in this ADR). It follows the hosted-checkout + webhook model shared by the mainstream providers, merchant-of-record or not, and assumes nothing about who computes tax:
   - `publishTariff(version)` → provider price reference for an immutable tariff version.
   - `createCheckout({ memberRef, tariffVersion, returnUrls, idempotencyKey })` → `{ url, checkoutRef, expiresAt }`.
   - `getSubscription(subscriptionRef)` → normalized snapshot (`status`, `currentPeriodEnd`, `cancelAtPeriodEnd`, price reference).
   - `scheduleCancellation(ref)`, `undoCancellation(ref)`, `cancelNow(ref)`.
   - `verifyEvent(rawBody, headers)` → a normalized **billing event** (`eventId`, `type`, `subscriptionRef`) after signature verification, or a rejection.
3. **Events are notifications, not state.** On every verified event the service re-reads `getSubscription` and applies the snapshot. Processing is idempotent by `eventId`; order no longer matters. A periodic **billing reconciliation** re-reads every non-terminal subscription, so missed deliveries converge.
4. **Adapters.**
   - `FakeBillingProvider`: deterministic, PostgreSQL-backed, with test controls (complete checkout, fail renewal, advance period, emit duplicate/out-of-order events). Refused at startup when `NODE_ENV=production`.
   - `DisabledBillingProvider`: every call reports "billing unavailable"; checkout is never offered.
   - The real provider adapter: delivered by the provider-selection issue.
5. **Billing mode.** One setting, `BILLING_PROVIDER = disabled | fake | <provider>`, default `disabled`. In `disabled` mode the Entitlement policy keeps today's behavior (**every Member may hold 50**), so production is unchanged until the paid launch. In `fake` mode the freemium quotas (3/50) apply and are fully testable.
6. **No dependency** is added by the port or the fake adapter. The real adapter's SDK (if any) needs explicit owner consent.

### 2. Provider-independent policies (proposed defaults)

**Entitlement and Selection**

- **D1 — Entitlement is derived, not swept.** A Member is premium while they hold a non-terminal Subscription whose paid-through instant is in the future. Expiry therefore takes effect server-side at the exact boundary, offline Members included, with no cron and regardless of event delays. The quota is read from this derivation on every write and every personal projection, never from the JWT.
- **D2 — Remembered choices are bounded at 50 in total** (active + remembered). A Member can never store more choices than premium could activate. A free Member at 3 active choices cannot add a fourth as "remembered": the add is rejected with the quota conflict and an upgrade explanation. Remembered choices only arise from expiry or the rollout (D3).
- **D3 — Over-quota Selection is a derived state, not a deactivation.** When the active count exceeds the current quota (after expiry, or at rollout), nothing is deactivated automatically. The personal Homepage projection is replaced by the "Choisissez vos 3 cinémas" chooser until the Member commits a subset of at most 3; the others become remembered. The catalog stays available throughout. Members with ≤ 3 choices never see the chooser.
- **D4 — Races while the chooser is pending.** A Theater hard-deleted from the catalog (ADR 0001) drops out of the choice set by cascade; if that brings the count to ≤ 3, the chooser disappears. A TheaterSubmission that succeeds while the Member is at or above quota is **not** auto-added: the existing `succeeded_selection_full` outcome applies unchanged (the Theater is in the catalog, the Member adds it later). The chooser's commit is one transaction under the existing Member lock and re-validates ownership and quota.
- **D5 — Resubscription reactivates automatically.** On a verified new subscription, every remembered choice becomes active again. D2 guarantees they all fit within 50. No re-scrape is needed: they reference catalog Theaters.
- **D6 — Rollout to existing Members.** The 3-Theater limit starts applying only when production switches from `disabled` to a real provider (the paid launch). At that moment, Members above 3 are in the D3 over-quota state: all choices kept, chooser at next visit, the option to subscribe available on the same screen. No free premium grant, no silent removal. An in-app notice before the switch is part of the launch checklist.

**Subscription lifecycle**

- **D7 — Initial payment failure** creates no Subscription and grants nothing. The checkout can be retried.
- **D8 — Renewal failure.** Premium ends at the paid-through boundary (no locally granted grace period); the Subscription becomes `past_due` while the provider retries for a **recovery window of at most 14 days**. A payment recovered within the window restores premium from that payment, and the Subscription is continuous: the grandfathered price is kept. When the window ends without payment, the Subscription ends and continuity is lost; any later subscription takes the current tariff.
- **D9 — Cancellation is always at period end.** Undoing it before the boundary resumes the same Subscription (same price). After the boundary, only a new Subscription is possible, at the current tariff (#101).
- **D10 — One open purchase per Member.** At most one non-terminal Subscription and one unexpired checkout per Member; a second checkout returns the existing one (idempotency key per Member + tariff version) or a 409 if already subscribed.
- **D11 — Tariff published during checkout.** A checkout pins the tariff version shown to the Member when it was created. It completes at that version, because that is the amount the Member authorized. Checkouts expire within 24 hours, so a retired version cannot linger. A retired version can never be chosen for a new checkout.

**Paid-account safety**

- **D12 — Suspension schedules cancellation at period end.** A suspended Member cannot log in, so they must not keep paying for a service they cannot use. The Admin suspension action shows this consequence explicitly; no refund for the current period. Reinstatement before the boundary undoes the cancellation (continuity and price kept); after the boundary the Member is free and may resubscribe at the current tariff. Billing state and Member status remain two separate state machines.
- **D13 — Erasure cancels immediately, durably.** Self or Admin erasure (ADR 0004) commits locally first and is never blocked by provider downtime. The same transaction writes a **billing outbox** row holding only the opaque provider subscription reference; a retrying job calls `cancelNow` until the provider confirms, then deletes the row. The outbox row is the only local residue and contains no personal data.
- **D14 — Late events never recreate anything.** An event whose subscription reference no longer maps to a local Subscription (erased Member, ended subscription) is acknowledged, logged and ignored. A new Subscription always has a new reference; an old reference can never reactivate premium.
- **D15 — Export** includes active and remembered choices, the Subscription state, paid-through date and accepted tariff version (amount, currency). Never provider secrets, payment method details or another Member's data.

### 3. Explicitly deferred to the provider-selection issue

Provider choice and fees; launch currency and tax presentation; invoicing and the legally required billing-record retention (scope, duration, responsible party); refund of the unused period on erasure (default until decided: none, stated in the erasure confirmation, to be confirmed legally); how a suspended Member reaches billing self-service (hosted customer portal or support); the provider's actual retry schedule within D8's 14-day cap.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Choose a provider now (e.g. Stripe) | Locks commercial and legal terms during R&D; the port costs little and keeps the choice open. |
| Let the provider be the source of truth (query it on each request) | Couples every Selection write and projection to provider latency and availability; no offline-safe expiry. |
| Apply events in arrival order | Providers do not guarantee order; fetch-on-event plus reconciliation converges regardless. |
| Persist an "inactive" flag at expiry via a sweep | Needs a cron, races with late events and can deactivate choices the Member was about to keep. Derived over-quota state (D3) needs neither. |
| Unlimited remembered choices | Unbounded storage and a resubscription that cannot reactivate everything within 50. |
| Grandfather existing Members as premium at rollout | #95 forbids assuming a free premium grant. |
| Suspension leaves billing untouched | A Member who cannot log in keeps being charged with no way to stop it. |
| Erasure waits for the provider to confirm cancellation | Provider downtime would block an RGPD right. The outbox decouples them. |

## Consequences

- `CONTEXT.md` gains a **Billing** section (Entitlement, Subscription, tariff version, `BillingProvider` port, billing event, billing outbox) and Selection distinguishes **active** and **remembered** choices and the **over-quota** state. All of it is marked planned until shipped.
- **ADR 0004** — the "no financial data" assumption still holds locally: invoices live at the provider, local billing rows cascade on erasure, only the opaque outbox row survives until the cancellation is confirmed. Legal invoice retention is the provider issue's question.
- **ADR 0007** — billing does not introduce an owner entity. Publishing a tariff is a peer Admin action with actor/time provenance (#98); provider credentials are deployment configuration, not a person.
- #97 can start now in `fake` mode: the Entitlement policy is the only new seam, and production keeps the 50 limit in `disabled` mode. #98–#101 are buildable and testable end to end against `FakeBillingProvider`; only the paid launch waits for the real adapter.
- `disabled` → real provider is a one-way launch step that triggers D6 for existing Members.

## Cross-references

- Issues #95 (epic), #96 (this decision), #97–#102 (delivery slices)
- ADR 0001 (hard-deleted Theaters), ADR 0003 (submission throttle), ADR 0004 (erasure and export), ADR 0005 (notification outcomes, `succeeded_selection_full`), ADR 0007 (no owner entity), ADR 0009 (Bus port precedent)
- `server/src/services/selection-service.ts` (`MAX_SELECTION_SIZE`, the seam #97 replaces), `server/src/services/submission-resolver.ts`
