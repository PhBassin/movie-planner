# Changelog

All notable changes to Movie Planner will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> The inherited changelog — covering the project history up to the
> `allo-scrapper-import` boundary tag — is archived at
> [`docs/history/allo-scrapper-changelog.md`](docs/history/allo-scrapper-changelog.md).
> See [ADR 0008](docs/adr/0008-fork-monolith-single-db.md) for the fork and
> permanent-divergence decision.

## [Unreleased]

No Movie Planner release has been published yet. The first planned release is
`0.1.0`, deferred until the independence cleanup (issue #3) is complete.

### Added — Movie Planner baseline

- Canonical Movie Planner identity across packages, workspaces, defaults, logs,
  and white-label reset behavior, with pre-release version
  `0.0.0-development` (#3, PR 1).
- Consolidated PostgreSQL baseline at `docker/init.sql` and a host-side
  `db:init` runner; secure random initial-admin bootstrap; real PostgreSQL
  baseline test (#3, PR 2).
- `compose.yaml` (default fully Dockerized) and `compose.infra.yaml` (host-app
  on Node 24 with only Postgres and Redis containerized) local development
  paths; renamed `movie_planner_*` backup/restore utilities (#3, PR 3).

### Removed — inherited surfaces

- Production/VPS, Traefik, Watchtower, GHCR, rollback, and SSH backup/restore
  surfaces and their dedicated documentation (#3, PR 4).
- OpenTelemetry code, tests, configuration, and dependencies; the now-dead
  `traceContext` wire-format field (#3, PR 4).
- Bundled Grafana, Loki, Tempo, and monitoring Compose configuration; only
  Prometheus metrics and the authenticated `/metrics` endpoint are retained
  (#3, PR 4).
