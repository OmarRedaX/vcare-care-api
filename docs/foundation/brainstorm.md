---
title: foundation — Brainstorm
owner: care-team
service: care-service
module: foundation
status: draft
diataxis: explanation
last_verified: 2026-09-15
tags: [brainstorm, foundation, bootstrap, infrastructure, testing, ci, docker]
related: [system-design, infrastructure, deployment, overview, quickstart, adr-0006-health-split-redis-tier-2, adr-0008-care-worker-component]
---

# foundation — Brainstorm

## Problem & purpose
No application code exists. Every business module (`specialties`, `doctors`, `consultations`, …) needs the same
runnable skeleton first: two listeners, the one error envelope, request ids, a redacting logger, env validation,
DI, Postgres + Redis connections, idempotency and rate-limit middleware, health, a worker entrypoint, Docker,
CI, and a real test environment. This module builds that skeleton — **only what every module needs on day one**.
Structural reference (not a rulebook): `../../Core service ( Quick bite )` — its `src/lib`, `src/pkg`, `tests/helpers`,
`docker-compose.test.yml`, `Dockerfile`, `.github/workflows/ci.yml`. Where it disagrees with CLAUDE.md, CLAUDE.md wins
(e.g. no `jsonwebtoken`, no `uuid`/`dotenv`, `X-Request-Id` not `X-CorrelationId`, one error envelope with codes).

## Actors
Developers and agents building later modules; the orchestrator (health probes); CI.

## In scope (this iteration)
- **Tooling:** `package.json` (Node 24, scripts `dev`, `dev:worker`, `build`, `start`, `start:worker`, `typecheck`, `lint`,
  `test` (unit), `test:integration`, `migrate`, `migrate:rollback`, `migrate:make`), `tsconfig.json`
  (`strict`, `noUncheckedIndexedAccess`, decorators + `emitDecoratorMetadata` for tsyringe), ESLint flat config with
  `no-restricted-imports` enforcing the forbidden-library list and the layering (`pkg/` ↛ `lib/`,`app/`; `lib/` ↛ `app/`),
  Jest configs for unit and integration.
- **Entrypoints:** `src/server.ts` (both listeners, graceful shutdown: not-ready → close listeners → drain up to
  `SHUTDOWN_TIMEOUT_MS` → destroy Knex, quit Redis), `src/app.ts` (`/api`), `src/internal-app.ts` (`/internal`),
  `src/routes.ts`, `src/internal-routes.ts`, `src/worker.ts` (**empty runnable skeleton**: poll loop runner with no jobs,
  graceful stop after the current tick — ADR 0008).
- **lib/:** `config/env.ts` (zod — only the variables the foundation uses; later modules add theirs), `di/`
  (`container.ts`, `tokens.ts`, `Symbol.for()`), `error/` (`AppError`, `errorHandler`, shared codes `ValidationFailed`,
  `NotFound`, `Conflict`, `IdempotencyConflict`, `RateLimited`, `InternalError`, `Unauthorized`, `Forbidden`), `logger/`
  (structured JSON, `service="care-service"`, key-name redaction list from infrastructure.md, request logging with route
  pattern/status/durationMs), `request-id/` (UUID-only adopt, else generate with `crypto.randomUUID`), `http/`
  (`response.ts` `sendSuccess`, `no-store` helper, `pagination/` opaque cursor encode/decode + `limit+1` meta builder,
  in-house dev-only CORS allowlist middleware), `validation/` (`validateBody`/`validateQuery`/`validateParams`,
  `forbidNonWhitelisted`, → `ValidationFailed` with `details[{field, issue}]`), `knex/` (`knex.ts` with
  `SET TIME ZONE 'UTC'` per connection, `knexfile.ts`), `redis/` (connection, `PING` health, Tier 2 status flag),
  `idempotency/` (`idempotency({ required })`, key `(route, principal-or-ip, key)`, body hash, 24 h, replay /
  `422 IdempotencyConflict` / missing-required → `400 ValidationFailed`; **skipped when Redis is down**, ADR 0006),
  `rate-limit/` (Redis sliding window factory, `429 RateLimited` + `Retry-After`, in-process fallback
  `max(1, floor(limit / RATE_LIMIT_FALLBACK_DIVISOR))` when Redis is down), `types/express.d.ts` (`req.requestId`,
  `req.auth?` shape declared only).
- **pkg/utils/:** `time.ts` (pure duration helpers used by the foundation), nothing speculative.
- **Health module** `src/app/health/` — `GET /api/health/live|ready`, `GET /internal/health/live|ready` per
  infrastructure.md → Health (Postgres fatal, Redis reported only, 503 during shutdown; bare objects, no token).
- **First migration:** `CREATE EXTENSION IF NOT EXISTS btree_gist` (proves the migration pipeline; needed by rule 1).
- **Docker:** multi-stage `Dockerfile` (node:24-alpine, non-root, one image for `care-api` and `care-worker`),
  `.dockerignore`, `docker-compose.yml` (postgres 17, redis 7, `care-api`, `care-worker`, migrate step),
  `docker-compose.test.yml`, `.env.example`, `.env.test`.
- **Local ports so both services run side by side:** Care Postgres host port **5433**, Redis **6380**
  (Identity keeps 5432/6379); app ports stay 3001/3101.
- **CI:** `.github/workflows/ci.yml` — install, lint, typecheck, unit, integration (Postgres + Redis service
  containers, migrations), docker build.
- **Test environment:** `tests/setup.ts` (no infra mocks), `tests/helpers/` (`db.ts` truncate-all keeping knex tables,
  `redis.ts` flush by prefix, `app.ts` building the real apps), a local fake-HTTP-server helper base for the future
  Identity fake (no Identity endpoints yet), log-capture helper for "no clinical strings in logs" assertions.
  Unit tests for every lib piece; integration tests for health, request id, error envelope, idempotency and rate
  limits against real Postgres/Redis (mounted on test-only routers inside the test suite, never in `src/routes.ts`).

## Out of scope
`lib/auth` (JWKS, user/service guards), `lib/rbac/authorize`, `lib/audit`, `lib/identity-client`, `lib/storage`,
`lib/video`, `lib/email`, outbox and sync-job tables, `pkg/slots`, any business table or route. Each lands with the
first module that needs it. No metrics exporter (ADR 0007 — log-derived).

## Key entities & relationships
None (no business tables). Redis keys: `idem:<route>:<principal>:<key>`, `rl:<name>:<subject>`.

## Primary flows / endpoints (with roles + ownership)
| Endpoint | Auth | Notes |
|---|---|---|
| `GET /api/health/live`, `GET /internal/health/live` | none | `{ "status": "ok" }` |
| `GET /api/health/ready`, `GET /internal/health/ready` | none | `{ status: ok\|degraded, checks: { database, redis } }`; 503 on Postgres down or shutdown |
Health routes are the only routes without `authorize(...)`, as infrastructure probes (documented exception).

## Business rules & state transitions
Readiness: Postgres down ⇒ 503; Redis down ⇒ 200 `degraded`; shutting down ⇒ 503.
Idempotency: same key + same body ⇒ replay status + body; different body ⇒ 422; required + missing ⇒ 400.

## Cross-service touchpoints (case, direction, failure policy)
None implemented. Identity is **not** a health dependency.

## Privacy & audit
Logger redaction list and "never log request bodies" rule are built in and unit-tested. No audit rows.

## Constraints & guideline notes
- Runtime deps limited to the locked stack plus **`reflect-metadata`** (tsyringe prerequisite) → ADR
  `0016-foundation-runtime-dependencies`. No `cors`, `uuid`, `dotenv` packages (in-house CORS, `crypto.randomUUID`,
  env from process / `--env-file`).
- Inline `interface`/`type` only in `types.ts` files, including in `lib/`.

## Contract changes expected
Replace `GET /api/health` and `GET /internal/health` with the four live/ready operations (ADR 0006).

## Open questions
- None blocking. Host ports 5433/6380 for Care are a local-dev default; update quickstart/infrastructure accordingly.
- Hub sync needed after the contract change (`../vcare-hub/scripts/sync-from-spoke.sh`).

## Success criteria
`docker compose up` serves `GET /api/health/ready` 200; `npm run lint`, `typecheck`, `test`, `test:integration`
green locally and in CI; worker starts and stops cleanly on SIGTERM; docs (infrastructure, quickstart, overview,
service card, INDEX) describe the as-built skeleton.
