#!/bin/bash
# Integration test script for Movie Planner
# Builds Docker stack, waits for health, runs E2E tests, and cleans up

set -e  # Exit on any error

echo "🚀 Starting integration tests..."
echo ""

# Trap to ensure cleanup on exit
cleanup() {
  echo ""
  echo "🧹 Cleaning up..."
  docker compose -f compose.yaml -f compose.e2e.yaml down
  echo "✅ Cleanup complete"
}
trap cleanup EXIT

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Step 1: Build and start Docker stack. The compose.e2e.yaml overlay opts the
# web role into the test-only /api/test/mailbox seam the verification E2E
# suite reads captured mail through.
echo "📦 Building and starting Docker stack..."
if docker compose -f compose.yaml -f compose.e2e.yaml up --build -d; then
  echo -e "${GREEN}✅ Docker stack started${NC}"
else
  echo -e "${RED}❌ Failed to start Docker stack${NC}"
  exit 1
fi

echo ""

# Step 2: Wait for services to be healthy
echo "⏳ Waiting for services to be healthy..."

# Wait for database
DB_MAX_WAIT=30
DB_WAIT=0
while [ $DB_WAIT -lt $DB_MAX_WAIT ]; do
  if docker compose exec -T db pg_isready -U postgres > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Database is healthy${NC}"
    break
  fi
  sleep 2
  DB_WAIT=$((DB_WAIT + 2))
done

if [ $DB_WAIT -ge $DB_MAX_WAIT ]; then
  echo -e "${RED}❌ Database health check timeout${NC}"
  docker compose logs db
  exit 1
fi

# Wait for web server service
WEB_MAX_WAIT=60
WEB_WAIT=0
echo "⏳ Waiting for web service to be healthy..."
while [ $WEB_WAIT -lt $WEB_MAX_WAIT ]; do
  if curl -f -s http://localhost:3000/api/health > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Web service is healthy${NC}"
    break
  fi
  sleep 2
  WEB_WAIT=$((WEB_WAIT + 2))
done

if [ $WEB_WAIT -ge $WEB_MAX_WAIT ]; then
  echo -e "${RED}❌ Web service health check timeout${NC}"
  docker compose logs web
  exit 1
fi

echo ""

# Step 3: Verify API health endpoint
echo "🔍 Verifying API health endpoint..."
HEALTH_RESPONSE=$(curl -s http://localhost:3000/api/health)
if echo "$HEALTH_RESPONSE" | grep -q "ok"; then
  echo -e "${GREEN}✅ API health check passed${NC}"
  echo "   Response: $HEALTH_RESPONSE"
else
  echo -e "${RED}❌ API health check failed${NC}"
  echo "   Response: $HEALTH_RESPONSE"
  exit 1
fi

echo ""

# Step 4: Run E2E tests with Playwright
echo "🎭 Running Playwright E2E tests..."
echo ""

if npx playwright test; then
  echo ""
  echo -e "${GREEN}✅ All E2E tests passed${NC}"
else
  echo ""
  echo -e "${RED}❌ E2E tests failed${NC}"
  echo ""
  echo "📋 Capturing logs for debugging..."
  echo ""
  echo "=== Web Service Logs ==="
  docker compose logs web | tail -100
  echo ""
  echo "=== Database Logs ==="
  docker compose logs db | tail -50
  exit 1
fi

echo ""
echo -e "${GREEN}🎉 Integration tests completed successfully!${NC}"
