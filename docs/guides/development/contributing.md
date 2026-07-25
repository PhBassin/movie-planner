# Contributing Guide

Thank you for your interest in contributing to Movie Planner! This document
outlines the development workflow and standards we follow.

---

## Table of Contents

- [Development Workflow](#development-workflow)
- [Issue First](#issue-first)
- [Branching](#branching)
- [Test-Driven Development (TDD)](#test-driven-development-tdd)
- [Conventional Commits](#conventional-commits)
- [Atomic Commits](#atomic-commits)
- [Pull Request Guidelines](#pull-request-guidelines)
- [Releases](#releases)
- [Code Style](#code-style)
- [Documentation](#documentation)

---

## Development Workflow

Every contribution should follow this workflow:

```
1. Issue First    → Create or find an existing issue
2. Branch         → Branch from `main` (see Branching)
3. Plan           → Break down into tasks, identify tests needed
4. TDD            → Write tests BEFORE implementation
5. Implement      → Write minimal code to pass tests
6. Atomic Commits → One logical change per commit
7. Documentation  → Update README / AGENTS.md / CONTEXT.md if behavior changed
8. Pull Request   → Open PR against `main`, reference the issue
```

---

## Issue First

**Before writing any code, ensure there is a GitHub issue.** This tracks the
reason for changes, enables discussion, and provides traceability in commit
history.

Issue types:

| Type | Use case | Default label |
|------|----------|---------------|
| Bug report | Something is broken | `bug` |
| Feature request | New functionality | `enhancement` |
| Task | Technical chore, refactoring | `chore` |

Reference issues in commits and PRs:

- `refs #123` — references the issue without closing it
- `closes #123` — closes the issue when the PR merges (also `fixes #123`)

---

## Branching

- Branch from `main` only. `main` is the default, protected, long-lived branch.
- Do **not** branch from `develop` (it is being retired) or another feature branch.
- Naming: `<type>/<issue#>-<short-description>` — e.g. `feat/259-add-theater-modal`,
  `fix/42-fix-parser-bug`, `docs/266-update-readme`.

---

## Test-Driven Development (TDD)

We follow TDD: write tests **before** implementation.

```
1. RED      → Write a failing test
2. GREEN    → Write minimal code to pass the test
3. REFACTOR → Improve code while keeping tests green
4. REPEAT
```

### Coverage targets

| Metric | Target |
|--------|--------|
| Lines | ≥ 80% |
| Functions | ≥ 80% |
| Statements | ≥ 80% |
| Branches | ≥ 65% |

The server workspace enforces its coverage threshold on every pre-push hook
and CI run; failing thresholds block the push.

### Running tests

```bash
# Server (vitest) — pick the workspace
npm run test:run --workspace=@movie-planner/server
npm run test:coverage --workspace=@movie-planner/server

# Scraper
npm run test:run --workspace=@movie-planner/scraper

# scraper-protocol
npm run test:coverage --workspace=@movie-planner/scraper-protocol

# All workspaces
npm test

# E2E (Playwright, from the repo root)
npm run e2e
```

For authentication tests, set `process.env.JWT_SECRET` **before** importing the
modules that use it — the secret is captured at import time.

For the full testing guide, see [Testing](./testing.md).

---

## Conventional Commits

All commits follow [Conventional Commits](https://www.conventionalcommits.org/).
The release workflow rejects non-conforming subjects since the changelog is
generated from them.

### Format

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

### Types

| Type | Description | Example |
|------|-------------|---------|
| `feat` | New feature | `feat(scraper): add support for UGC theaters` |
| `fix` | Bug fix | `fix(api): handle missing movie poster gracefully` |
| `docs` | Documentation only | `docs(readme): update API examples` |
| `test` | Adding/updating tests | `test(parser): add edge cases for empty HTML` |
| `chore` | Maintenance tasks | `chore(deps): update vitest` |
| `refactor` | Code refactoring (no behavior change) | `refactor(db): extract query builders` |
| `style` | Formatting, whitespace | `style(scraper): fix indentation` |
| `perf` | Performance improvement | `perf(parser): cache regex patterns` |
| `ci` | CI/CD changes | `ci(actions): add identity guard` |
| `build` | Build system changes | `build(docker): optimize multi-stage build` |
| `revert` | Revert a previous commit | `revert: fix(api): showtime timezone` |

### Scopes (optional but recommended)

`scraper`, `api`, `db`, `parser`, `client`, `docker`, `deps`, `ci`.

### Breaking changes

Use `!` after the type/scope, and/or a `BREAKING CHANGE:` footer:

```
feat(api)!: change movie endpoint response format

BREAKING CHANGE: /api/movies/:id returns nested showtime objects
instead of flat arrays.
```

---

## Atomic Commits

Each commit represents one logical, self-contained change. Split when:

- Adding tests vs implementing features
- Fixing unrelated bugs
- Updating documentation
- Changing dependencies
- Refactoring vs adding functionality

Each commit should pass tests, build cleanly, and be reviewable in isolation.

---

## Pull Request Guidelines

### Before opening a PR

Run the local verification suite (mirrors pre-push and CI):

```bash
# 1. Type-checks
(cd server && npx tsc --noEmit)
(cd scraper && npx tsc --noEmit)
(cd client && npx tsc -b)

# 2. Tests
npm run test:run --workspace=@movie-planner/server
npm run test:coverage --workspace=@movie-planner/server
npm run test:run --workspace=@movie-planner/scraper
```

### PR title

Follow the Conventional Commits format. The release workflow reads merged PR
titles; non-conforming titles can block a release.

### PR description

- Summary of changes
- Related issue (`closes #N`)
- Type of change (feature / fix / refactor / docs / chore)
- Checklist

### Review

1. Open the PR against `main`.
2. Ensure the CI checks pass (type-check, tests, coverage, identity guard).
3. Request review from maintainers.
4. Address feedback with new commits; avoid force-push during review unless
   requested.

---

## Releases

Releases are produced by manual dispatch, not by labels or push hooks:

1. A maintainer dispatches the **Prepare Release** workflow
   (`.github/workflows/prepare-release.yml`) with a target version (e.g. `0.1.0`).
2. The workflow validates the version, checks Conventional Commit compliance
   since the last tag (or `movie-planner-import` for the first release), bumps
   every workspace `package.json`, refreshes `package-lock.json`, and generates
   the changelog section.
3. It opens a protected-branch-compatible `release/<version>` PR against `main`.
4. When that PR merges, **Tag & Release**
   (`.github/workflows/tag-release.yml`) creates the annotated `vX.Y.Z` tag and
   publishes the GitHub Release from the matching `CHANGELOG.md` section.

Tags are immutable: the workflow refuses to move or rewrite an existing tag.
Docker images are built locally only — there is no registry publication.

See the [CI/CD guide](./cicd.md) for details.

---

## Code Style

- **TypeScript strict mode** is enforced.
- **ESM** everywhere (`"type": "module"`); relative TS imports use `.js`
  extensions.
- Node 24 only (see `engines` in each `package.json`).
- Prefer existing libraries already in the relevant workspace; never add a
  dependency without explicit maintainer consent.
- Prefer named exports; functional React components.
- Validate IDs/pagination with `parseStrictInt`, never native `parseInt`.
- Validate new passwords with `validatePasswordStrength` on every password
  entry point.
- Never embed `error.message` in HTTP 500 responses — log context and return a
  static sanitized message.

### Naming

| Type | Convention | Example |
|------|------------|---------|
| Files | kebab-case | `theater-parser.ts` |
| Functions | camelCase | `parseTheaterPage()` |
| Classes | PascalCase | `HttpClient` |
| Constants | UPPER_SNAKE_CASE | `MAX_RETRY_COUNT` |
| Types/Interfaces | PascalCase | `Theater`, `MovieData` |

---

## Documentation

Update documentation when:

- Adding new API endpoints → [API reference](../../reference/api/README.md)
- Changing environment variables → [Configuration](../../getting-started/configuration.md)
- Modifying database schema → [Database reference](../../reference/database/)
- Adding new features → root [README](../../../README.md) and
  [CONTEXT.md](../../../CONTEXT.md) (domain glossary)
- Changing CI/release process → [CI/CD guide](./cicd.md) and this document

**`CONTEXT.md` at the repo root is the project's domain glossary.** New code
must use the canonical terms it defines; new or overloaded concepts must be
added there in the same change.

---

## Questions?

1. Check the documentation under [docs/](../../README.md).
2. Search closed issues and PRs.
3. Open a GitHub [Discussion](https://github.com/PhBassin/movie-planner/discussions).
4. File an issue for bugs or feature requests.

---

[← Back to Development Guides](./README.md) | [Back to Documentation](../../README.md)
