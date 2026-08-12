# Movie Planner Documentation

Welcome to the Movie Planner documentation. This guide covers local setup,
development, administration, and the technical reference for the theater
showtimes aggregator.

> **Provenance:** Movie Planner is a permanently diverged project derived from
> an inherited cinema codebase. See [ADR 0008](./adr/0008-fork-monolith-single-db.md)
> and the [archived inherited changelog](./history/) for context.

## Documentation Structure

The documentation follows the [Divio Documentation System](https://documentation.divio.com/).

### Getting Started

- [Quick Start](./getting-started/quick-start.md) — get running with Docker in minutes
- [Installation](./getting-started/installation.md) — detailed local setup
- [Configuration](./getting-started/configuration.md) — environment variables

### Guides

**[Development](./guides/development/)** — local dev, testing, contributing, CI
- [Setup](./guides/development/setup.md) — local development environment (Node 24)
- [Testing](./guides/development/testing.md) — unit, integration, E2E
- [Contributing](./guides/development/contributing.md) — workflow and Conventional Commits
- [CI/CD](./guides/development/cicd.md) — GitHub Actions and release process

**[Administration](./guides/administration/)** — admin panel and white-label
- [Admin Panel](./guides/administration/admin-panel.md)
- [White-Label Configuration](./guides/administration/white-label.md)
- [User Management](./guides/administration/user-management.md)

**[Deployment](./guides/deployment/)** — Docker and networking for local dev and production
- [Production Deployment](./guides/deployment/production.md) — `compose.prod.yaml` (web + worker + db)
- [Docker Setup](./guides/deployment/docker.md) — `compose.yaml` and `compose.infra.yaml`
- [Networking](./guides/deployment/networking.md) — local ports and proxies

> GHCR publication, monitoring, scaling, and SSH backup/restore are no longer
> supported. Production runs on one box via `compose.prod.yaml`. See the
> [independence cleanup plan](./plans/independence-cleanup.md).

### Reference

- [**API**](./reference/api/) — REST API reference
- [**Database**](./reference/database/) — schema and migrations
- [**Architecture**](./reference/architecture/) — system design
- [**Scripts**](./reference/scripts/) — local backup/restore and maintenance utilities
- [Roles & Permissions](./reference/roles-and-permissions.md)
- [Performance](./reference/performance.md)

### Troubleshooting

- [Common Issues](./troubleshooting/common-issues.md)
- [Database](./troubleshooting/database.md)
- [Docker](./troubleshooting/docker.md)
- [Networking](./troubleshooting/networking.md)
- [Scraper](./troubleshooting/scraper.md)

### Domain & Decisions

- [CONTEXT.md](../CONTEXT.md) — domain glossary (entities, FSMs, wire-format types)
- [ADR index](./adr/) — architecture decision records
- [White-Label implementation plan](./project/white-label-plan.md) — historical design notes
- [Independence cleanup plan](./plans/independence-cleanup.md) — Movie Planner baseline epic

## Quick Links

- **First time here?** → [Getting Started](./getting-started/)
- **Looking for API docs?** → [API Reference](./reference/api/)
- **Something not working?** → [Troubleshooting](./troubleshooting/)
- **Want to contribute?** → [Contributing Guide](./guides/development/contributing.md)

## Need Help?

- **Issues & Bug Reports**: [GitHub Issues](https://github.com/PhBassin/movie-planner/issues)
- **Discussions**: [GitHub Discussions](https://github.com/PhBassin/movie-planner/discussions)

---

[← Back to README](../README.md)
