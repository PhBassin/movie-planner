# CI/CD and Release Pipeline

How GitHub Actions runs on Movie Planner, and how releases are produced.

**Related documentation:**
- [Docker Setup](../deployment/docker.md) — local builds only, no registry
- [Testing Guide](./testing.md) — what CI runs
- [Contributing Guide](./contributing.md) — Conventional Commits and PR workflow

---

## Table of Contents

- [Overview](#overview)
- [CI workflow](#ci-workflow)
- [Identity guard](#identity-guard)
- [Release process](#release-process)
- [Workflow reference](#workflow-reference)

---

## Overview

Movie Planner keeps GitHub Actions deliberately small. The unsupported
GHCR/deployment/sync workflows were removed in issue #3, PR 5; what remains is:

- **CI** — type-checks, tests, coverage, identity guard (every PR and push to `main`).
- **Prepare Release** — manual dispatch, opens a `release/<version>` PR.
- **Tag & Release** — runs when a release PR merges; creates the immutable
  `vX.Y.Z` tag and the GitHub Release.

Docker images are built locally only. There is no `ghcr.io` publication and no
main/develop synchronization workflow — `main` is the single default branch.

---

## CI workflow

`.github/workflows/ci.yml` runs on:

- `pull_request` against `main`
- `push` to `main`
- manual `workflow_dispatch`

Jobs:

1. **Identity guard** — see below.
2. **TypeScript build & tests** — installs dependencies with
   `npm install --legacy-peer-deps` (CI deletes `package-lock.json` first),
   builds `@movie-planner/scraper-protocol`, type-checks server/scraper/client,
   runs server tests + coverage gate, and runs `scraper-protocol` coverage.

Both jobs must pass for a PR to be mergeable on protected `main`.

---

## Identity guard

The first CI job enforces the Movie Planner identity boundary (issue #3, PR 5).
It fails the build when:

- the inherited product identity string (case-insensitive, `-` or `_`) appears
  outside the historical allowlist;
- the inherited operational hostname appears anywhere, including historical
  files;
- active links to the inherited GitHub repo or container registry appear
  outside the allowlist;
- the inherited prefixed service identifiers (the legacy short-names with their
  inherited prefix) appear in active configuration or code;

The literal patterns the guard matches, and the exact allowlist, are in
[`.github/scripts/identity-guard.sh`](../../../.github/scripts/identity-guard.sh).
`Allocine` source identifiers and calendar `.ics` terminology are not legacy
identity and never produce false positives.

---

## Release process

Releases are produced by **manual dispatch**, not by labels or push hooks. The
full sequence:

1. **Dispatch.** A maintainer runs the **Prepare Release** workflow
   (`.github/workflows/prepare-release.yml`) with a target version (e.g.
   `0.1.0`, no leading `v`).
2. **Validate.** The workflow validates semver, refuses if the tag/release
   already exists or `CHANGELOG.md` already has a section for that version,
   and rejects non-Conventional-Commits subjects since the previous tag (or
   `movie-planner-import` for the first release).
3. **Bump.** Every workspace `package.json` and `package-lock.json` is bumped
   to the target version.
4. **Generate.** The changelog section is generated from Conventional Commits
   by `.github/scripts/generate-changelog.sh` and inserted under a new
   `## [<version>] - <date>` heading in `CHANGELOG.md`.
5. **Open PR.** A `release/<version>` branch is pushed and a PR is opened
   against `main` with the `release` label.
6. **Merge.** The maintainer reviews and merges the PR.
7. **Tag & Release.** Merging a `release/<version>` PR triggers
   `.github/workflows/tag-release.yml`, which creates the annotated `vX.Y.Z`
   tag at the merge commit and publishes the GitHub Release from the matching
   `CHANGELOG.md` section.

> **Reviewer note:** the workflow inserts the generated section below
> `## [Unreleased]` but does not empty that block. When the Unreleased notes
> describe work that is shipping in this release, move or trim them in the
> release PR before merging.

Tags are immutable: the workflow refuses to move or rewrite an existing tag,
and refuses to publish a release that already exists.

### Failure modes

The release workflow fails loudly on:

- malformed version (anything not `x.y.z`)
- existing tag (local or remote) for the target version
- existing GitHub Release for the target version
- duplicate `## [<version>]` section already in `CHANGELOG.md`
- non-Conventional-Commits subject on any commit since the last tag

---

## Workflow reference

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| [`ci.yml`](../../../.github/workflows/ci.yml) | `pull_request` to `main`, `push` to `main`, `workflow_dispatch` | Identity guard + type-checks + tests + coverage |
| [`prepare-release.yml`](../../../.github/workflows/prepare-release.yml) | `workflow_dispatch` (version input) | Validate, bump versions, generate changelog, open `release/<version>` PR |
| [`tag-release.yml`](../../../.github/workflows/tag-release.yml) | `pull_request` closed on `main` (head branch `release/*`) | Create annotated `vX.Y.Z` tag + GitHub Release |

The Dependabot workflow (`dependabot.yml`) opens dependency-bump PRs, which go
through the same CI.

---

[← Back to Development Guides](./README.md) | [Back to Documentation](../../README.md)
