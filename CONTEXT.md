# CONTEXT

Domain glossary for allo-scrapper. Devoid of implementation details — this is what things *mean*, not how they're stored.

## Core entities

### Theater

A cinema venue that screens movies. One Theater is one physical venue, identified by a stable external id.

A Theater has:
- a **name** (which may begin with a brand prefix such as "UGC" or "Pathé")
- an **address**, a city, a postal code
- an **image** and a **booking URL**
- exactly one **Source** it is scraped from (today, `'allocine'` for nearly all rows — see the Source concept below)

The number of screens in a venue is **not a domain attribute** of a Theater here. It was historically collected and displayed, but is being removed — see ADR 0002.

**What a Theater is *not*:**
- A Theater is not a brand. "UGC" is a name prefix; "UGC Bercy" is one Theater. There is no `Brand` entity in this model.
- A Theater is not a data source. The source website is a property of a Theater, not the other way around.
- A Theater is not a count of screens. The number of physical screens in a venue is not a domain attribute here — see ADR 0002.

**Lifecycle:** A Theater is either *active* (row present, scraped on schedule) or it does not exist (row deleted, all history lost via `ON DELETE CASCADE`). There is no soft-delete / closed-state concept: closing a Theater means deleting the row, and all its historical Showtimes and WeeklyPrograms are removed with it. See ADR 0001 for the rationale.

### Showtime

One specific scheduled showing of a Movie at a Theater. A Showtime has a date, a start time, a combined `datetime_iso`, a format (e.g. IMAX, 3D), and a list of "experiences" (e.g. Dolby Atmos, 4DX).

**"Showtimes" (plural) is not a separate concept.** It is the plural of Showtime — used for the table name, query results, and UI page names. The domain has one concept: a Showtime.

**What a Showtime is *not*:**
- Not a **Screening**. The codebase has no entity called Screening. The word appears in docs only as an adjective ("screening schedules"). The canonical term is **Showtime**.
- Not a **Session**. "Session" is reserved for user-auth (cookie sessions, SSE subscriber sessions). Using "session" for a movie showing will collide.
- Not a **Séance**. The table was historically named `seances` (French) and was deliberately renamed to `showtimes` (English) — see `docs/project/white-label-plan.md:580, 596`. The team chose the English word. French comments still say "séance" but that's a comment-language choice, not a domain concept.

### WeeklyProgram

A week-level programming fact: "Movie X is programmed at Theater Y in week W." A WeeklyProgram has a `week_start` date, an `is_new_this_week` flag (true if the movie was newly added to that Theater's program that week), and a `scraped_at` timestamp (when this fact was last confirmed).

**WeeklyProgram is a first-class concept, not derived from Showtimes.** The two entities overlap on `(theater_id, movie_id, week_start)` but carry different facts:
- A Showtime answers *"at what times does this movie screen at this Theater?"*
- A WeeklyProgram answers *"is this movie programmed at this Theater this week, and is it new?"*

The `is_new_this_week` flag cannot be derived from current `showtimes` alone — it requires comparing against prior weeks. The `scraped_at` timestamp records when the programming fact was last confirmed, which is independent of when individual Showtimes were last scraped.

### Source

An external website that publishes showtime data and from which one or more Theaters are scraped. Examples today: `'allocine'`. A Source is an **identity** (a stable string), not a parser.

**Source and Theater:** every Theater has exactly one Source. Today, one Source is used to scrape many Theaters; the data model does not require a Source to be 1:1 with Theaters.

**What a Source is *not*:**
- Not a **Strategy**. A Strategy is the *code* that knows how to scrape a given Source — the parser/adapter. Source is the identity; Strategy is the implementation. The two are 1:1 in the current code, but they are distinct concepts (the strategy can change while the source name stays the same; the source name identifies *what* is being scraped, the strategy identifies *how*).
- Not a **Parser**. A Parser is a helper function inside a Strategy that handles a specific data shape (an HTML page, a JSON blob). Parsers are implementation detail of Strategies, not domain entities.

**Practical note:** "Add support for a new Source" = add a new Strategy whose `sourceName` matches a new Source string. The Source identity is what Theater rows reference; the Strategy is what the scraper wires up.

## Scraping

The terms in this section name the recurring concepts of one end-to-end scrape run. A run is initiated by a ScrapeJob on the Redis queue, executed by the scraper microservice which emits ProgressEvents during the run, and tracked in the database via a ScrapeReport (the run-level record) holding many ScrapeAttempts (one per `(theater, date)` pair). One concept — Resume — lets a stopped/incomplete run be re-issued scoped to only its unfinished attempts. RateLimitConfig governs the API-side request throttling that protects AlloCiné responses from being overwhelmed.

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

The structured result of one scrape run, attached to the final `'completed'` (or `'failed'`) ProgressEvent. Carries run-level counters (theaters / movies / showtimes / dates / duration / per-error list) and a final `status`. **One definition, two byte-identical copies:** the canonical declaration lives in `scraper/src/types/scraper.ts:113` and is re-declared in `server/src/services/progress-tracker.ts:19`. Both exist today because no shared protocol package exists yet — the same pattern repeats for `ProgressEvent`, `ScrapeJob`, and `ScheduleChangeEvent`. When the protocol package lands, these converge.

The scrape-side and server-side shapes are identical *today* (both include `total_dates` and `status`), so for new code pick either copy; the arrival of a protocol package will move both into it.

### Resume

Re-issuing a stopped or incomplete scrape scoped to only the (theater, date) pairs that did not reach `success`. The UI exposes it as the "Reprendre le scraping" button (`client/src/pages/ReportsPage/ReportRateLimitedNotice.tsx:38`) wired through the `resume` function (`client/src/pages/ReportsPage.tsx:90`); the API path is `POST /api/scraper/resume/:reportId` (`server/src/routes/scraper.ts:85`); the scraper-runtime flag is `options.resumeMode: true` and the payload list is `options.pendingAttempts: Array<{ theater_id; date }>` (`scraper/src/scraper/index.ts:146-147`).

A Resume always produces a **new** ScrapeReport with `parent_report_id` set to the original. The server reads `getPendingScrapeAttempts(parentReportId)` (any attempt in `failed | rate_limited | not_attempted`), translates them into the `pendingAttempts` payload, and publishes a new ScrapeJob in resume mode. `filterDatesForScrape` then narrows each theater's plan to only its pending dates.

**Resume is not free retry.** It does not re-scrape dates that already reached `success` in the parent report. It is also not idempotent on the receiving theater: a date that was `not_attempted` in the parent becomes a brand new `pending` → `success/failed/...` sequence under the new report id.

### ScrapeJob

A unit of work submitted by the server over the Redis `scrape:jobs` list for the scraper microservice to execute. A ScrapeJob is a **discriminated union**: `{ type: 'scrape' }` for a standard run and `{ type: 'add_theater' }` for fetching metadata for a new AlloCiné URL and scraping everything it publishes. Every job carries a `reportId` and an optional OpenTelemetry `traceContext`.

Two byte-identical copies live at `server/src/services/redis-client.ts:50` and `scraper/src/redis/client.ts:50`. **Canonical home is the forthcoming protocol package** (issue #<TBD>); when that lands, both sites re-export from it. Until then, edit both — `grep -r 'export type ScrapeJob' server/src scraper/src` is the audit.

**Drift to be aware of (not fixed by this entry):** the server-side `ScrapeJobScrape.options` shape (`server/src/services/redis-client.ts:30-37`) includes `resumeMode` and `pendingAttempts` for the Resume case; the structurally-identical scraper-side declaration (`scraper/src/redis/client.ts:30-36`) does not. The scraper consumes those fields via its own `ScrapeOptions` type (`scraper/src/scraper/index.ts:140`), which is why this works in practice today. The protocol-package work should converge all three.

### ProgressEvent

A discrete event published by the scraper onto the Redis `scrape:progress` pub/sub channel during a run, fanned out by the server to connected SSE clients. The union covers run start (`started`), per-theater and per-date lifecycle (`theater_started`, `date_started`, `date_completed`, `date_failed`, `date_stale`), per-movie lifecycle (`movie_started`, `movie_completed`, `movie_failed`), run completion (`completed` with the ScrapeSummary), and fatal failure (`failed`).

Declared at `scraper/src/types/scraper.ts:98` and re-declared at `server/src/services/progress-tracker.ts:4`. Same two-sites, one concept pattern as `ScrapeJob` and `ScrapeSummary`. Canonical home is the forthcoming protocol package.

### ScheduleChangeEvent

A fire-and-forget pub/sub notification on the Redis `scraper:schedule:changed` channel telling the scraper to reload its local cron registrations after the admin has created, updated, or deleted a `schedules` row. The event carries `action: 'created' | 'updated' | 'deleted'`, `scheduleId`, and the optional denormalized `schedule` snapshot. The **server is the source of truth** for the schedules table; the scraper subscribes and re-evaluates its in-process cron jobs in response.

Declared identically at `scraper/src/redis/client.ts:9` and `server/src/services/redis-client.ts:15`. Same forthcoming protocol-package note as the other wire types.

**ScheduleChangeEvent is not Schedule.** A `Schedule` is the persisted row in the `schedules` table (server-admin CRUD via `routes/scraper-schedules.ts`); a `ScheduleChangeEvent` is the live pub/sub notification that one of those rows changed. The event's optional `schedule` snapshot is a payload convenience, NOT a redefinition of the row — readers should fetch the row from the DB if they need canonical state.

### RateLimitConfig

The configured thresholds that govern the server's per-endpoint HTTP rate-limit middleware. Lives at `server/src/config/rate-limits.ts:10` as the **flat runtime shape** consumed by the limiter: per-endpoint `*_Max` caps and `*_WindowMs` windows for general, auth, register, protected, scraper, public, and health routes. Resolution order (cached 30s): DB row in `rate_limit_configs` → env vars (e.g. `RATE_LIMIT_GENERAL_MAX`) → built-in defaults.

The **admin-facing shape** at `server/src/db/rate-limit-queries.ts:28` wraps the flat config under a `config` key and tacks on audit-only metadata: `source` (`'database' | 'env' | 'default'` — the layer that produced the values), `updatedAt`, `updatedBy` (the admin who last edited), and `environment`. The `source` discriminator is **audit metadata** about provenance of the row — it is NOT a domain property of the limit set itself. Consumers that just need to enforce limits import the flat shape from `config/`; consumers that need to render the admin form import the wrapped shape from `db/`. The duplication should converge when the limit-config service is split out.

**What RateLimitConfig is *not*:**
- Not a per-request decision. The limiter decides per-request allow/deny; the config sets the thresholds.
- Not the source-side rate limiter that protects AlloCiné (`RateLimitError`). Those are separate concerns: `RateLimitConfig` protects this service's HTTP surface; `RateLimitError` reports when the upstream source has throttled us.
- Not the same across services. Only the server has an HTTP surface to rate-limit; the scraper has no equivalent shape.