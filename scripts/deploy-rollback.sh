#!/bin/bash
# Rollback allo-scrapper to a specific image tag on the VPS.
#
# Usage:
#   ./scripts/deploy-rollback.sh <tag>
#
# Examples:
#   ./scripts/deploy-rollback.sh v4.7.3   # roll back to a specific version
#   ./scripts/deploy-rollback.sh v4.7.2
#   ./scripts/deploy-rollback.sh stable   # re-follow the moving stable tag
#
# Behavior:
#   - Pulls the requested tag for ics-web, ics-scraper, ics-scraper-cron
#   - Recreates those three containers only (DB/Redis/Traefik untouched)
#   - Note: if you roll back to a specific version tag (vX.Y.Z), Watchtower
#     will NOT roll it forward because that tag is immutable. To resume
#     auto-updates, run again with "stable".

set -euo pipefail

TAG="${1:-}"

if [[ -z "$TAG" ]]; then
    echo "Usage: $0 <tag>"
    echo "  $0 v4.7.3     # specific version"
    echo "  $0 stable     # moving tag (Watchtower will resume auto-updates)"
    exit 1
fi

# Locate the deployment dir (VPS layout or repo root for local testing)
if [[ -f /opt/allo-scrapper/deploy/docker-compose.prod.yml ]]; then
    cd /opt/allo-scrapper
elif [[ -f deploy/docker-compose.prod.yml ]]; then
    cd "$(dirname "$0")/.."
else
    echo "❌ Cannot locate deploy/docker-compose.prod.yml"
    echo "   Expected at /opt/allo-scrapper/deploy/ or current repo root."
    exit 1
fi

if [[ ! -f .env ]]; then
    echo "❌ .env not found in $(pwd)"
    echo "   Create it from deploy/.env.example first."
    exit 1
fi

COMPOSE="docker compose -f docker-compose.yaml -f deploy/docker-compose.prod.yml --env-file .env"

echo "⏮  Rolling back ics-web / ics-scraper / ics-scraper-cron to tag: ${TAG}"
echo ""

# Pull the requested tag explicitly (avoid stale cache)
WEB_IMAGE="ghcr.io/phbassin/allo-scrapper:${TAG}"
SCRAPER_IMAGE="ghcr.io/phbassin/allo-scrapper-scraper:${TAG}"
echo "📦 Pulling ${WEB_IMAGE}"
docker pull "${WEB_IMAGE}"
echo "📦 Pulling ${SCRAPER_IMAGE}"
docker pull "${SCRAPER_IMAGE}"

# Recreate the three app containers with the requested tag.
# DB / Redis / Traefik / Watchtower are left running.
IMAGE_TAG="$TAG" $COMPOSE up -d --no-deps --force-recreate ics-web ics-scraper ics-scraper-cron

echo ""
echo "⏳ Waiting for ics-web to become healthy..."
sleep 5
$COMPOSE ps

echo ""
echo "🔍 Health check:"
if curl -fsS "http://localhost:3000/api/health" > /dev/null 2>&1; then
    echo "  ✓ API responding on localhost:3000"
else
    echo "  ⚠ API not responding yet (may still be starting). Check with:"
    echo "    $COMPOSE logs -f ics-web"
fi

echo ""
echo "Current images:"
$COMPOSE images ics-web ics-scraper ics-scraper-cron

echo ""
if [[ "$TAG" =~ ^v[0-9] ]]; then
    echo "ℹ️  Pinned to immutable tag ${TAG}. Watchtower will NOT auto-update."
    echo "   To resume auto-updates: $0 stable"
else
    echo "ℹ️  Following moving tag '${TAG}'. Watchtower will resume polling in ~5 min."
fi
