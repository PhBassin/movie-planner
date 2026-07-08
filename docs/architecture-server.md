# Architecture — Server (allo-scrapper)

> Generated: 2026-05-21 | Express 5.2 + PostgreSQL 15 + Redis 7

## Overview

The server is the central API backend for allo-scrapper. It follows a **layered architecture** pattern:

```
Routes (HTTP handlers) → Services (business logic) → DB Queries (data access) → PostgreSQL
                                                           ↕
                                                       Redis (cache/queue)
```

---

## Directory Structure

```
server/src/
├── app.ts              # Express app setup, middleware registration
├── index.ts            # Entry point — HTTP server bootstrap
├── db/                 # Database layer (Drizzle ORM)
│   ├── client.ts       # PostgreSQL connection
│   ├── schema.ts       # Table definitions
│   ├── migrations.ts   # Migration runner
│   └── *-queries.ts    # Per-table query modules
├── middleware/          # Express middleware
│   ├── auth.ts         # JWT authentication
│   ├── permission.ts   # Role-based authorization
│   ├── rate-limit.ts   # Rate limit enforcement (subscribes to source)
│   └── error-handler.ts
├── routes/             # HTTP route handlers
│   ├── auth.ts         # Authentication endpoints
│   ├── movies.ts       
│   ├── theaters.ts     
│   ├── users.ts        
│   ├── roles.ts        
│   ├── scraper.ts      
│   ├── reports.ts      
│   ├── settings.ts     
│   ├── system.ts       
│   └── admin/          # Admin-only routes
│       └── rate-limits.ts
├── services/           # Business logic layer
│   ├── auth-service.ts
│   ├── movie-service.ts
│   ├── scraper-service.ts
│   ├── theater-service.ts
│   ├── user-service.ts           # Admin CRUD; owns last-admin invariant
│   ├── system-info.ts
│   ├── theme-generator.ts
│   ├── progress-tracker.ts
│   ├── redis-client.ts
│   ├── rate-limit-source.ts      # Single source of truth for rate-limit config
│   └── rate-limit-refresher.ts   # 60s poller → source.loadFromDb
├── types/              # TypeScript type definitions
│   ├── api.ts
│   ├── user.ts
│   ├── role.ts
│   ├── scraper.ts
│   └── settings.ts
└── utils/              # Utility functions
    ├── cors-config.ts
    ├── date.ts
    ├── errors.ts
    ├── html-decode.ts
    ├── image-validator.ts
    ├── json-parse-cache.ts
    ├── jwt-config.ts
    ├── jwt-secret-validator.ts
    ├── logger.ts
    ├── number.ts
    ├── security.ts
    ├── showtimes.ts
    └── url.ts
```

---

## Request Lifecycle

1. **HTTP Request** → `index.ts` (server.listen)
2. **CORS** → `utils/cors-config.ts`
3. **Security Headers** → Helmet
4. **Body Parsing** → express.json()
5. **Rate Limiting** → `middleware/rate-limit.ts` (subscribes to `services/rate-limit-source.ts`)
6. **Route Matching** → Express router
7. **JWT Auth** → `middleware/auth.ts` (if route requires)
8. **Permission Check** → `middleware/permission.ts` (if route requires)
9. **Route Handler** → `routes/*.ts`
10. **Business Logic** → `services/*.ts`
11. **Data Access** → `db/*-queries.ts`
12. **Response** → JSON
13. **Error Handling** → `middleware/error-handler.ts` (on error)

---

## Key Design Decisions

### Authentication
- JWT-based with access + refresh token pattern
- Secrets validated via `utils/jwt-secret-validator.ts`
- Token configuration in `utils/jwt-config.ts`

### Authorization
- Role-based access control (RBAC)
- Granular permissions per role
- Middleware: `requirePermission` checks against user roles
- The "at least one admin remains" invariant lives in `services/user-service.ts` (`assertNotLastAdmin`) and is the only place that calls `db/user-queries.getAdminCount`. Both `updateUserRole` and `deleteUser` delegate to it so adding a third entry point (admin CLI, scheduled job) cannot accidentally re-implement the rule.

### Rate Limiting
- Configurable per-endpoint rate limits
- Single source of truth at `services/rate-limit-source.ts`: holds the flat `RateLimitConfig` consumed by middleware and the wrapped `RateLimitAuditInfo` returned to the admin display only
- Resolution order (DB row in `rate_limit_configs` → `RATE_LIMIT_*` env vars → built-in defaults) lives in one place; the env-var parsing happens at module-load and is replaced when the source loads from DB
- `middleware/rate-limit.ts` subscribes to the source; every successful `loadFromDb` rebuilds the limiter delegates, so the per-request hot path is sync
- `services/rate-limit-refresher.ts` polls the DB every 60s and calls `source.loadFromDb(db)`
- Admin panel for configuration at `/api/admin/rate-limits` (uses `getAuditInfo(db)` for display)

### Redis Integration
- BullMQ for job queues (scraper communication)
- Connection via `services/redis-client.ts`
- Progress tracking via `services/progress-tracker.ts`

### Logging
- Winston logger via `utils/logger.ts`
- Structured JSON logging

### Security
- Helmet for HTTP headers
- CORS configuration
- Input validation with Zod
- HTML decode for XSS prevention
- Image validation for upload safety

---

## Configuration

| Env Variable | Purpose |
|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `JWT_SECRET` | JWT signing secret |
| `JWT_REFRESH_SECRET` | Refresh token secret |
| `PORT` | Server port (default: 3001) |
| `CORS_ORIGIN` | Allowed CORS origins |
| `NODE_ENV` | Environment (development/production) |

---

## Testing

- **Framework:** Vitest
- **Test files:** Co-located with source (`*.test.ts`)
- **Coverage targets:** 80% lines, 80% functions, 80% statements, 65% branches
