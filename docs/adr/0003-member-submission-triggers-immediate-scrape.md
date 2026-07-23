# Members can trigger an immediate scrape by submitting a new Theater

A Member submitting a new cinema URL (a **TheaterSubmission**) fires an `add_theater` ScrapeJob **immediately, with no Staff approval step** — the deliberate, sole exception to "scrapping is managed by Staff." We rejected the admin-gated alternative (submission → Staff approval → scrape) because the product requires that adding a cinema is never blocked on an admin being available. The resulting abuse surface is bounded by three proactive controls plus one reactive one: URL deduplication (a submitted URL matching an existing Theater degrades to a Selection add with no scrape), a per-Member submission throttle, an email-verification gate (only verified Members may submit), and reactive suspension of offending Members by an Admin.

## Consequences

- Scraping now has **two origins** (Staff-owned operational scraping; Member-owned add-triggered one-shots), both documented in CONTEXT.md under *Scraping → Two origins of a scrape*. Both produce the same downstream artifacts (ScrapeReport, ScrapeAttempts, ProgressEvents); they differ only in who originates them and whether they recur.
- Member **email verification becomes load-bearing for abuse prevention**, not merely for identity. It cannot be quietly removed or made optional without reopening the scrape-abuse surface — the throttle alone is not enough against disposable accounts.
- The "admin owns scraping" invariant is now scope-limited to *operational* scraping (schedules, full re-scrapes, resume, monitoring); it must not be read as "no non-admin can ever cause a scrape."
