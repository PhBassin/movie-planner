# CONTEXT

Domain glossary for Movie Planner. Devoid of implementation details — this is what things *mean*, not how they're stored. Movie Planner is a permanently diverged project derived from an inherited cinema codebase (see [ADR 0008](docs/adr/0008-fork-monolith-single-db.md) for the fork and permanent-divergence decision); it inherits the shared cinema model below (Theater, Showtime, WeeklyProgram, Source, and the Scraping section) verbatim and extends it with the SaaS concepts that follow.

## People & roles

### User

The generic authenticated identity. Every actor who can log in — whether Staff or a Member — is one User, held in a single shared credential store (today the `users` table). "User" is the identity; the **Role** attached to that User determines what kind of actor it is and what it may do. A User has **exactly one Role** (the schema is single-role); a person who needs to act as both Staff and Member simply holds two separate User accounts.

A User authenticates via a **Session** (see Authentication). One User holds many Sessions at once (one per device); changing the password — by `changePassword` or by email reset (ADR 0006) — revokes all of them.

**What a User is *not*:**
- Not automatically **Staff**. Most Users are Members; Staff are the minority who operate the platform.
- Not a **Member** specifically. A Member is a User *with the `member` role*. "User" is the superclass, "Member" is one specialization.

### Member

A User whose role is `member` — the cinema-goer, the consumer the SaaS exists to serve. A Member is defined by four properties that distinguish it from Staff:

1. **Self-registration by email.** A Member creates their own account through a public sign-up route (`POST /api/auth/signup` in `server/src/routes/auth.ts`), identifying by **email** and a password. Staff, by contrast, identify by **username** and are created by an Admin (the existing `POST /auth/register` flow, which is staff-only). A freshly registered Member is **unverified**. The login path (`AuthService.login`) accepts either identifier: an identifier containing `@` is looked up by email, everything else by username.
2. **Email verification.** A Member becomes **verified** by confirming ownership of their email — clicking the link the **Mailer** sent to their address (see *Mailer* under Authentication), which flips `email_verified_at` and moves the Member `unverified → active`. Verification splits the two Member powers: **selecting** from the catalog is open to any Member; **submitting** a new cinema is open only to a *verified* Member. Verification is the abuse control that complements the per-Member scrape throttle — see TheaterSubmission. It is load-bearing: there is no bypass flag.
3. **No administrative reach.** A Member holds none of the scraper / settings / users / system permissions. A Member can read the shared cinema catalog (Theaters, Movies, Showtimes) and act only on their own data.
4. **Personal data.** A Member owns a **Selection** of Theaters and an **Appearance** (light/dark) for their homepage — concepts Staff do not have.

The Member is the reason movie-planner exists; Staff exist to operate it for them.

**Lifecycle.** A Member moves through a small state machine (the `users.status` discriminator: `unverified | active | suspended` — "deleted" = row removed):
- **unverified** — just registered, email not yet confirmed. May log in, browse, and build a Selection, but cannot submit (see TheaterSubmission).
- **verified** — email confirmed; enters **active** by default.
- **active** — verified and not suspended; the steady state. May submit.
- **suspended** — an Admin revoked access (the reactive abuse control). All Sessions are revoked (the Member cannot log in) and submissions are blocked, but the Selection and Appearance persist for possible reinstatement. `suspended ↔ active` is reversible.
- **deleted** — the terminal state; the account and its Member-owned data are removed (see **Member erasure**). Reachable by self-deletion from `unverified` or `active`, or by an Admin from any state (a suspended Member is deleted Admin-side only). Irreversible.

`unverified` and `suspended` both block submission; only `suspended` also blocks login (an unverified Member may still log in to read and curate their Selection). The suspension check lives in `AuthService.login` and runs only after the password has matched, so the failure ordering cannot be used to enumerate suspended accounts.

The Member's own profile is exposed at `GET /api/me` (`server/src/routes/me.ts` — email, lifecycle status, verification state, appearance); it is the seam the Selection and Appearance tickets extend.

**What a Member is *not*:**
- Not **Staff**. A Member cannot trigger a scrape, cannot manage other Users, cannot touch admin Settings. Since a User has exactly one Role, a person who is both a Member and Staff does so across two accounts — never one Member that is also Staff.
- Not a **Subscriber**. "Subscriber" implies a paid / recurring relationship. movie-planner has no billing model as of this writing; "Member" is deliberately neutral about payment so the term does not lie ahead of the feature.
- Not the **source** of Theaters. A Member selects from — or requests additions to — the shared catalog that Staff curate and scrape. A Member does not own Theater rows; see Selection.

### Staff

The collective term for the Users who **operate** the platform, as opposed to those who merely use it. Staff = the union of the `admin` and `operator` roles. "Staff" exists in the glossary primarily to draw a clean line against **Member**; it is not itself a single role.

- **Admin** (`admin` role, system) — full access via the hardcoded permission bypass (`is_system_role === true && role_name === 'admin'`, enforced at `middleware/auth.ts:isAdminUser`). The French **"admin général"** is a *role description* for any holder of this role — not a distinct entity, sub-role, or flagged user. There is no singular owner/primary Admin in the model; multiple peer Admins are supported (a backup Admin is recommended), all with identical powers. An Admin owns the scraping pipeline, the catalog curation, the user roster, and every setting — all as peer Staff actions, no power reserved to a singular admin. See ADR 0007. The *first* admin comes into existence through the **Bootstrap admin** (see Database initialization), not via the staff-creation route.
- **Operator** (`operator` role) — a scoped Staff role: may trigger scrapes and manage Theaters and reports, but not users or settings.

Staff are created by an Admin (no self-registration), authenticate through the same Session mechanism as Members, and hold their permissions via the role-based permission model (the RBAC).

**What Staff is *not*:**
- Not a **Member**. Staff do not have a Selection or an Appearance of their own in the SaaS sense, even though they share the same User identity and Session mechanism.
- Not a **tenant owner**. movie-planner is a single shared catalog, not per-org data. There is no "tenant" entity; "Staff" must not be read as "the staff of one tenant."

### Visitor

An anonymous, unauthenticated reader of the public catalog. A Visitor is **not a User** — they have no identity, no credentials, and no row anywhere; "Visitor" names the *absence* of a Session, not a kind of account. A Visitor may browse the shared catalog (Theaters, Movies, Showtimes) read-only, through the public routes that exist today.

A Visitor becomes a Member by registering. Until then they have no Selection, no Appearance, and no homepage — those are exactly the perks that make signing up worthwhile.

**What a Visitor is *not*:**
- Not a **User**. A Visitor has no User identity and no Session. Where the model needs "anyone, authenticated or not," it speaks of "a Visitor or a User"; the two are disjoint.
- Not an **unverified Member**. An unverified Member is *authenticated* and owns a Selection and an Appearance; a Visitor is not authenticated at all.
- Not able to **submit**. Submission is gated behind a verified Member (see TheaterSubmission); a Visitor can neither build a Selection nor submit.

## Member data

### Selection

A Member's personal set of Theaters — the Theaters whose Showtimes that Member sees on their homepage. A Selection is a *relationship* between one Member and N Theaters, **not a copy** of those Theaters: each Theater row lives exactly once in the shared catalog, and the Selection references it.

- **Adding an existing Theater to a Selection does not scrape.** The data is already shared; this is a private, side-effect-free mutation of the Member's homepage.
- **Removing a Theater from a Selection is private.** It drops the Theater from that Member's homepage only; it never deletes the Theater from the catalog.
- **Selection size is capped at 50 Theaters.** The cap counts only persisted Selection relationships; provisioning Theaters and pending TheaterSubmissions do not count. A new add at the cap is rejected with a conflict, while adding an already-selected Theater remains idempotent.

**What a Selection is *not*:**
- Not a **copy** of Theater data. The shared catalog is the single source of truth; a Selection only points at rows.
- Not the **catalog**. A Selection is per-Member and private; the catalog is shared and Staff-curated.
- Not a **TheaterSubmission**. Selecting an existing Theater is instant and scrape-free; introducing a Theater that is *not yet* in the catalog is a TheaterSubmission (below).

### TheaterSubmission

A Member's act of introducing a Theater that is **not yet in the shared catalog**, by providing its source URL (e.g. an AlloCiné theater page). A TheaterSubmission triggers an **immediate** `add_theater` ScrapeJob — the one-shot scrape — **with no admin approval step**. **It requires a verified Member**: an unverified Member may browse the catalog and build a Selection, but cannot submit a new cinema — verification is the abuse gate that complements the per-Member throttle below. This is the deliberate, sole exception to "scrapping is managed by Staff" (see the *Two origins of a scrape* note under Scraping).

Two safeguards bound a TheaterSubmission, both domain-level policies (their thresholds are configuration, not glossary material):
- **Deduplication.** If the submitted URL matches an existing Theater, no new Theater is created and no scrape fires — the submission degrades to adding that Theater to the submitter's Selection.
- **Per-Member throttle.** Submissions of *new* Theaters are rate-limited per Member, to prevent abuse (scrape cost, exhaustion of the upstream source → 429 cascades).

**Lifecycle.** A TheaterSubmission is asynchronous: it is *submitted* the moment the URL is accepted, then *pending* while its `add_theater` scrape runs, and it ends in exactly one of:
- **succeeded** — the scrape populated the Theater. **On success, the Theater is automatically added to the submitter's Selection.** The Member who asked for the cinema gets it on their homepage; one gesture, one outcome.
- **failed** — the scrape produced no data. **A failed submission never reaches the submitter's Selection**; the failure is surfaced to the Member instead. The Theater row may remain in *provisioning* (see Theater lifecycle), and a later scrape or re-submission can still succeed.

This makes the link to Selection explicit: a *successful* TheaterSubmission terminates in the submitter's Selection; adding an *existing* Theater to a Selection skips the submission entirely.

**What a TheaterSubmission is *not*:**
- Not an **admin-gated request**. There is no approval queue and no waiting state imposed by Staff; the scrape fires on submission (subject only to dedup and throttle).
- Not a **Selection**. A TheaterSubmission mutates the *shared catalog* and has a side-effect (a scrape); a Selection add is private and side-effect-free.
- Not a **ScrapeJob**. The TheaterSubmission is the Member-originated act; the `add_theater` ScrapeJob is the work unit it produces on the Postgres queue.

### Appearance

A Member's personal look for their homepage — concretely, a **light/dark mode** choice. Appearance is per-Member (a preferences row keyed by Member, alongside the Selection) and is the *only* visual control a Member owns.

Appearance **adapts** the Branding; it does not fight it. A dark Appearance reuses the admin's brand colors on a dark surface. A Member cannot choose custom colors, fonts, a logo, or a site name — those are Branding.

**What Appearance is *not*:**
- Not **Branding**. Branding is admin-owned and instance-wide (see below); Appearance is Member-owned and personal. They never write to the same place.
- Not a **Theme**. "Theme" is a **retired word** in this glossary: the codebase used it for the admin white-label (`/api/theme.css`, `theme-generator.ts`, `app_settings`), while product language used it for the per-Member look. To kill the collision, the old "theme" is split into **Branding** (admin) and **Appearance** (member), and the bare word is banned. New code and docs must pick one of the two.
- Not a **per-Member override of colors/fonts**. A Member who could recolor the instance would defeat Branding; Appearance is light/dark only.

### Homepage

A Member's personalized root view — the page an authenticated Member lands on. The Homepage is the rendering of the Member's **Selection** as this week's Showtimes: every **Movie** playing at one or more of the selected Theaters, each shown with only the selected Theaters that program it. The Homepage is the personalization that is the point of the Member account.

The root route is **polymorphic by auth state**: an authenticated Member's root is the Homepage; a **Visitor's** root is the full shared catalog (the free-tier demonstrator that motivates sign-up), shown with a sign-up prompt. An **unverified Member** sees the same Homepage as an active one — Selection and all — with a verification reminder; only submission is withheld. The full catalog remains browsable to everyone on a separate route, independent of the Homepage.

The Homepage carries a **New section** ("Nouveautés cette semaine"): the subset of Movies that are **newly programmed** at one or more of the Member's selected Theaters this week — driven by `WeeklyProgram.is_new_this_week`. The New section is a **partition**, not a highlight: a Movie in the New section appears *only* there, and the rest of the Homepage shows the continuing titles; each Movie appears on the Homepage exactly once. The New section is a week-level concept and is not shown when the view is narrowed to a single date.

The homepage's Selection movie projection is the wire shape returned by
`GET /api/me/selection/movies` (`server/src/routes/selection.ts`): a Movie with
only its selected active Theaters, each carrying its showtimes and optional
`isNewThisWeek` marker. The movie-level marker is true when any included
Theater is newly programmed. `GET /api/me/selection/movies?date=...` uses the
same projection for one date and omits the week-level New section in the UI.

**What a Homepage is not:**
- Not the **catalog**. The catalog is shared and complete; the Homepage is personal and Selection-scoped. A non-selected Theater never appears on a Member's Homepage.
- Not a **page for Visitors**. A Visitor has no Homepage; they see the catalog. The Homepage is one of the perks of becoming a Member.
- Not a **submission status surface**. Pending or failed TheaterSubmissions are not shown on the Homepage; only resolved, active Selection content renders. Submission status lives elsewhere; the Homepage may carry only a transient **Member notification** of a submission's success or failure.

### Member notification

A transient, best-effort push from the server to a Member's open SSE connection, telling them that a **TheaterSubmission** of theirs just resolved. A Member notification is the *ephemeral* counterpart to the durable outcome record: the **TheaterSubmission** row (surfaced on "Mes soumissions") is the source of truth that persists; the notification is the "it just happened" nudge for a Member who happens to be online. The reserved PostgreSQL `member:notices` `LISTEN/NOTIFY` channel (`NOTIFICATION_CHANNELS.memberNotices`) is the future transport extension point; it has no producers or callers yet. See ADR 0005 for the full model.

- **Not an entity.** A notification carries no id, has no read/unread state, and is never persisted. It is reserved for the PostgreSQL `member:notices` `LISTEN/NOTIFY` channel (a peer of `scrape:progress` and `scraper:schedule:changed`, but Member-domain rather than scraping-domain), to be routed by `member_id` to the Member's live SSE connections on `/api/me/notifications` once callers exist. A Member who was offline when a notification fired simply sees the outcome on "Mes soumissions" next visit — nothing is lost, because the submission row already recorded it durably.
- **Three outcomes.** A notification fires for exactly the three async resolution outcomes of a TheaterSubmission: `succeeded`, `succeeded_selection_full` (the scrape worked but the Selection was full, so the cinema was not auto-added — a distinct outcome, since the Member must free a slot and add it from the catalog), and `failed`. **Throttle rejection and dedup downgrade are not notifications** — both resolve synchronously in the `POST` submission response.
- **Auth-only email.** Notifications never go to email. The mailer (verification, password-reset) is reserved for auth; a submission outcome is not time-critical enough to push off-platform.
- **Handshake-only auth, per-Member fan-out.** The SSE stream authenticates at connect time and stays open until the client closes it; revocation (suspension, password change) takes effect at the next auth boundary, as elsewhere. The server fans each notification to all of a Member's live connections (multi-device), up to a small per-Member concurrent cap.

**What a Member notification is not:**
- Not an **inbox**. There is no notifications table, no unread count, no replay-on-connect. Durability lives in "Mes soumissions"; the notification is the live push only.
- Not **email**. Email is for auth (verification, password-reset); submission outcomes ride the transient channel, not the mailbox.
- Not the **Homepage**. A notification is a transient nudge; the Homepage is the persistent Selection view. A notification may prompt a Member to look at their Homepage, but the Homepage is fed by the Selection, not by notifications.
- Not a **ProgressEvent**. ProgressEvents are scraper telemetry on `scrape:progress` (Staff/operational); Member notifications are Member-domain outcomes on `member:notices`. The two channels are separate and never share a wire.

### Member erasure

The act of removing a Member's identity and Member-owned data from movie-planner — the **RGPD right to erasure** (Article 17) made operational. Member erasure is **self-service**: a Member may erase themselves without filing a ticket. Erasure is **immediate, hard, and terminal** — a single irreversible transition into the `deleted` state, with no soft-delete, grace window, or reactivation. It is gated by **password re-entry** (the Member's current password, verified server-side), because the Session's CSRF token alone cannot defend against a hijacked Session or a shared device.

**What erasure removes.** The Member's identity and credentials, all their **Sessions** (via the existing refresh-token cascade), their **Selection**, their **Appearance**, and their **TheaterSubmission** rows. Concretely, the Member-owned tables (`member_selections`, `member_preferences`, `theater_submissions`) cascade on the Member's id.

**What erasure does not remove.** A **Theater** — whether `active` or still `provisioning` — that the Member introduced into the shared catalog. The submitter is not the owner (a Member does not own Theater rows); the catalog is single-source and Staff-curated, and a Member's departure must not change what cinemas exist. A failed submission's stale `provisioning` Theater therefore lingers until Staff clean it up operationally; that cleanup is a separate Staff concern, not coupled to erasure.

**Suspended Members.** A suspended Member cannot log in (only `suspended` blocks login), so cannot reach the self-service erasure path; their erasure is **Admin-mediated** through the existing Admin deletion path. This is deliberate: a Member suspended for submission abuse would otherwise erase their TheaterSubmission history — the evidence of the abuse. The right is routed through Staff, not refused (Article 17(3)(e)/(b) covers the holding period during investigation).

**Re-registration.** Because erasure is clean (no retained email hash or tombstone), the email is immediately reusable and a former Member may re-register — which also resets their **submission throttle** (see ADR 0003). This bypass is accepted on the threat model: the payoff is near-zero, re-registration re-imposes verification friction, and the upstream source's rate limiting is the hard backstop.

**What Member erasure is not:**
- Not **soft-delete**. There is no `deleted_at`, no recoverable window, no scheduled purge. "Deleted" means gone now.
- Not **theater deletion**. Erasing a Member never removes a Theater; the two have separate cascade targets and separate owners (ADR 0001).
- Not **Admin-only**. The inherited Admin deletion path remains (and is the only path for suspended Members), but an active or unverified Member can self-serve.

### Member data export

A read-only JSON document of a Member's personal data — the **RGPD right to data portability** (Article 20) made operational. The export contains the Member's account (`email`, `created_at`, status — never the password hash), their **Selection**, their **Appearance**, and their full **TheaterSubmission** history (each submission's url, status, timestamps, and resolved `theater_id`). It is the natural pair to Member erasure: "here is your data" before "here is the door."

The export is **Session-gated and ungated otherwise** — it is non-destructive, so it requires no password re-entry (unlike erasure). The submission history is included because submissions are the Member's own acts and are erased on deletion, making the export the only moment those records remain visible to them.

**What Member data export is not:**
- Not an **admin/audit report**. It is the Member's own data, served to the Member; it is not a Staff-facing dossier.
- Not a **re-import / backup format**. It satisfies portability (a structured, machine-readable copy of the data the Member provided); it is not designed to seed another account.
- Not a **substitute for erasure**. A Member who exports has not been erased; the two are independent operations.

## Branding

### Branding

The instance-wide visual identity, owned by Staff (specifically the Admin). Branding is the canonical name for what the codebase historically called "white-label" and loosely "theme": the singleton `app_settings` row, the admin Settings panel (General, Colors, Typography, Footer, Email), and the generated `/api/theme.css`. It defines the platform's name, colors, typography, logo, favicon, and footer — **once, for every visitor.**

**What Branding is *not*:**
- Not **Appearance**. Branding is admin and instance-wide; Appearance is per-Member light/dark. A Member's Appearance adapts Branding; it never overrides its colors or fonts.
- Not a **Theme**. Retired word — see Appearance.
- Not per-Member. There is exactly one Branding for the whole instance; there is no per-tenant or per-Member branding.

## Core entities

### Theater

A cinema venue that screens movies. One Theater is one physical venue, identified by a stable external id.

A Theater has:
- a **name** (which may begin with a brand prefix such as "UGC" or "Pathé")
- an **address**, a city, a postal code
- an **image** and a **booking URL**
- exactly one **Source** it is scraped from (today, `'allocine'` for nearly all rows — see the Source concept below)

The number of screens in a venue is **not a domain attribute** of a Theater here. It was historically collected and displayed, but has been removed — see ADR 0002.

**What a Theater is *not*:**
- A Theater is not a brand. "UGC" is a name prefix; "UGC Bercy" is one Theater. There is no `Brand` entity in this model.
- A Theater is not a data source. The source website is a property of a Theater, not the other way around.
- A Theater is not a count of screens. The number of physical screens in a venue is not a domain attribute here — see ADR 0002.

**Lifecycle:** A Theater is created the moment a TheaterSubmission (or a Staff add) inserts its row. From there it moves through two states:
- **Provisioning** — the row exists but its first `add_theater` scrape has not completed. Metadata is minimal (a placeholder name), and the Theater is not yet on the recurring scrape schedule. A provisioning Theater is **not shown to Members** as a real cinema.
- **Active** — first scrape completed, metadata populated, scraped on the recurring schedule.

Deletion removes the row and all history via `ON DELETE CASCADE`; there is no soft-delete or closed-state concept. Retiring a Theater means deleting the row, and all its historical Showtimes and WeeklyPrograms are removed with it. See ADR 0001 for the rationale.

### Showtime

One specific scheduled showing of a Movie at a Theater. A Showtime has a date, a start time, a combined `datetime_iso`, a format (e.g. IMAX, 3D), and a list of "experiences" (e.g. Dolby Atmos, 4DX).

**"Showtimes" (plural) is not a separate concept.** It is the plural of Showtime — used for the table name, query results, and UI page names. The domain has one concept: a Showtime.

**What a Showtime is *not*:**
- Not a **Screening**. The codebase has no entity called Screening. The word appears in docs only as an adjective ("screening schedules"). The canonical term is **Showtime**.
- Not a **Session**. "Session" is reserved for user-auth (cookie sessions, SSE subscriber sessions) — see the *Session* entry under Authentication. Using "session" for a movie showing will collide.
- Not a **Séance**. The table was historically named `seances` (French) and was deliberately renamed to `showtimes` (English) — see `docs/project/white-label-plan.md:580, 596`. The team chose the English word. French comments still say "séance" but that's a comment-language choice, not a domain concept.

### WeeklyProgram

A week-level programming fact: "Movie X is programmed at Theater Y in week W." A WeeklyProgram has a `week_start` date, an `is_new_this_week` flag (true if the movie was newly added to that Theater's program that week), and a `scraped_at` timestamp (when this fact was last confirmed).

**WeeklyProgram is a first-class concept, not derived from Showtimes.** The two entities overlap on `(theater_id, movie_id, week_start)` but carry different facts:
- A Showtime answers *"at what times does this movie screen at this Theater?"*
- A WeeklyProgram answers *"is this movie programmed at this Theater this week, and is it new?"*

The `is_new_this_week` flag cannot be derived from current `showtimes` alone — it requires comparing against prior weeks. The `scraped_at` timestamp records when the programming fact was last confirmed, which is independent of when individual Showtimes were last scraped. The `is_new_this_week` flag is the driver of a Member's Homepage **New section** (see Member data): a Movie newly programmed at one or more of a Member's selected Theaters that week is what the New section surfaces.

### Source

An external website that publishes showtime data and from which one or more Theaters are scraped. Examples today: `'allocine'`. A Source is an **identity** (a stable string), not a parser.

**Source and Theater:** every Theater has exactly one Source. Today, one Source is used to scrape many Theaters; the data model does not require a Source to be 1:1 with Theaters.

**What a Source is *not*:**
- Not a **Strategy**. A Strategy is the *code* that knows how to scrape a given Source — the parser/adapter. Source is the identity; Strategy is the implementation. The two are 1:1 in the current code, but they are distinct concepts (the strategy can change while the source name stays the same; the source name identifies *what* is being scraped, the strategy identifies *how*).
- Not a **Parser**. A Parser is a helper function inside a Strategy that handles a specific data shape (an HTML page, a JSON blob). Parsers are implementation detail of Strategies, not domain entities.

**Practical note:** "Add support for a new Source" = add a new Strategy whose `sourceName` matches a new Source string. The Source identity is what Theater rows reference; the Strategy is what the scraper wires up.

## Scraping

**Two origins of a scrape.** Scraping in movie-planner has exactly two origins, and they belong to different actors:
1. **Operational scraping — owned by Staff.** The scheduled/periodic runs (the `scrape_schedules` rows), full re-scrapes, Resume of incomplete runs, and all monitoring. This is what "scrapping is managed by the admin" means.
2. **Add-triggered one-shot — owned by a Member via a TheaterSubmission.** When a Member submits a new Theater URL, an immediate `add_theater` ScrapeJob fires with no Staff involvement (subject only to dedup and the per-Member throttle). This is the one exception to "Staff own scraping," and it exists so that adding a cinema is never blocked on an admin being available.

Both origins produce the same artifacts downstream (ScrapeReport, ScrapeAttempts, ProgressEvents); they differ only in who originates them and whether they recur.

The terms in this section name the recurring concepts of one end-to-end scrape run. A run is initiated by a ScrapeJob on the Postgres queue, executed by the worker role which emits ProgressEvents during the run, and tracked in the database via a ScrapeReport (the run-level record) holding many ScrapeAttempts (one per `(theater, date)` pair). One concept — Resume — lets a stopped/incomplete run be re-issued scoped to only its unfinished attempts. RateLimitConfig governs the API-side request throttling that protects AlloCiné responses from being overwhelmed.

### ScrapeAttempt

One per-`(theater, date)` outcome inside a ScrapeReport. A ScrapeAttempt is the unit of "did we get data for this theater on this date for this run?". Lives at `server/src/db/scrape-attempt-queries.ts:4` and is also persisted under that name in the scraper's local DB copy.

A ScrapeAttempt has a **status** drawn from a small finite state machine. Two creation paths exist; once created, the row is terminal (a Resume creates a NEW ScrapeAttempt on a fresh `report_id`, it does not re-open an old one):

- **Created as `pending`** at the moment a date is about to be scraped. Transitions:
  - `pending → success` — the date's scrape returned data; counts `movies_scraped` and `showtimes_scraped` are stamped.
  - `pending → failed` — a non-rate-limit error (parse, 5xx, network, timeout); `error_type`, `error_message`, `http_status_code` are stamped.
  - `pending → rate_limited` — a `RateLimitError` (HTTP 429 from the source); the cascade described below fires.
- **Created as `not_attempted` directly**, without going through `pending`. The triggers are inside `handleRateLimit` (`scraper/src/scraper/index.ts:462`):
  - For the current theater, the remaining dates *after* the rate-limited one.
  - For every theater processed *after* the rate-limited one (the "cascade"), every planned date.

Terminal states: `success`, `failed`, `rate_limited`, `not_attempted`. There is no `pending → not_attempted` and no transitions out of any terminal state.

**What a ScrapeAttempt is *not*:**
- Not the **run-level** record of a scrape. One ScrapeReport holds many ScrapeAttempts; see `getScrapeAttemptsByReport` at `server/src/db/scrape-attempt-queries.ts:112`.
- Not the **rate-limit configuration**. A `rate_limited` attempt is one *instance* of being throttled; see `RateLimitConfig` below for the configuration.
- Not the **dataset of what was scraped**. A `success` attempt does not hold the movies and showtimes themselves — those are written straight to the main tables; the attempt holds only counts and timestamps.

### ScrapeSummary

The structured result of one scrape run, attached to the final `'completed'` (or `'failed'`) ProgressEvent. Carries run-level counters (theaters / movies / showtimes / dates / duration / per-error list) and a final `status`. **Canonical home is `packages/scraper-protocol/src/events.ts`.** The server (`server/src/services/progress-tracker.ts`) and the scraper (`scraper/src/types/scraper.ts`) re-export it from the protocol package; the duplicate declarations are gone.

### ScrapeRun

The scraper-internal runtime object that drives one end-to-end scrape run. A `ScrapeRun` owns the mutable run state — the `ScrapeSummary` it builds up, the `ScrapeConfig` read once at construction, and the optional progress publisher — and exposes the run as a deep module: coherent operations (`prepare`, `runTheater`, `runDate`, `loadAvailability`, `filterDates`, `finalize`) plus controlled mutators (`recordError`, `incrementSuccessfulTheater`, …). It lives at `scraper/src/scraper/scrape-run.ts`. The thin `runScraper` entry in `scraper/src/scraper/index.ts` constructs a `ScrapeRun` and drives it; it is not consumed outside the worker role.

**What a ScrapeRun is *not*:**
- Not a **Session**. "Session" is reserved for user-auth (cookie sessions, SSE subscriber sessions) — see the *Session* entry under Authentication. A ScrapeRun is a single scrape execution, not a user/auth session.
- Not a **ScrapeReport**. A ScrapeReport is the persisted, server-side run-level record in the database. A ScrapeRun is the transient scraper-process object whose final `ScrapeSummary` feeds the `'completed'` ProgressEvent; it is not written to a row.
- Not a **ScrapeSummary**. The ScrapeSummary is the structured result (counts + status) attached to the final event. A ScrapeRun *produces* a ScrapeSummary; it is not itself the summary.

### Resume

Re-issuing a stopped or incomplete scrape scoped to only the (theater, date) pairs that did not reach `success`. The UI exposes it as the "Reprendre le scraping" button (`client/src/pages/ReportsPage/ReportRateLimitedNotice.tsx:38`) wired through the `resume` function (`client/src/pages/ReportsPage.tsx:90`); the API path is `POST /api/scraper/resume/:reportId` (`server/src/routes/scraper.ts:85`); the scraper-runtime flag is `options.resumeMode: true` and the payload list is `options.pendingAttempts: Array<{ theater_id; date }>` (`scraper/src/scraper/index.ts:146-147`).

A Resume always produces a **new** ScrapeReport with `parent_report_id` set to the original. The server reads `getPendingScrapeAttempts(parentReportId)` (any attempt in `failed | rate_limited | not_attempted`), translates them into the `pendingAttempts` payload, and publishes a new ScrapeJob in resume mode. `filterDatesForScrape` then narrows each theater's plan to only its pending dates.

**Resume is not free retry.** It does not re-scrape dates that already reached `success` in the parent report. It is also not idempotent on the receiving theater: a date that was `not_attempted` in the parent becomes a brand new `pending` → `success/failed/...` sequence under the new report id.

### ScrapeJob

A unit of work submitted by the server through the `BusProducer` to the Postgres `scrape_jobs` queue for the worker role to execute. The worker atomically claims the oldest row with `FOR UPDATE SKIP LOCKED`; the row is deleted at claim time, so terminal failures are not retried. A ScrapeJob is a **discriminated union**: `{ type: 'scrape' }` for a standard run and `{ type: 'add_theater' }` for fetching metadata for a new AlloCiné URL and scraping everything it publishes. Every job carries a `reportId`.

**Canonical home is `packages/scraper-protocol/src/jobs.ts`.** The queue implementation is `server/src/services/pg-job-queue.ts` and `scraper/src/bus/pg-job-consumer.ts`; the pub/sub fan-outs run on `LISTEN/NOTIFY` via `PostgresNotificationBus` (`server/src/services/postgres-notification-bus.ts`, `scraper/src/bus/postgres-notification-bus.ts`). `parseJob` validates the discriminated union at the parse boundary — the safety net that catches any future drift.

The `ScrapeJobScrape.options` shape now has a single canonical declaration that includes `resumeMode` and `pendingAttempts` for the Resume case. Both sides of the wire agree, and the scraper's local `ScrapeOptions` (`scraper/src/scraper/index.ts:140`) is now a scraper-internal type that no longer needs to redeclare wire fields.

### ProgressEvent

A discrete event published by the scraper onto the PostgreSQL `scrape:progress` `LISTEN/NOTIFY` channel during a run, fanned out by the server to connected SSE clients. The union covers run start (`started`), per-theater and per-date lifecycle (`theater_started`, `date_started`, `date_completed`, `date_failed`, `date_stale`), per-movie lifecycle (`movie_started`, `movie_completed`, `movie_failed`), run completion (`completed` with the ScrapeSummary), and fatal failure (`failed`). Delivery is ephemeral: a notification reaches only the SSE clients connected at the moment it fires, and no historical event is replayed to a late subscriber.

**Canonical home is `packages/scraper-protocol/src/events.ts`.** The scraper (`scraper/src/types/scraper.ts`) and the server (`server/src/services/progress-tracker.ts`) re-export it from the protocol package.

### ScheduleChangeEvent

A fire-and-forget `LISTEN/NOTIFY` notification on the PostgreSQL `scraper:schedule:changed` channel telling the scraper to reload its local cron registrations after the admin has created, updated, or deleted a `scrape_schedules` row. The event carries `action: 'created' | 'updated' | 'deleted'`, `scheduleId`, and the optional denormalized `schedule` snapshot. The **server is the source of truth** for the `scrape_schedules` table; the scraper subscribes and re-evaluates its in-process cron jobs in response. Delivery is ephemeral and is not a durable schedule-change log: a worker that misses a nudge re-syncs on its next reload.

**Canonical home is `packages/scraper-protocol/src/events.ts`.** Wire-format event types are re-exported from the protocol package; transport implementations live under `server/src/services/` and `scraper/src/bus/`.

**ScheduleChangeEvent is not Schedule.** A `Schedule` is the persisted row in the `scrape_schedules` table (server-admin CRUD via `routes/scraper-schedules.ts`); a `ScheduleChangeEvent` is the live pub/sub notification that one of those rows changed. The event's optional `schedule` snapshot is a payload convenience, NOT a redefinition of the row — readers should fetch the row from the DB if they need canonical state.

**CronSchedule is the scheduler-facing projection, not a new entity.** Per ADR 0009 (decision 3) scheduling folds into the worker role; `CronSchedule` (`scraper/src/scheduler/cron-scheduler.ts`) is the narrow `{ id, name, cronExpression }` shape the worker's `CronScheduler` registers and fires — a projection of a `Schedule` row produced via `toCronSchedule`, not a separate persisted concept. The DB row stays canonical; the projection is volatile, rebuilt on every reload.

### Bus port (`BusProducer`, `BusConsumer`)

The interface seam between the `web` and `worker` roles over the queue and two pub/sub channels above. Both arms run on Postgres (ADR 0009): the `scrape_jobs` queue is consumed with `FOR UPDATE SKIP LOCKED`, and progress + schedule-change pub/sub run over `LISTEN/NOTIFY` (`PostgresNotificationBus`, issue #25). The port is what makes the backend a drop-in: role code depends on the interface, the concrete queue/transport is the swappable part.

- **`BusProducer`** (web side): enqueue jobs, query depth, subscribe to progress for SSE fan-out, publish schedule-change notices.
- **`BusConsumer`** (worker side): consume/pop jobs, publish progress, subscribe to schedule changes, plus a `disconnect()` lifecycle hook on both.

**Canonical home is `packages/scraper-protocol/src/bus.ts`** (issue #21). The active implementations are composed backends: `server/src/services/bus-producer.ts` (`PostgresBusProducer` = `PgJobQueue` + `PostgresNotificationBus`) and `scraper/src/bus/postgres-consumer.ts` (`PostgresBusConsumer` = `PgJobConsumer` + `PostgresNotificationBus`). The `LISTEN/NOTIFY` channel names and the raw `NotificationBus` transport contract live in `packages/scraper-protocol/src/notifications.ts` (`NOTIFICATION_CHANNELS`, issue #25). `member:notices` is a reserved peer channel (ADR 0005) with no callers in code yet; it joins the port when it gains an implementation.

### RateLimitConfig

The configured thresholds that govern the server's per-endpoint HTTP rate-limit middleware. Lives at `server/src/services/rate-limit-source.ts` as the **flat runtime shape** consumed by the limiter: per-endpoint `*_Max` caps and `*_WindowMs` windows for general, auth, register, verification, protected, scraper, public, and health routes. The **verification arm** (verify-email link target + resend-verification) is a peer of `register`, deliberately separate so resends cannot be starved by signup volume (ADR 0006, sub-decision 6). The **password-reset request** has two peer arms: per-IP (`passwordReset*`) and per-email (`passwordResetEmail*`), so rotating source addresses cannot bombard one Member's inbox. Resolution order (DB row in `rate_limit_configs` → env vars (e.g. `RATE_LIMIT_GENERAL_MAX`) → built-in defaults) lives in one place. The source is initialized once at boot (`loadFromDb(db)`) and the middleware subscribes to invalidation events so its limiter delegates are rebuilt whenever the DB row changes — either from the 60-second poller (`services/rate-limit-refresher.ts`) or the admin write path.

The **admin-facing shape** `RateLimitAuditInfo` (same file) wraps the flat config under a `config` key and tacks on audit-only metadata: `source` (`'database' | 'env' | 'default'` — the layer that produced the values), `updatedAt`, `updatedBy` (the admin who last edited), and `environment`. The `source` discriminator is **audit metadata** about provenance of the row — it is NOT a domain property of the limit set itself, and it never reaches the per-request hot path. Admin GET returns `RateLimitAuditInfo`; the middleware sees only the flat `RateLimitConfig`.

**What RateLimitConfig is *not*:**
- Not a per-request decision. The limiter decides per-request allow/deny; the config sets the thresholds.
- Not the source-side rate limiter that protects AlloCiné (`RateLimitError`). Those are separate concerns: `RateLimitConfig` protects this service's HTTP surface; `RateLimitError` reports when the upstream source has throttled us.
- Not the same across services. Only the server has an HTTP surface to rate-limit; the scraper has no equivalent shape.

## Application delivery

### Web and worker roles

Post-ADR 0009 the backend ships as **two roles of one image**: the `web` role (Express API + SPA) and the `worker` role (scrape-job consumer + cron scheduler). The compose services are `web` and `worker`; the historical names `server` and `scraper` remain as **workspace directory names** (`server/`, `scraper/`) only — they are never compose service names. The retired vocabulary for the worker role is **"microservice"**: docs and API messages say "worker" (e.g. `"Scrape job queued for worker"`), and the wire message is canonical in `server/src/routes/scraper.ts`. Runbook commands must target `web` (API, migrations, app config) or `worker` (scraping, outbound network, Chromium) per context.

### Web-served SPA

The compiled React SPA is served by the `web` role alongside the `/api` routes
from one origin in the production image. Local development keeps the Vite
development server and proxies `/api` to `web`. The delivery arrangement is an
application-topology concern, not a domain entity; its implementation lives in
`Dockerfile`, `client/vite.config.ts`, `server/src/app.ts`, and the compose
files — `compose.yaml` (dev, issue #27) and `compose.prod.yaml` (production,
issue #28).

## Authentication

### Session

A user-auth **Session** is the server-side credential-issuance lifecycle for one logged-in user: the short-lived access token (HS256 JWT), the rotating refresh token (an httpOnly cookie backed by the `refresh_tokens` table), the double-submit CSRF token cookie, and the permission resolution that feeds the access token's claims. One user holds many Sessions at once — one per device — and a password change revokes all of them, **whether the change is made via `changePassword` or via an email reset** (ADR 0006). `/api/auth/login` is the sole Session-issuance path; reset changes the password and redirects to login — it never mints a Session itself.

The concept is implemented as a single deep module: `server/src/services/session-service.ts` (`SessionService`). Route handlers under `routes/auth.ts` (`/login`, `/refresh`, `/logout`, `/change-password`, `/me`) are thin shims over it; the cookie, refresh-token, and CSRF surface never appears inline in a route. `SessionService` composes `AuthService` (the access-token minter + password-validation primitive) and the refresh-token repository. The refresh-token lifetime is declared in **exactly one place** — `parseRefreshTokenExpiry` in `repositories/refresh-token-repository.ts`, driven by `REFRESH_TOKEN_EXPIRY` — and both the persisted token expiry and the refresh cookie's `maxAge` read from it.

**What a Session is *not*:**
- Not the **access token** itself. The access token is one credential *inside* a Session; `AuthService.mintAccessToken` is the canonical minter, and `SessionService` is its sole caller in the request cycle.
- Not an **SSE subscriber session**. The word "session" is reused loosely for a live SSE subscriber connection (see `attachProgressStream` in `services/sse-bridge.ts`); that is a transport-lifetime concept, unrelated to user-auth Sessions. The two share only the word.
- Not a **ScrapeRun** (one scrape execution) or a **Showtime** (a movie showing) — see those entries.

### Mailer

The auth-only outbound email module (`server/src/services/mailer.ts`). It carries exactly two payloads — **email verification** and **password reset** — and nothing else: submission outcomes never go to email (ADR 0005). The sender identity (`SMTP_FROM_NAME` / `SMTP_FROM_ADDRESS`) defaults to the Branding `email_from_*` defaults (the mirror is pinned by a baseline integration test).

The mailer's **transport is the swappable seam**, resolved from one source of truth (`resolveMailerMode`): with `SMTP_HOST` set it sends through a real SMTP relay; without it, an **in-memory transport** captures every message into a process-wide mailbox. Because email verification is load-bearing (ADR 0003), **production refuses to start without `SMTP_HOST`** (`validateMailerConfiguration`, the same boot-time shape as `validateJWTSecret`) — there is deliberately no silent no-op mode that would strand every Member as `unverified`. Tests and E2E drive the in-memory transport — no real SMTP in CI — and inspect the mailbox through the test-only `/api/test/mailbox` route (mounted when `NODE_ENV=test` or when the `compose.e2e.yaml` overlay opts in via `ENABLE_TEST_MAILBOX`, and only ever while the in-memory transport is actually active).

**What the Mailer is *not*:**
- Not a **notification channel**. Member notifications (TheaterSubmission outcomes) ride the transient `member:notices` SSE path; the mailbox is reserved for auth (see *Member notification*).
- Not **env-tuned policy**. The auth-token lifetime is the `AUTH_TOKEN_TTL_MS` const (30 minutes, shared by verification and password reset — ADR 0006); only the transport (host, port, credentials) is configuration.

### Auth email token

A one-purpose, single-use credential emailed to a Member for an out-of-band auth proof — **email verification** or **password reset**. Stored in `auth_email_tokens` as a **SHA-256 hash only** (the raw token never touches the database), with a 30-minute expiry read from `AUTH_TOKEN_TTL_MS`. At most **one live token per (Member, purpose)**: issuing a fresh token supersedes the outstanding one, and consuming deletes the row. The verification link lands on the client's `/verify?token=…` page; the reset link lands on `/reset-password?token=…`. `POST /api/auth/resend-verification` and `POST /api/auth/password-reset/request` are enumeration-safe, always-200 endpoints whose sends are dispatched **fire-and-forget**; the reset request has independent per-IP and per-email RateLimitConfig arms (ADR 0006, sub-decision 6).

The shared send/dispatch pipeline both services delegate to lives in `server/src/services/auth-email.ts` (`sendAuthLinkEmail` / `dispatchAuthEmail`): lookup → eligibility → token issue → link → best-effort send, with each service supplying its purpose, link path, copy, and eligibility predicate. Its **canonical email hash** (`sha256NormalizedEmail`, full digest; `hashEmailForLog`, short log prefix) is the only email-derived value in logs or limiter keys — no code path logs or throttles on the raw address.

## Database initialization

### Baseline

The single source of truth for a fresh, empty Movie Planner database: the consolidated `docker/init.sql`. The baseline carries the full schema (all tables, constraints, indexes) **and** all reference data that an instance starts with — the three system **Roles** (`admin`, `operator`, `member`), the canonical **permission** set, role/permission grants, the **Branding** singleton defaults, the **RateLimitConfig** singleton, the permission-category labels, and the default weekly **scrape schedule**. It deliberately holds **no static administrator credential**; the first admin is created by application code (see Bootstrap admin).

The baseline is **not** a migration. It is applied once to a bare database — by the Docker postgres image on first container start, or by the host-side `server:db:init` runner (`server/src/db/init.ts`) for non-Docker development. Forward schema changes thereafter are ordinary numbered files under `migrations/` (starting at `001_*`), tracked in `schema_migrations`; the baseline leaves that table empty so the first real migration is `001`. New schema lands in **both** places in the same change: the baseline (for fresh databases) and the next numbered migration (for existing ones). See `docs/adr/0008-fork-monolith-single-db.md` for the single-DB fork decision.

**What the Baseline is *not*:**
- Not a **migration**. Migrations are deltas applied by the runner against an existing database; the baseline is the full initial state laid down on a bare one. The runner does not read `init.sql`.
- Not a **backup** or a data-restore format. It seeds only reference/seed data (roles, permissions, defaults), never runtime rows (users, theaters, showtimes).

### Bootstrap admin

The operational act that brings the **first** `admin` user into existence on a freshly initialized database. Implemented by `ensureInitialAdmin` (`server/src/db/admin-bootstrap.ts`), wired into `initializeDatabase` after the baseline/migrations are in place. When no user holding the `admin` role exists, it creates the `admin` user with a securely generated random password (via `generateRandomPassword`), persists only the hash, and logs the plaintext password **exactly once** to stdout — after which it is unrecoverable. Idempotent: if any admin already exists, it is a no-op, so it is safe to run on every startup.

This is the **sole** mechanism by which the peer-Admin model (see Admin under People & roles) bootstraps its first member. No static credential lives in the **Baseline**; the application owns initial-admin creation so that every fresh instance gets a unique, secret password rather than a shared default.

**What the Bootstrap admin is *not*:**
- Not a **special kind of Admin**. The created user is an ordinary `admin`-role User, identical in powers to every other admin; "bootstrap" names the creation path, not a role or flag.
- Not the **staff-creation route**. Staff (including subsequent admins) are created via the existing admin `POST /auth/register` flow; the bootstrap runs once, at startup, only when the roster is empty.
