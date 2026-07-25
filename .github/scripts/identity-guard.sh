#!/usr/bin/env bash
# Identity / hostname guard for Movie Planner (issue #3, PR 5).
#
# Fails the build when inherited active identity or operational endpoints are
# reintroduced outside the approved historical allowlist.
#
# What it detects:
#   1. Case-insensitive "allo-scrapper" (any case, - or _) outside the
#      allowlist, EXCLUDING the `allo-scrapper-import` boundary tag (which is
#      an operational artifact, not active identity).
#   2. Inherited operational hostnames (opalkad.com, incl. ics.opalkad.com)
#      anywhere, including historical files.
#   3. Active links to the allo-scrapper GitHub repo / issues / discussions /
#      releases / container registry outside the allowlist.
#   4. The standalone inherited service identifiers `ics-db`, `ics-web`,
#      `ics-redis`, `ics-scraper`, `ics-cron` (and case/separator variants).
#      The bare token `ics` and the `.ics` calendar file extension are NOT
#      legacy identity (they denote the iCalendar format) and do not trip
#      the guard.
#
# This script is part of the policy infrastructure and is itself in the
# allowlist. Edit cautiously.

set -uo pipefail

# Historical allowlist (paths that may legitimately mention inherited identity).
# Limited per docs/plans/independence-cleanup.md. Directory prefixes (trailing
# `/`) exclude everything under them.
ALLOWLIST=(
  "LICENSE"
  "README.md"
  "CHANGELOG.md"
  "docs/adr/0008-fork-monolith-single-db.md"
  "docs/history/"
  "docs/plans/"
  ".github/scripts/identity-guard.sh"
  ".github/scripts/generate-changelog.sh"
)

ALLOW_PATHS=()
for allowed in "${ALLOWLIST[@]}"; do
  if [[ "$allowed" == */ ]]; then
    ALLOW_PATHS+=(":!${allowed}*")
  else
    ALLOW_PATHS+=(":!${allowed}")
  fi
done

EXIT_CODE=0

# --- Check 1: legacy name (case-insensitive, hyphen OR underscore) -----------
# Negative lookahead excludes the `allo-scrapper-import` boundary tag.
# Requires PCRE (git grep -P), available on Ubuntu runners and modern git.
OFFENDERS=$(git grep -n -iP 'allo[-_]scrapper(?!-import)' -- . "${ALLOW_PATHS[@]}" 2>/dev/null || true)
if [ -n "$OFFENDERS" ]; then
  echo "::error::Inherited 'allo-scrapper' identity found outside the historical allowlist:"
  echo "$OFFENDERS"
  EXIT_CODE=1
fi

# --- Check 2: inherited operational hostnames --------------------------------
# Allowlisted paths (the plan, the guard script, etc.) may legitimately cite the
# forbidden hostname when describing the policy itself.
HOST_OFFENDERS=$(git grep -n -iP 'ics\.opalkad\.com|opalkad\.com' -- . "${ALLOW_PATHS[@]}" 2>/dev/null || true)
if [ -n "$HOST_OFFENDERS" ]; then
  echo "::error::Inherited operational hostname (opalkad.com) found:"
  echo "$HOST_OFFENDERS"
  EXIT_CODE=1
fi

# --- Check 3: active links to the inherited repo / container registry -------
REPO_OFFENDERS=$(git grep -n -iP 'github\.com/phbassin/allo-scrapper|ghcr\.io/phbassin/allo-scrapper' -- . "${ALLOW_PATHS[@]}" 2>/dev/null || true)
if [ -n "$REPO_OFFENDERS" ]; then
  echo "::error::Active inherited repository / registry link found outside the allowlist:"
  echo "$REPO_OFFENDERS"
  EXIT_CODE=1
fi

# --- Check 4: inherited service identifiers (ics-db, ics-web, ...) ----------
# Catches: ics-db, ics_web, ics.scraper, ics-scraper, ics-cron, ics-redis,
# ics-scraper-cron, and case variants. Does NOT catch the bare token `ics`
# (legitimate calendar variable name) or the `.ics` file extension.
ICS_OFFENDERS=$(git grep -n -iP '\bics[-_.](db|web|redis|scraper|cron)([-_]cron)?\b' -- . "${ALLOW_PATHS[@]}" 2>/dev/null || true)
if [ -n "$ICS_OFFENDERS" ]; then
  echo "::error::Inherited service identifier (ics-db / ics-web / ics-redis / ics-scraper / ics-cron) found:"
  echo "$ICS_OFFENDERS"
  EXIT_CODE=1
fi

if [ "$EXIT_CODE" -ne 0 ]; then
  echo "::error::Identity guard failed. Allowed paths for inherited identity:"
  printf '  - %s\n' "${ALLOWLIST[@]}"
  exit "$EXIT_CODE"
fi

echo "Identity guard passed: no reintroduced inherited identity or operational endpoint."
