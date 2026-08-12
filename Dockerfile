# Multi-stage image for the Movie Planner web and worker roles.

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/
COPY scraper/package.json ./scraper/
COPY packages/scraper-protocol/package.json ./packages/scraper-protocol/
RUN npm ci --legacy-peer-deps && \
    npm cache clean --force && \
    rm -rf ~/.npm /tmp/* /var/tmp/*

FROM node:24-slim AS frontend-builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY client/ ./client/
ARG VITE_APP_NAME=Movie-Planner
ARG VITE_API_BASE_URL=/api
ENV VITE_APP_NAME=${VITE_APP_NAME}
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build --workspace=client && \
    rm -rf node_modules/.cache client/node_modules/.vite

FROM node:24-slim AS web-builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server/ ./server/
COPY packages/ ./packages/
RUN npm run build --workspace=@movie-planner/scraper-protocol && \
    cd server && npx tsc -p tsconfig.json && cd /app && \
    rm -rf node_modules/.cache && \
    find ./server/dist -name "*.map" -delete

FROM node:24-slim AS worker-builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY scraper/ ./scraper/
COPY packages/ ./packages/
RUN npm run build --workspace=@movie-planner/scraper-protocol && \
    cd scraper && npx tsc -p tsconfig.json && cd /app && \
    rm -rf node_modules/.cache && \
    find ./scraper/dist \( -name "*.map" -o -name "*.d.ts" \) -delete

FROM node:24-slim AS production
RUN apt-get update && \
    apt-get install -y --no-install-recommends dumb-init chromium fonts-liberation && \
    rm -rf /var/lib/apt/lists/*
RUN groupadd -r -g 1001 nodejs && useradd -r -g nodejs -u 1001 -m nodejs

WORKDIR /app
RUN chown nodejs:nodejs /app
COPY docker/entrypoint.sh /usr/local/bin/movie-planner-entrypoint
RUN chmod 755 /usr/local/bin/movie-planner-entrypoint

USER nodejs
COPY --chown=nodejs:nodejs package.json package-lock.json ./
COPY --chown=nodejs:nodejs client/package.json ./client/
COPY --chown=nodejs:nodejs server/package.json ./server/
COPY --chown=nodejs:nodejs scraper/package.json ./scraper/
COPY --chown=nodejs:nodejs packages/scraper-protocol/package.json ./packages/scraper-protocol/
RUN npm ci --omit=dev --workspaces --legacy-peer-deps && \
    npm cache clean --force && \
    rm -rf ~/.npm /tmp/*

COPY --from=web-builder --chown=nodejs:nodejs /app/server/dist ./server/dist
COPY --from=web-builder --chown=nodejs:nodejs /app/server/src/config/theaters.json ./server/dist/config/theaters.json
COPY --from=web-builder --chown=nodejs:nodejs /app/packages/scraper-protocol/dist ./packages/scraper-protocol/dist
COPY --from=worker-builder --chown=nodejs:nodejs /app/scraper/dist ./scraper/dist
COPY --from=frontend-builder --chown=nodejs:nodejs /app/client/dist ./server/public
COPY --chown=nodejs:nodejs migrations ./migrations

ENV CHROME_PATH=/usr/bin/chromium
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/movie-planner-entrypoint"]
CMD ["web"]
