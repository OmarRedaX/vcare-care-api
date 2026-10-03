---
title: Infrastructure
owner: care-team
service: care-service
status: draft
diataxis: reference
last_verified: 2026-10-03
tags: [infrastructure, env, logging, errors, health, configuration, deployment, shutdown, postgres, redis]
related: [overview, resilience, runbook, quickstart, deployment, capacity, foundation-spec, access-spec, adr-0018-db-role-split-explicit-grants-partition-function, adr-0006-health-split-redis-tier-2, adr-0016-foundation-runtime-dependencies, hub-deployment, hub-adr-0005-single-origin-edge-routing, hub-adr-0007-managed-container-platform]
---

# Infrastructure — care-service

## Environment variables
Every variable is declared and validated in `lib/config/env.ts` (zod); only that file reads `process.env`
(lint-enforced). An invalid environment stops the process before anything else runs: one JSON line
`{"level":"error","message":"invalid_environment","keys":[…]}` on stderr naming the **keys only** (never values), then
exit 1. Empty strings count as unset. **Secrets have no defaults.**

### Implemented (foundation 2026-09-28; access 2026-10-02)
| Variable | Default | Secret | Purpose / rule |
|---|---|---|---|
| `NODE_ENV` | `development` | | `development` \| `test` \| `production`; gates dev CORS and the `LOG_LEVEL=debug` ban |
| `PORT` | `3001` | | public listener (`/api/*`), binds `0.0.0.0` |
| `INTERNAL_PORT` | `3101` | | internal listener (`/internal/*`); must differ from `PORT` |
| `INTERNAL_HOST` | `127.0.0.1` | | bind address of the internal listener. **Must be an IPv4 or IPv6 literal**: host names (`localhost`) and malformed addresses (`999.999.999.999`, `1.2.3`) are rejected at env validation. Deployments set the task's private interface; the compose `care-api` container uses `0.0.0.0`, published on host loopback only |
| `TRUST_PROXY_HOPS` | `0` | | 0–5. Number of trusted proxies that append to `X-Forwarded-For`; `lib/http/client-ip.ts` takes the entry this many places from the right (the socket address when `0` or when the header is shorter). Feeds per-IP rate limits and anonymous idempotency principals; Express `trust proxy` stays off. **Must equal the number of trusted proxies in front of `care-api`**: `0` behind a proxy makes every caller look like the proxy (one shared per-IP limit), too high lets a caller spoof its IP. The production value follows the edge chain in the hub (`../vcare-hub/architecture/deployment.md`) and is not recorded there yet; there is no boot guard against `0` in production ([#16](https://github.com/OmarRedaX/vcare-care-api/issues/16)) |
| `DATABASE_URL` | — | **yes, no default** | `postgres:`/`postgresql:` URL of the primary **as the app login `care_app`** (member of `vcare_app`; [ADR 0018](../adr/0018-db-role-split-explicit-grants-partition-function.md)), used by `care-api` and `care-worker`; `ensure-app-login` creates/updates that login from this URL. Its query string **must not** carry `options`, `statement_timeout`, `query_timeout`, or `application_name`: pg would let them override Care's per-pool session settings (below), so boot fails with `invalid_environment` naming `DATABASE_URL`. Other parameters (`sslmode`, `sslrootcert`, …) are accepted. Local: `postgres://care_app:care_app@localhost:5433/care` (compose host port 5433) |
| `MIGRATION_DATABASE_URL` | — (optional in the shared schema) | **yes, no default** | the **owner** (`care`) URL, same rules as `DATABASE_URL`. Required only by `src/migrate.ts` (`getMigrationEnv()`: missing → `invalid_environment` naming it, exit 1) and the integration-test setup; `care-api` and `care-worker` never need it. Rejected when its user equals `DATABASE_URL`'s ("must use a different role than DATABASE_URL"). Local: `postgres://care:care@localhost:5433/care` |
| `DATABASE_POOL_MAX` | `20` | | 1–100, request pool size per `care-api` task. The readiness probe has its own extra connection, so a task opens up to `DATABASE_POOL_MAX + 1` |
| `REDIS_URL` | — | **yes, no default** | `redis:`/`rediss:` URL. Local: `redis://localhost:6380` (compose host port 6380) |
| `IDENTITY_JWKS_URL` | — (**no default**: a wrong default would 401 every request silently) | | `http:`/`https:` URL of Identity's public `GET /.well-known/jwks.json`. Required by the shared schema, so `care-worker` and `care-migrate` set it too. Local: `http://localhost:3000/.well-known/jwks.json` (wherever the local identity public listener runs); compose: `${IDENTITY_JWKS_URL:-http://host.docker.internal:3000/.well-known/jwks.json}` |
| `AUDIT_PARTITION_MONTHS_AHEAD` | `2` | | 1–12; monthly `audit_logs` partitions the worker keeps ahead of the current UTC month ([ADR 0009](../adr/0009-audit-logs-monthly-partitions.md)) |
| `CORS_ORIGINS` | `""` (none) | | comma-separated origins (`scheme://host[:port]`, no path), honoured only when `NODE_ENV=development`; production is single-origin with CORS disabled (hub ADR 0005). `.env.example` sets `http://localhost:5173` |
| `LOG_LEVEL` | `info` | | `debug` \| `info` \| `warn` \| `error`; `debug` is rejected when `NODE_ENV=production` |
| `RATE_LIMIT_FALLBACK_DIVISOR` | `2` | | per-instance fallback limit `max(1, floor(limit / divisor))` when Redis is down ([ADR 0006](../adr/0006-health-split-redis-tier-2.md)) |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | | 1 000–60 000; deadline for draining requests **and** closing resources on `SIGTERM` (server and worker) |
| `WORKER_POLL_INTERVAL_MS` | `1000` | | ≥ 100; default `care-worker` loop interval ([ADR 0008](../adr/0008-care-worker-component.md)) |

### Planned (declared by the module that first uses them)
| Variable | Default (local) | Secret | Purpose |
|---|---|---|---|
| `DATABASE_READ_URL` | unset | yes | optional read replica for discovery reads |
| `IDENTITY_INTERNAL_URL` | `http://localhost:3100` | | Identity internal listener |
| `IDENTITY_TIMEOUT_MS` | `2000` | | per-attempt timeout for Identity calls |
| `SERVICE_CLIENT_ID` | `care-service` | | client-credentials id |
| `SERVICE_CLIENT_SECRET` | — | **yes, no default** | client-credentials secret |
| `HYDRATION_CACHE_TTL_SECONDS` | `300` | | Case 2 cache TTL |
| `UPLOAD_INTENT_TTL_SECONDS` | `900` | | upload intent lifetime ([file-handling.md](./file-handling.md), ADR 0013) |
| `UPLOAD_POLICY_TTL_SECONDS` | `300` | | presigned POST validity; must be ≤ `UPLOAD_INTENT_TTL_SECONDS` |
| `DOWNLOAD_URL_TTL_SECONDS` | `60` | | presigned GET validity; must be ≤ 60 (ADR 0014) |
| `BOOKING_HORIZON_DAYS` | `60` | | Domain rule 3 |
| `CANCELLATION_POLICY_MINUTES` | `120` | | Domain rule 10 |
| `NO_SHOW_GRACE_MINUTES` | `10` | | Domain rule 11 |
| `WAITING_ROOM_OPEN_MINUTES` | `10` | | Domain rule 12 (window opens before start) |
| `SESSION_OVERRUN_MINUTES` | `15` | | Domain rule 12 (window closes after end) |
| `SLOT_CACHE_TTL_SECONDS` | `60` | | must be ≤ 60 |
| `NEXT_AVAILABLE_CACHE_TTL_SECONDS` | `300` | | |
| `STORAGE_ENDPOINT` | `http://localhost:9000` | | S3-compatible object storage |
| `STORAGE_REGION` | `us-east-1` | | |
| `STORAGE_BUCKET` | `care-private` | | private bucket; never public |
| `STORAGE_ACCESS_KEY_ID` | — | **yes, no default** | |
| `STORAGE_SECRET_ACCESS_KEY` | — | **yes, no default** | |
| `UPLOAD_MAX_BYTES` | `10485760` | | 10 MB cap |
| `VIDEO_PROVIDER_URL` | provider base URL | | room provider behind `lib/video` |
| `VIDEO_PROVIDER_KEY` | — | **yes, no default** | |
| `VIDEO_JOIN_TOKEN_TTL_SECONDS` | `300` | | per-participant token lifetime |
| `EMAIL_PROVIDER_URL` | provider base URL | | behind `lib/email` |
| `EMAIL_PROVIDER_KEY` | — | **yes, no default** | |
| `EMAIL_FROM` | `no-reply@vcare.example.test` | | |
| `RATE_LIMIT_SEARCH_PER_IP_PER_MIN` | `60` | | |
| `RATE_LIMIT_SEARCH_PER_USER_PER_MIN` | `120` | | |
| `RATE_LIMIT_BOOKING_PER_USER_PER_MIN` | `10` | | |
| `RATE_LIMIT_UPLOADS_PER_USER_PER_HOUR` | `20` | | |
| `WORKER_BATCH_SIZE` | `20` | | rows claimed per poll |
| `OUTBOX_MAX_ATTEMPTS` | `8` | | notification attempts before `dead` ([ADR 0011](../adr/0011-notification-outbox-and-reminders.md)) |
| `OUTBOX_RETENTION_DAYS` | `30` | | purge of `sent` outbox rows |
| `REMINDER_SCAN_INTERVAL_MS` | `60000` | | reminder scan cadence |

Token issuer, audience, algorithm, clock tolerance (30 s), and the JWKS cache policy are **constants** in
`lib/auth/constants.ts`, not env (the contract fixes them; the planned `JWT_ISSUER`/`JWT_AUDIENCE` variables were
dropped): `iss=vcare-identity`, `aud` ∋ `vcare-care`, `alg=EdDSA`; JWKS refresh every 5 min, demand fetch at most once
per minute, keys trusted ≤ 1 h after the last success, fetch bounded by 2 s and 64 KiB, ≤ 16 keys; bearer tokens over
4 096 characters are rejected unparsed.

## Database connection
Built by `createKnex` (`lib/knex/knex.ts`); full rationale in the [foundation spec](../foundation/spec.md) §3.4.8.

| Pool | `application_name` | Size | Statement / query timeout | Acquire timeout |
|---|---|---|---|---|
| request pool (`db`, `care-api`) | `care-api` | `DATABASE_POOL_MAX` (default 20) | 2 s server / 3 s client | 1 s |
| readiness probe (`probeDb`, `care-api`) | `care-api-probe` | 1 | 2 s / 3 s | 1 s |
| `care-worker` (`src/worker.ts`) | `care-worker` | 2 | 5 s / 6 s | 1 s |
| `care-migrate` (owner, `MIGRATION_DATABASE_URL`) | `care-migrate` | 1 | none | 60 s |

**Database roles ([ADR 0018](../adr/0018-db-role-split-explicit-grants-partition-function.md)).** `care` is the owner:
it owns every table, sequence, and function and runs the migrations (`care-migrate` only). `vcare_app` is a `NOLOGIN`
group role created by migration `create_app_role` with `CONNECT` and `USAGE ON SCHEMA public` (never `CREATE`);
every table migration grants it exactly what the code needs, explicitly (no `ALTER DEFAULT PRIVILEGES`); append-only
tables get `INSERT, SELECT` only (column-level `INSERT` on `audit_logs`: never `id`/`created_at`). `care_app` is the login of `care-api` and `care-worker` (`DATABASE_URL`), member of
`vcare_app`, `NOSUPERUSER NOCREATEDB NOCREATEROLE`; `node dist/migrate.js ensure-app-login` creates it or re-syncs its
password and membership (never a migration, so no password is committed); it refuses an existing role that is
privileged or owns objects (`app_login_role_privileged`) and never logs a failed DDL statement (`app_login_ddl_failed`). `care-migrate` runs `latest` then
`ensure-app-login`; the owner needs `CREATEROLE`. The worker creates `audit_logs` partitions only through the
owner-defined `SECURITY DEFINER` function `audit_logs_ensure_partitions(int)`.

- Pools are lazy (`min: 0`): importing a module opens no connection, and Postgres is **not** checked at boot
  (readiness reports it, so a blip cannot restart-loop tasks).
- **Session settings travel as startup parameters**, with no extra round trip inside the acquire window:
  `TimeZone=UTC` (via `options=-c TimeZone=UTC`), `statement_timeout`, and `application_name`. `DATABASE_URL` cannot
  override them (see the variable above).
- **Client-side bounds:** connect timeout 2 s (also the pool's create timeout); `query_timeout` = statement timeout
  + 1 s, which fires only when the server cannot (e.g. a failover without a TCP reset); TCP keepalive after 10 s idle.
- **A timed-out connection is discarded, never reused:** the pool's `validate` (`lib/knex/pg-connection-state.ts`)
  rejects a free connection that still has an active, queued, or unanswered query, so the next acquire gets a fresh
  connection. The helper reads pg-private fields and is pinned to pg 8.23 by a unit test; re-verify it before
  bumping pg.
- Knex never interpolates bindings into an error message (`compileSqlOnError: false`), and its own warnings go
  through the JSON logger (`knex_warn` / `knex_error` / `knex_deprecated`), never `console`.
- Type parsers: `int8` → `number` (throws beyond `Number.MAX_SAFE_INTEGER`; hub ADR 0004); `date` → raw
  `YYYY-MM-DD` string; `TIMESTAMPTZ` → `Date`. **Not yet:** `int8[]` (OID 1016) has no parser, so `array_agg(id)`
  returns string ids ([#17](https://github.com/OmarRedaX/vcare-care-api/issues/17)).
- **Connection poolers:** before PgBouncer, RDS Proxy, or another pooler is introduced ([deployment.md](./deployment.md)
  → Bottlenecks 4), verify that it forwards the `options` and `statement_timeout` startup parameters. PgBouncer, for
  example, refuses startup parameters it does not track unless they are listed in `ignore_startup_parameters`, and
  then drops them. If they are not forwarded, `TimeZone` and the statement timeout move back to a pool `afterCreate`
  that runs `SET` statements (spec §3.4.8).
- Migrations are raw SQL (`knex.raw`), one change per file, real `down` ([ADR 0001](../adr/0001-no-orm-knex-raw-sql.md)).
  The first migration creates `btree_gist`. `knex_migrations.name` is recorded **without** the file extension, so
  `node dist/migrate.js` and `npm run migrate` (tsx over `src/`) agree on one database.
- The application role (`vcare_app`) has `INSERT`/`SELECT` only on `audit_logs` (and every partition) and, when it
  lands, `medical_record_amendments` — by explicit grant, so `UPDATE`/`DELETE`/`TRUNCATE` fail with `42501`.
- **Read replica (when introduced):** discovery reads (search, doctor profile, slots) may use `DATABASE_READ_URL`.
  Writes, booking/reschedule re-validation, ownership checks for clinical data, and audit writes always use the
  primary. Replica lag is acceptable for discovery because booking re-proves availability on the primary.

## Redis connection
`lib/redis/redis.ts` (ioredis): `lazyConnect`, connected in the background at boot and never awaited;
`enableOfflineQueue: false` (commands fail fast while disconnected, so Tier 2 fallbacks engage at once);
`maxRetriesPerRequest: 1`; connect timeout 2 s; **command timeout 500 ms**; reconnect backoff `min(n × 200, 2000)` ms,
forever; `autoResendUnfulfilledCommands: false` (a command on the wire when the connection dropped is never replayed
later). Transitions log once each: `warn redis_unavailable`, `info redis_recovered` (the first `ready` at boot also
logs `redis_recovered`). **Breaker** (`lib/redis/breaker.ts`, fixes [#10](https://github.com/OmarRedaX/vcare-care-api/issues/10)):
every idempotency and rate-limit command goes through `withRedis`, which feeds a per-client breaker; after 3
consecutive failures it opens for 5 s (`warn redis_breaker_open` + metric `redis_breaker_open`), during which those
middlewares skip Redis (`idempotency_skipped{reason:"redis_breaker_open"}`, rate limiter on its memory fallback);
then exactly one half-open probe decides (`info redis_breaker_closed`). Worst case for a Redis that stalls while
`ready`: 3 × 500 ms per 5 s per process. The readiness `PING` does not feed the breaker.

## Logging
Structured JSON, one line per event, on stdout. Field order (parity with identity-service):
`level, message, timestamp (ISO UTC), service="care-service", requestId?, userId?, role?, route?, method?, status?,
code?, durationMs?`, then other context. `requestId` comes from an `AsyncLocalStorage` request context, so lines
written by services, repositories, and async continuations carry it without passing a logger around.

- `request_completed` per request: route **pattern** (`req.baseUrl + req.route.path`, else `unmatched`), method,
  status, error `code`, `durationMs`, and `userId`/`role` once the user guard verified a token. Level `error` for 5xx,
  `debug` for `/health/` routes below 500 (invisible at `LOG_LEVEL=info`), else `info`; `warn request_aborted` when
  the client disconnects first. Never the URL, query string, headers, or bodies. The pattern is captured on
  `res.locals` by the guard, `authorize`, the limiter, idempotency, and every sealed router's error layer, so it keeps
  the full mount prefix when a nested router's handler throws (fixes [#6](https://github.com/OmarRedaX/vcare-care-api/issues/6)).
- Metrics are log lines (`message: "metric"`, `metric`, `value`, `dims`; [ADR 0007](../adr/0007-log-derived-metrics.md)).
- `console.*` is banned in `src/` (lint); Knex's messages are routed through the logger.

**Never logged:** complaint text, examination notes, diagnosis text or code, treatment plans, allergies, chronic
conditions, blood type, date of birth, document or attachment contents, object keys, presigned URLs and POST fields, names, emails,
phones, `Authorization` headers, bearer tokens or any part of them (`kid`, `jti`, signature), the JWKS URL path or
response body (only its host), database URLs and the app-login user/password, audit `metadata`, service or video
tokens, request bodies of clinical or consultation routes.

**Redaction mechanics** (defence in depth; callers must not pass these): keys are compared after
`key.toLowerCase().replace(/[_-]/g, "")`, so `date_of_birth` and `date-of-birth` match `dateOfBirth`; a match is
replaced by `"[REDACTED]"`, recursively through objects and arrays; depth > 8 → `"[Truncated]"`; cycles →
`"[Circular]"`; the `message` string is never rewritten. Keys: `complaintText`, `examinationNotes`, `diagnosisText`,
`diagnosisCode`, `treatmentPlan`, `allergies`, `chronicConditions`, `bloodType`, `dateOfBirth`, `objectKey`,
`downloadUrl`, `uploadUrl`, `joinToken`, `authorization`, `cookie`, `setCookie`, `fullName`, `displayName`,
`firstName`, `lastName`, `email`, `phone`, `password`, `token`, `accessToken`, `refreshToken`, `serviceToken`,
`clientSecret`, `body`, `requestBody`, `connectionString`, `databaseUrl`, `migrationDatabaseUrl`. Tests assert that captured logs contain no clinical fixture strings.

**Errors in logs:** an `Error` passed under the `error` field is serialized to `{ name, message, code?, stack? }`; a
database error (SQLSTATE `code`) keeps only identifiers (`name, code, severity?, constraint?, table?, column?,
routine?, stack?`) and **no message**, because Postgres copies the rejected value into it; stacks are rebuilt from
frame lines only; a thrown non-`Error` is logged as `NonError` without its value. Not yet fixed: an error logged under
any other key (e.g. `cause`) is only redacted, not serialized, so a pg error's `detail`, `where`, and `hint` would be
written ([#13](https://github.com/OmarRedaX/vcare-care-api/issues/13)); every current call site uses `error`.

## Error envelope
Produced only by `lib/error/errorHandler.ts`, identical in shape to identity-service:
```json
{ "success": false, "error": { "code": "SlotUnavailable", "message": "The selected slot is no longer available", "details": [], "requestId": "3f0e4c1a-7b5d-4e2a-9c61-0d2b8a6f5e11" } }
```
- `details` is always present: `[{ field, issue }]` for `ValidationFailed`, `[]` otherwise.
- Two errors add a sibling member next to `error`: `ScheduleConflictsUnconfirmed` adds `conflicts.consultationIds`;
  the Case 3 `IdentityUnavailable` adds `suspension: "applied-locally, session-revocation-pending"`.
- Malformed, oversized (> 100 kB), or unreadable JSON bodies → `400 ValidationFailed` (`field: "body"`).
- An unmatched path, or an unmatched method on a known path (including `OPTIONS` outside an allowed dev CORS
  preflight), → `404 NotFound` on both listeners; there is no 405.
- Unknown errors → `InternalError` (500) with no internals; the serialized error is logged server-side as
  `unhandled_error`. A malformed percent-encoded path parameter (Express's `URIError`) → `400 ValidationFailed`
  (`field: "path"`), never logged (its message holds the raw value); any other non-`AppError` with a numeric 4xx
  `status`/`statusCode` → `404 NotFound` for 404, else `400 ValidationFailed` (`field: "request"`), logged as
  `warn client_error_mapped { name, status }` (fixes [#5](https://github.com/OmarRedaX/vcare-care-api/issues/5)).
- Auth and authorization: `401 Unauthorized` (missing/invalid token, unknown `kid`, no usable JWKS key),
  `401 TokenExpired` (valid signature, `exp` + 30 s passed), `403 Forbidden` (role, status incl. `suspended`, a policy
  check, ownership `deny-forbidden`), `403 EmailNotVerified`, `404 NotFound` (ownership `deny-not-found`).
- Codes are PascalCase and stable forever; the list is the `ErrorCode` enum in the contract.

## Request id
`lib/request-id` is mounted first on both listeners. It adopts an incoming `X-Request-Id` if it is a UUID (any
version, either case) and **lower-cases** it, otherwise generates one (`crypto.randomUUID()`); sets `req.requestId`;
sets the response header before anything else runs, so every response (errors, 404s, health) carries it; and opens the
request context that binds it to every log line. Later modules write it to `audit_logs.request_id`, forward it on
every Identity call, and store it on `identity_sync_jobs` so retries keep the trace.

## Health ([ADR 0006](../adr/0006-health-split-redis-tier-2.md))
| Endpoint | Listener | Checks | Status |
|---|---|---|---|
| `GET /api/health/live`, `GET /internal/health/live` | each on its own listener | none; the process answered | 200 `{ "status": "ok" }`, also during shutdown |
| `GET /api/health/ready`, `GET /internal/health/ready` | each on its own listener | Postgres `SELECT 1` on the dedicated 1-connection probe pool (fatal) and Redis `PING` (reported only), concurrently, each bounded by 500 ms | 200 `ok` · 200 `degraded` (Redis down) · 503 `down` (Postgres down or shutdown in progress) |

Body: `{ "status": "ok|degraded|down", "checks": { "database": "up|down", "redis": "up|down", "identityJwks": "up|down" } }`,
bare JSON (not enveloped), with `Cache-Control: no-store` and `X-Request-Id`. Probes run even while draining, so the body stays
truthful. Because the database probe has its own connection, a task whose request pool is saturated still reports
`database: up`. After a Postgres failover without a TCP reset, readiness returns to `up` once the probe connection's
stuck query reaches its 3 s `query_timeout` and the connection is discarded ([resilience.md](./resilience.md) →
Postgres failure modes). Load balancers use readiness; the orchestrator restarts on liveness. Redis is Tier 2 and
never fails readiness. Identity reachability is **not** a health dependency: Care must stay up (degraded) when
Identity is down. `checks.identityJwks` is informational (contract C1, 2026-10-02): `up` when the in-memory JWKS
cache holds a key set younger than 1 h **and** its latest refresh succeeded; read from memory, no network call; it
never changes `status` or the HTTP code (Identity has no equivalent field — a stated parity exception). The old
`GET /api/health` and `GET /internal/health` were removed from the contract and now return 404.

## HTTP hardening
- Middleware order: request-id → in-flight counter → request logger → `helmet()` → dev CORS (public listener,
  `NODE_ENV=development` only) → `OPTIONS` → 404 → `express.json` (100 kB, strict) → routers → 404 → error handler.
  `x-powered-by` is disabled; Express `trust proxy` stays off.
- CORS allowlist from `CORS_ORIGINS` in development only (single origin in production, hub ADR 0005); never on the
  internal listener. `Cache-Control: no-store` on health and on clinical and consultation responses.
- Body size limits: JSON 100 kB; no multipart routes, because file bytes go straight to object storage (ADR 0013).
- Redis sliding-window rate limits as listed above (mounted by their modules).
- Node server timeouts: `keepAliveTimeout` 65 s, `headersTimeout` 66 s, `requestTimeout` 30 s.

## Boot and shutdown
- **Boot route assertion:** `createPublicApp` / `createInternalApp` call `assertRoutesAuthorized(app.router)` after
  mounting health and the module routers; `route_without_policy: <METHOD> <path>`, `route_without_guard: …`,
  `handler_before_authorize: …`, or `middleware_without_policy: <fn> under <path>` (and
  `policy_invalid: …` / `route_without_policy` thrown by `authorize` at registration) become `boot_failed`, exit 1.
- **JWKS cache:** `server.ts` starts it after DI registration (one background fetch, never awaited, + the 5-minute
  interval, `unref`'d) and stops it first on shutdown (clears the interval, aborts an in-flight fetch).
- **Boot:** each entrypoint (`server.ts`, `worker.ts`, `migrate.ts`) runs through `runMain`
  (`lib/lifecycle/run-main.ts`): a throw or rejection during boot writes **one** JSON line `error boot_failed`
  (serialized error) and exits 1, never Node's multi-line stack. Invalid env exits earlier with
  `invalid_environment`. A listener error (e.g. `EADDRINUSE`) logs `server_listen_failed` and exits 1. Success logs
  `server_started` (`port`, `internalPort`).
- **Shutdown on `SIGTERM`/`SIGINT`** (`lib/lifecycle/graceful-shutdown.ts`), bounded by `SHUTDOWN_TIMEOUT_MS`:
  1. readiness turns 503 (`shutdown_started`, `reason`); from here on every response carries `Connection: close`;
  2. both listeners stop accepting and close idle keep-alive sockets;
  3. in-flight requests drain; once the count reaches zero, the sockets that carried them are closed too. On the
     deadline: `shutdown_timeout` (`unfinishedRequests`), all connections force-closed, exit code 1;
  4. resources close in order (JWKS cache stop, request pool, probe pool, Redis `QUIT` with a `disconnect` fallback), each bounded by
     what remains of the deadline, with at least 250 ms each. A failure logs `shutdown_resource_failed`; an overrun
     logs `shutdown_resource_timeout` (`budgetMs`) and sets exit code 1; the next resource is closed either way;
  5. `shutdown_complete`, then exit 0 (1 after any timeout or an `uncaught_error`).

  A second signal logs `shutdown_forced` and exits 1. An uncaught exception or unhandled rejection logs
  `uncaught_error` and runs the same sequence with exit 1. Not yet fixed: a request aborted by its client leaves the
  in-flight count at its `close` event while its handler may still be running, so shutdown can close the pools under
  it ([#12](https://github.com/OmarRedaX/vcare-care-api/issues/12)).
- **`care-worker`:** `worker_stopping`, then every loop finishes its current tick and the worker pool is destroyed,
  both bounded by `SHUTDOWN_TIMEOUT_MS` (`worker_stop_timeout` and exit 1 on overrun). `node dist/worker.js --once
  <loop>` runs exactly one tick of that loop, closes the pool, and exits 0 (`worker_loop_unknown` / `worker_tick_failed`
  / `worker_once_incomplete` — the tick ran but did not reach its goal, e.g. partitions not ensured or the lock held
  elsewhere — → exit 1).

## Local stack (compose)
`docker-compose.yml` (`name: vcare-care`): Postgres 17 on `127.0.0.1:5433` and Redis 7 on `127.0.0.1:6380`, both on
**host loopback only** (known credentials, no Redis auth); a one-off `migrate` (`latest` then `ensure-app-login`, as
the owner); `care-api` with the public listener
on `3001` (all host interfaces) and the internal listener on `127.0.0.1:3101`; and `care-worker`. The test stack
(`docker-compose.test.yml`, `vcare-care-test`) uses `127.0.0.1:5434` (tmpfs) and `127.0.0.1:6381`; the integration
global setup migrates as the owner and provisions `care_app`. Identity's stack keeps 5432/6379 and 3000/3100;
`care-api`, `care-worker`, and `migrate` reach its JWKS through `host.docker.internal` (`extra_hosts: host-gateway`).

## Runtime notes
The platform deployment topology — edge routing, private network, every service's components, the availability
roll-up, and the release pipeline — is platform-scope and authored in the hub
(`../vcare-hub/architecture/deployment.md`; hub ADRs 0005, 0007, 0008). Care-specific runtime facts:

- One image runs both listeners; `PORT` receives every `/api/*` prefix the edge does not route to Identity;
  `INTERNAL_PORT` admits only registered service clients and admin tooling.
- Background loops (Identity-sync retrier, notification outbox, reminders, `next-available` refresh, audit
  partitions) run in the separate `care-worker` component ([ADR 0008](../adr/0008-care-worker-component.md));
  graceful shutdown stops each loop after its current batch. As built (access): one loop, `audit-partitions` (daily;
  transaction-scoped advisory lock; `audit_partitions_ensured`, metrics `audit_partition_missing`,
  `audit_default_partition_rows`).
- Outbound: `care-api` → Identity public JWKS (`undici`, every 5 min + gated demand fetches) and internal LB, video
  room provider, object storage; `care-worker` →
  Identity internal LB, email provider.

Components, sizing, availability, metrics, and alerts: [deployment.md](./deployment.md) and [capacity.md](./capacity.md).
