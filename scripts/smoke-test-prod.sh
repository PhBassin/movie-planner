#!/bin/bash
# Smoke test for a compose.prod.yaml deployment (ADR 0009 topology).
# Verifies the four things the prod compose acceptance requires:
#   1. API           — GET /api/health returns healthy with database connected
#   2. SPA           — GET / serves the baked client bundle (root mount node)
#   3. Queue consume — a job inserted into scrape_jobs is claimed by the worker
#   4. Progress      — the web SSE endpoint streams worker progress events
#
# Usage:
#   ./scripts/smoke-test-prod.sh            # against a running compose.prod.yaml
#   ./scripts/smoke-test-prod.sh --build    # up -d --build first, then test
#
# Environment overrides: SERVER_PORT, POSTGRES_USER, POSTGRES_DB.

set -euo pipefail

COMPOSE_FILE="compose.prod.yaml"
WEB_URL="http://localhost:${SERVER_PORT:-3000}"
DB_USER="${POSTGRES_USER:-postgres}"
DB_NAME="${POSTGRES_DB:-movie_planner}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

pass() { echo -e "${GREEN}✅ $*${NC}"; }
fail() { echo -e "${RED}❌ $*${NC}" >&2; exit 1; }
info() { echo -e "${YELLOW}⏳ $*${NC}"; }

if [ "${1:-}" = "--build" ]; then
  info "Building and starting the production stack..."
  docker compose -f "$COMPOSE_FILE" up -d --build
fi

# ---------------------------------------------------------------------------
# Wait for web to be healthy (db readiness + migrations + admin bootstrap gate
# web's /api/health, so a 200 proves the full web startup path).
# ---------------------------------------------------------------------------
info "Waiting for web health endpoint..."
WEB_MAX_WAIT=120
WEB_WAIT=0
until curl -fs "$WEB_URL/api/health" > /dev/null 2>&1; do
  if [ "$WEB_WAIT" -ge "$WEB_MAX_WAIT" ]; then
    fail "Web health endpoint did not come up within ${WEB_MAX_WAIT}s"
  fi
  sleep 2
  WEB_WAIT=$((WEB_WAIT + 2))
done
pass "Web is reachable after ${WEB_WAIT}s"

# ---------------------------------------------------------------------------
# 1. API health — status healthy + database connected.
# ---------------------------------------------------------------------------
HEALTH_RESPONSE=$(curl -fs "$WEB_URL/api/health")
if ! echo "$HEALTH_RESPONSE" | grep -q '"status":"healthy"' ||
   ! echo "$HEALTH_RESPONSE" | grep -q '"database":"connected"'; then
  fail "Unexpected /api/health payload: $HEALTH_RESPONSE"
fi
pass "API health OK: $HEALTH_RESPONSE"

# ---------------------------------------------------------------------------
# 2. SPA — the baked client bundle is served from the web origin.
# ---------------------------------------------------------------------------
SPA_HTML=$(curl -fs "$WEB_URL/")
if ! echo "$SPA_HTML" | grep -q '<div id="root">'; then
  fail "SPA root mount node missing from GET /"
fi
pass "SPA served from web origin (found <div id=\"root\">)"

# ---------------------------------------------------------------------------
# 3 + 4. Queue consumption + progress delivery.
#
# Insert a minimal scrape job directly into the Postgres queue (no auth
# needed), then prove the worker claims it (the row is deleted at claim time)
# and that the web SSE stream forwards the worker's progress event.
# ---------------------------------------------------------------------------
info "Enqueuing a smoke-test scrape job and watching the worker consume it..."

PAYLOAD='{"type":"scrape","reportId":1,"triggerType":"manual","options":{"mode":"from_today_limited","days":1,"theaterId":"C0153"}}'

JOB_ID=$(docker compose -f "$COMPOSE_FILE" exec -T db \
  psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "INSERT INTO scrape_jobs (payload) VALUES ('${PAYLOAD}'::jsonb) RETURNING id;" \
  | tr -d '[:space:]') \
  || fail "Could not insert smoke-test job into scrape_jobs"
[ -n "$JOB_ID" ] || fail "Could not read the inserted job id"

# Open the SSE stream to the same reportId used above. progressTracker replays
# already-cached events to new listeners, so a late subscriber still sees them.
SSE_OUT=$(mktemp)
curl -Ns --max-time 90 "$WEB_URL/api/scraper/progress" > "$SSE_OUT" 2>&1 &
SSE_PID=$!
trap 'kill "$SSE_PID" 2>/dev/null || true; rm -f "$SSE_OUT"' EXIT

# Queue consumption: the worker claims by delete-and-return, so the specific
# job row must disappear from scrape_jobs within the worker's poll interval
# (2s) + slack.
QUEUE_MAX_WAIT=30
QUEUE_WAIT=0
while [ "$QUEUE_WAIT" -lt "$QUEUE_MAX_WAIT" ]; do
  if ! docker compose -f "$COMPOSE_FILE" exec -T db \
      psql -U "$DB_USER" -d "$DB_NAME" -tAc \
      "SELECT EXISTS (SELECT 1 FROM scrape_jobs WHERE id = ${JOB_ID});" \
      2>/dev/null | grep -q '^t$'; then
    break
  fi
  sleep 2
  QUEUE_WAIT=$((QUEUE_WAIT + 2))
done

if [ "$QUEUE_WAIT" -ge "$QUEUE_MAX_WAIT" ]; then
  fail "Worker did not consume the smoke-test job within ${QUEUE_MAX_WAIT}s"
fi
pass "Worker consumed the job from scrape_jobs (empty queue after ~${QUEUE_WAIT}s)"

# Progress delivery: the worker's 'started' event fires during prepare (before
# any network fetch), so it must arrive over SSE even on a fresh deployment.
PROGRESS_MAX_WAIT=30
PROGRESS_WAIT=0
while [ "$PROGRESS_WAIT" -lt "$PROGRESS_MAX_WAIT" ]; do
  if grep -q '"type":"started"' "$SSE_OUT" 2>/dev/null; then
    break
  fi
  sleep 1
  PROGRESS_WAIT=$((PROGRESS_WAIT + 1))
done

if [ "$PROGRESS_WAIT" -ge "$PROGRESS_MAX_WAIT" ]; then
  fail "No progress event arrived over SSE within ${PROGRESS_MAX_WAIT}s"
fi
pass "Progress event streamed over SSE (type=started) within ~${PROGRESS_WAIT}s"

echo ""
echo -e "${GREEN}🎉 Smoke test passed: API, SPA, queue consumption, and progress delivery.${NC}"
