---
title: foundation — Spec
owner: care-team
service: care-service
module: foundation
status: ready
version: 1.0.0
diataxis: reference
last_verified: 2026-09-15
tags: [spec, foundation, bootstrap, infrastructure, health, idempotency, rate-limit, logging, testing, ci, docker]
related: [foundation-brainstorm, infrastructure, deployment, overview, quickstart, resilience, adr-0006-health-split-redis-tier-2, adr-0007-log-derived-metrics, adr-0008-care-worker-component]
contracts: [contracts/openapi.yaml]
---

# foundation — Spec

The runnable skeleton every later module builds on. Scope follows [brainstorm.md](./brainstorm.md) exactly: nothing
here exists "for later" unless a later module would otherwise have to change a foundation file's shape.
Binding rules: CLAUDE.md → "Tech stack (locked)", "Folder structure and layering", "Database rules",
"API conventions", "Security rules", "Privacy and logging", "Testing policy". Env/logging/health facts:
[architecture/infrastructure.md](../architecture/infrastructure.md); runtime components:
[architecture/deployment.md](../architecture/deployment.md); ADRs 0006 (health split, Redis Tier 2) and 0008 (`care-worker`).

---

## 1. Overview

### 1.1 What the foundation owns
| Area | Delivers |
|---|---|
| Tooling | `package.json`, `tsconfig*.json`, ESLint flat config (forbidden libs + layering), Jest unit/integration configs, `.npmrc` |
| Entrypoints | `src/server.ts` (both listeners + graceful shutdown), `src/app.ts`, `src/internal-app.ts`, `src/routes.ts`, `src/internal-routes.ts`, `src/bootstrap.ts` (DI registration), `src/worker.ts` (empty loop runner), `src/migrate.ts` (`care-migrate`) |
| `lib/` | `config`, `di`, `error`, `logger`, `request-id`, `http` (response, no-store, pagination, dev CORS), `validation`, `knex`, `redis`, `idempotency`, `rate-limit`, `lifecycle`, `worker`, `types` |
| `pkg/utils` | `time.ts`, `canonical-json.ts` |
| Health module | `src/app/health/` — four live/ready routes |
| Migration | `CREATE EXTENSION IF NOT EXISTS btree_gist` |
| Ops | `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `docker-compose.test.yml`, `.env.example`, `.env.test`, `.github/workflows/ci.yml` |
| Tests | `tests/setup-env.ts`, `tests/setup.ts`, `tests/helpers/*`, unit tests per lib piece, integration tests against real Postgres + Redis |

### 1.2 Principles
- **Only day-one needs.** No `lib/auth`, `lib/rbac`, `lib/audit`, `lib/identity-client`, `lib/storage`, `lib/video`,
  `lib/email`, outbox/sync-job tables, `pkg/slots`, or business tables/routes (brainstorm → Out of scope).
- **Byte-compatible with identity-service** for the error envelope, `X-Request-Id`, health bodies, redaction
  mechanics, and Redis key formats (§1.4).
- **Redis is Tier 2** (ADR 0006): its loss never fails a request or readiness.
- **Every constructor parameter uses `@inject(TOKENS.X)`** — no reliance on reflected parameter types, so
  transpile-only execution (`tsx`/esbuild, which emits no decorator metadata, and `ts-jest` `isolatedModules`)
  resolves identically to `tsc`.
- **No module-level side effects that connect**: Knex pools are lazy (`min: 0`), Redis uses `lazyConnect`.

### 1.3 Dependencies
- Other modules: none (every later module depends on the foundation).
- Other service: none. Identity is **not** a health dependency (infrastructure.md → Health).

### 1.4 Parity with identity-service (shared definitions — change only in both repos)
| Item | Definition |
|---|---|
| Error envelope | `{ "success": false, "error": { "code", "message", "details": [], "requestId" } }`; `details` always present (empty array when none); optional sibling members next to `error` |
| Success envelope | `{ "success": true, "data": <payload>, "meta"?: {…} }` — `meta` omitted when not provided |
| Request id | adopt incoming `X-Request-Id` iff it matches the UUID regex (any version, case-insensitive), lower-cased; else `crypto.randomUUID()`; header set **before** `next()` so every response (errors, health, 404) carries it; the rest of the request runs inside an `AsyncLocalStorage` context so every log line (including from services and repositories) carries `requestId` |
| Live body | `{ "status": "ok" }` |
| Ready body | `{ "status": "ok" \| "degraded" \| "down", "checks": { "database": "up" \| "down", "redis": "up" \| "down" } }`; not enveloped |
| Redaction | key-name match after normalisation `key.toLowerCase().replace(/[_-]/g, "")`; value replaced by the string `"[REDACTED]"`; recursive through objects and arrays; depth > 8 → `"[Truncated]"`; cycles → `"[Circular]"`; the `message` string is never rewritten |
| Idempotency key | `idem:<route>:<principal>:<key>` — `<route>` = `<METHOD> <baseUrl+path>` (concrete path, no query string), `<principal>` = `user:<userId>` (user token) \| `client:<clientId>` (service token) \| `ip:<clientIp>`, `<key>` = the lower-cased UUID |
| Idempotency in-flight | a duplicate arriving while the first is in flight → immediate `409 Conflict` with `Retry-After: 1`; the in-flight marker has a 60 s TTL; no waiting |
| Idempotency replay | stored status + body; a stored error body's `error.requestId` is replaced with the current request's id |
| Rate-limit key | `rl:<name>:<subject>` |
| Log field order | `level, message, timestamp, service, requestId?, userId?, role?, route?, method?, status?, code?, durationMs?`, then other context |
| Metric line | `logger.metric(name, value, dims)` → `{ level: "info", message: "metric", timestamp, service, requestId?, metric: <name>, value: <number>, dims: {…} }` (ADR 0007) |
| Client IP | `lib/http/client-ip.ts` — socket address, or the entry `TRUST_PROXY_HOPS` from the right of `X-Forwarded-For` when hops > 0 |
| Layout | `src/bootstrap.ts`, `src/migrate.ts`, `src/worker.ts`, `lib/lifecycle/` (shutdown/readiness state + in-flight counter), `lib/worker/` (loop runner), `lib/http/{cors,no-store,client-ip}.ts` |

---

## 2. Database schema

No tables. One migration proves the pipeline and installs the extension required by CLAUDE.md → Domain rules → 1.

**`src/migrations/20260915000000_create_extension_btree_gist.ts`**
```ts
import type { Knex } from "knex";

/** btree_gist: lets a GiST exclusion constraint combine doctor_user_id equality with tstzrange overlap
 *  (excl_consultations_doctor_no_overlap, added by the consultations module). */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`CREATE EXTENSION IF NOT EXISTS btree_gist;`);
}

export async function down(knex: Knex): Promise<void> {
    // No CASCADE: if a later object depends on the extension, rollback must fail loudly
    // (dependents are dropped by their own migrations' down() first).
    await knex.raw(`DROP EXTENSION IF EXISTS btree_gist;`);
}
```
- `btree_gist` is a trusted extension (PostgreSQL ≥ 13): the database owner role can create it; no superuser needed.
- Migration table: `knex_migrations` / `knex_migrations_lock` (Knex defaults).
- Every pool connection runs `SET TIME ZONE 'UTC'` (§3.4.8).

---

## 3. API contract and file-level design

### 3.1 Endpoints (mirror the contract **after** the change in §12.1)

| Method | Path | Listener | Guard | Roles | Ownership | Idempotency | Rate limit |
|---|---|---|---|---|---|---|---|
| GET | `/api/health/live` | public `PORT` | none | `public` (infrastructure probe) | none | n/a | none |
| GET | `/api/health/ready` | public `PORT` | none | `public` | none | n/a | none |
| GET | `/internal/health/live` | internal `INTERNAL_PORT` | none | `public` (network isolation is the protection) | none | n/a | none |
| GET | `/internal/health/ready` | internal `INTERNAL_PORT` | none | `public` | none | n/a | none |

**Documented exception:** health routes are the only routes mounted without `userGuard`/`serviceGuard` and
`authorize(...)`. They expose no data beyond dependency up/down. Every future route still requires `authorize`.

**Request:** no body, no query parameters (unknown query parameters are ignored), optional `X-Request-Id`.

**Responses** (headers on all: `X-Request-Id`, `Cache-Control: no-store`, `Content-Type: application/json`):

| Route | Condition | Status | Body |
|---|---|---|---|
| `…/health/live` | process can run the handler (never checks dependencies; unaffected by shutdown) | 200 | `{ "status": "ok" }` |
| `…/health/ready` | shutdown in progress | 503 | `{ "status": "down", "checks": { "database": <probe>, "redis": <probe> } }` |
| `…/health/ready` | Postgres probe failed | 503 | `{ "status": "down", "checks": { "database": "down", "redis": <probe> } }` |
| `…/health/ready` | Postgres up, Redis probe failed | 200 | `{ "status": "degraded", "checks": { "database": "up", "redis": "down" } }` |
| `…/health/ready` | both up | 200 | `{ "status": "ok", "checks": { "database": "up", "redis": "up" } }` |
| `…/health/<other>` or any unmatched path | — | 404 | error envelope, `NotFound` |

Probes run **concurrently**, each bounded by 500 ms: database = `SELECT 1` on the primary pool; redis = `PING`
(skipped and reported `down` without a round trip when `redis.status !== "ready"`). A probe that rejects or
times out is `down`. Probes run even during shutdown so the body stays truthful; shutdown only forces
`status: "down"` and 503. The auth module later adds an informational `checks.identityJwks`
(infrastructure.md → Health); the foundation schema leaves `checks` open for that additive field.

Public listener never serves `/internal/*` (→ 404); internal listener never serves `/api/*` (→ 404).

### 3.2 File list

```
package.json  package-lock.json  .npmrc  tsconfig.json  tsconfig.build.json  eslint.config.mjs
jest.config.js  jest.integration.config.js
Dockerfile  .dockerignore  docker-compose.yml  docker-compose.test.yml  .env.example  .env.test  .gitignore
.github/workflows/ci.yml
src/
  server.ts  worker.ts  migrate.ts  bootstrap.ts  app.ts  internal-app.ts  routes.ts  internal-routes.ts  worker-loops.ts
  app/health/
    controller/health.controller.ts  service/health.service.ts  dto/health.response.dto.ts
    enums.ts  types.ts  routes.ts
  lib/
    config/env.ts  config/types.ts
    di/container.ts  di/tokens.ts  di/register-core.ts
    error/AppError.ts  error/errors.ts  error/errorHandler.ts  error/not-found.ts  error/types.ts
    logger/logger.ts  logger/redact.ts  logger/request-logger.ts  logger/request-context.ts  logger/types.ts
    request-id/request-id.ts
    http/response.ts  http/no-store.ts  http/cors.ts  http/client-ip.ts  http/types.ts
    http/pagination/cursor.ts  http/pagination/page.ts  http/pagination/pagination.request.dto.ts  http/pagination/types.ts
    validation/validate.ts  validation/types.ts
    knex/knex.ts  knex/knexfile.ts  knex/probe.ts  knex/types.ts
    redis/redis.ts  redis/types.ts
    idempotency/idempotency.ts  idempotency/idempotency-store.ts  idempotency/types.ts
    rate-limit/rate-limit.ts  rate-limit/sliding-window.lua.ts  rate-limit/memory-limiter.ts  rate-limit/subjects.ts  rate-limit/types.ts
    lifecycle/shutdown-state.ts  lifecycle/in-flight.ts  lifecycle/graceful-shutdown.ts  lifecycle/types.ts
    worker/loop-runner.ts  worker/types.ts
    types/express.d.ts  types/types.ts
  pkg/utils/time.ts  pkg/utils/canonical-json.ts  pkg/utils/types.ts
  migrations/20260915000000_create_extension_btree_gist.ts
tests/
  setup-env.ts  setup.ts
  helpers/db.ts  helpers/redis.ts  helpers/app.ts  helpers/fake-http-server.ts  helpers/log-capture.ts  helpers/types.ts
  unit/…   integration/global-setup.ts  integration/global-teardown.ts  integration/…
```
`src/bootstrap.ts`, `src/migrate.ts`, `lib/lifecycle/`, `lib/worker/`, and `lib/http/{cors,no-store,client-ip}.ts`
follow the standard layout shared with identity-service (CLAUDE.md → Folder structure and layering).
Only `types.ts` / `*.d.ts` files declare `interface`/`type` (CLAUDE.md → Module file conventions → 11).

### 3.3 Entrypoints

#### `src/bootstrap.ts`
`export function registerDependencies(env: Env): void` — calls `registerCore(env)` (lib) then each module's
registrations (foundation: `HealthService`, `HealthController` as singletons). The only place that imports both
`lib/di` and `app/*` classes, keeping `lib/` free of `app/` imports.

#### `src/app.ts`
`export function createPublicApp(options?: AppOptions): express.Express`
(`AppOptions = { extraRouters?: MountedRouter[] }`, `MountedRouter = { path: string; router: Router }` in
`lib/http/types.ts`; **test-only seam** — production passes nothing.) Order:
1. `app.disable("x-powered-by")`; Express `trust proxy` stays **off** — client IPs come only from `clientIp(req)`
   (§3.4.6), so there is one IP rule.
2. `requestId()` (opens the AsyncLocalStorage context) → `inFlight()` → `requestLogger()` → `helmet()`.
3. `cors({ origins: env.CORS_ORIGINS })` **only when** `env.NODE_ENV === "development"` and the list is non-empty.
4. `express.json({ limit: "100kb", strict: true, type: "application/json" })`.
5. `app.use("/api/health", buildHealthRouter())`; `app.use("/api", buildPublicRoutes())`; each `extraRouters` entry.
6. `notFound` → `errorHandler`.

#### `src/internal-app.ts`
`export function createInternalApp(options?: AppOptions): express.Express` — same as above minus CORS; mounts
`/internal/health` and `/internal` → `buildInternalRoutes()`.

#### `src/routes.ts`, `src/internal-routes.ts`
`export function buildPublicRoutes(): Router` / `buildInternalRoutes(): Router` — return empty routers; later
modules mount here.

#### `src/server.ts` (`node dist/server.js`, component `care-api`)
1. `import "reflect-metadata"`; `const env = getEnv()` (exits 1 on invalid env, §3.4.1); `registerDependencies(env)`.
2. Install `process.on("uncaughtException" | "unhandledRejection")` → log `error` `uncaught_error` (serialized
   error) → `shutdown("uncaught_error", 1)`.
3. `redis.connect()` **not awaited for success** (`.catch` logs `warn redis_unavailable`); Postgres is **not**
   checked at boot — readiness reports it (a Postgres blip must not restart-loop tasks, ADR 0006).
4. `publicServer = createPublicApp().listen(env.PORT, "0.0.0.0")`;
   `internalServer = createInternalApp().listen(env.INTERNAL_PORT, env.INTERNAL_HOST)`.
   On each: `keepAliveTimeout = 65_000`, `headersTimeout = 66_000`, `requestTimeout = 30_000`.
   Listen error (e.g. `EADDRINUSE`) → log `error server_listen_failed` → exit 1.
5. Log `info server_started` with `port`, `internalPort`.
6. `SIGTERM`/`SIGINT` → `shutdown(signal)` built by `createGracefulShutdown` (§3.4.13). A second signal while
   shutting down logs `warn shutdown_forced` and exits 1.

#### `src/worker.ts` (`node dist/worker.js`, component `care-worker`)
1. `import "reflect-metadata"`; `getEnv()`; root logger.
2. `const runner = new LoopRunner(buildWorkerLoops(), { logger })`; `runner.start()`; log `info worker_started` with
   `loops` (names).
3. `SIGTERM`/`SIGINT` → log `info worker_stopping` → `await` `runner.stop()` raced against `SHUTDOWN_TIMEOUT_MS` →
   exit 0, or log `error worker_stop_timeout` and exit 1. Uncaught error → log + same stop path, exit 1.
4. No Postgres/Redis wiring yet — the first module with a loop adds exactly what it uses.

`src/worker-loops.ts`: `export function buildWorkerLoops(): WorkerLoop[]` returns `[]`.

#### `src/migrate.ts` (`node dist/migrate.js <cmd>`, component `care-migrate`)
Commands: `latest` (default), `rollback` (last batch), `status`, `make <snake_name>` (dev only: writes
`src/migrations/<YYYYMMDDHHMMSS>_<snake_name>.ts` from a raw-SQL `up`/`down` template; refuses names not matching
`^[a-z][a-z0-9_]{2,80}$`). Uses `createKnex({ …, statementTimeoutMs: null, applicationName: "care-migrate" })` and
`migrationConfig`. Logs JSON (`migrations_applied` with `batch` and file names, `migrations_status` with
`pending` count); destroys the pool; exit 0, or 1 on failure (error logged, no SQL values).

### 3.4 `lib/` pieces (exported API)

#### 3.4.1 `lib/config/env.ts` (zod, env only)
```ts
export const envSchema: z.ZodType<Env>;
export function parseEnv(source: Record<string, string | undefined>): Env;   // throws InvalidEnvError
export class InvalidEnvError extends Error { readonly keys: string[] }        // keys only, never values
export function getEnv(): Env;  // memoized parseEnv(process.env); on InvalidEnvError writes one JSON line
                                // {"level":"error","message":"invalid_environment","keys":[…],"service":"care-service",…}
                                // to stderr and calls process.exit(1)
```
`Env` lives in `lib/config/types.ts`. Variables the foundation declares:

| Variable | zod type | Default | Secret | Used by |
|---|---|---|---|---|
| `NODE_ENV` | `enum(["development","test","production"])` | `development` | | CORS gate, log level rule |
| `PORT` | `coerce.number().int().min(1).max(65535)` | `3001` | | public listener |
| `INTERNAL_PORT` | same; refine `≠ PORT` | `3101` | | internal listener |
| `INTERNAL_HOST` | `string().ip()` | `127.0.0.1` | | internal listener bind address (compose/deploy set the private interface; parity with identity) |
| `TRUST_PROXY_HOPS` | `coerce.number().int().min(0).max(5)` | `0` | | `lib/http/client-ip.ts` (correct client IP for per-IP limits and idempotency principals behind the edge) |
| `DATABASE_URL` | `string().url()` refined to `postgres:`/`postgresql:` scheme | **none** | yes | Knex |
| `DATABASE_POOL_MAX` | `coerce.number().int().min(1).max(100)` | `20` | | Knex pool |
| `REDIS_URL` | `string().url()` refined to `redis:`/`rediss:` | **none** | yes | Redis |
| `CORS_ORIGINS` | comma-separated string → `string[]`, each entry must equal `new URL(entry).origin` | `""` → `[]` | | dev CORS |
| `LOG_LEVEL` | `enum(["debug","info","warn","error"])`; `debug` rejected when `NODE_ENV=production` | `info` | | logger |
| `RATE_LIMIT_FALLBACK_DIVISOR` | `coerce.number().int().min(1)` | `2` | | rate-limit fallback |
| `SHUTDOWN_TIMEOUT_MS` | `coerce.number().int().min(1000).max(60000)` | `10000` | | server + worker shutdown |
| `WORKER_POLL_INTERVAL_MS` | `coerce.number().int().min(100)` | `1000` | | default loop interval |

Empty strings are treated as unset. Later modules add their own variables to the same schema.

#### 3.4.2 `lib/di/`
- `tokens.ts`: `export const TOKENS = { Env: Symbol.for("Env"), Logger: Symbol.for("Logger"), Db:
  Symbol.for("Db"), Redis: Symbol.for("Redis"), ShutdownState: Symbol.for("ShutdownState"), InFlightCounter:
  Symbol.for("InFlightCounter"), HealthService:
  Symbol.for("HealthService"), HealthController: Symbol.for("HealthController") } as const;`
- `container.ts`: `export { container } from "tsyringe";` (single root container).
- `register-core.ts`: `export function registerCore(env: Env): void` — registers `Env`, `Logger` (root), `Db`
  (`db`), `Redis` (`redis`), `ShutdownState`, `InFlightCounter` as instances.

#### 3.4.3 `lib/error/`
```ts
// AppError.ts
export class AppError extends Error {
  constructor(readonly code: ErrorCode, readonly status: number, message: string,
              readonly details: readonly ErrorDetail[] = [], readonly extra?: Readonly<Record<string, unknown>>);
  withDetails(details: ErrorDetail[]): AppError;          // new instance; exported constants are never mutated
  withExtra(extra: Record<string, unknown>): AppError;    // sibling members (ScheduleConflicts, SuspensionPending)
  withMessage(message: string): AppError;
}
// types.ts
export type ErrorCode = /* the full contract ErrorCode enum as a string-literal union */;
export interface ErrorDetail { field: string; issue: string }
```
`errors.ts` (messages match the contract examples):

| Export | Code | HTTP | Message |
|---|---|---|---|
| `ValidationFailed` | `ValidationFailed` | 400 | `Request validation failed` |
| `Unauthorized` | `Unauthorized` | 401 | `Authentication required` |
| `Forbidden` | `Forbidden` | 403 | `You are not allowed to perform this action` |
| `NotFound` | `NotFound` | 404 | `Resource not found` |
| `Conflict` | `Conflict` | 409 | `The resource already exists` |
| `IdempotencyConflict` | `IdempotencyConflict` | 422 | `The idempotency key was already used with a different request` |
| `RateLimited` | `RateLimited` | 429 | `Too many requests` |
| `InternalError` | `InternalError` | 500 | `An unexpected error occurred` |

`not-found.ts`: `export const notFound: RequestHandler` → `next(NotFound)`. Unmatched methods on a known path
are also 404 (no 405 code exists).

`errorHandler.ts`: `export function errorHandler(err: unknown, req, res, next): void` — the **only** producer of
error bodies. Sets `res.locals.errorCode` (read by the request logger).

| Input | Status | Code | `details` | Logged |
|---|---|---|---|---|
| `AppError` | `err.status` | `err.code` | `err.details` | 5xx → `error` with stack; 4xx → not logged here (request log carries `code`) |
| body-parser `type === "entity.parse.failed"` | 400 | `ValidationFailed` | `[{ field: "body", issue: "must be valid JSON" }]` | no |
| body-parser `type === "entity.too.large"` | 400 | `ValidationFailed` | `[{ field: "body", issue: "must not exceed 100kb" }]` | no |
| body-parser `type` in `encoding.unsupported`, `charset.unsupported`, `request.size.invalid`, `stream.encoding.set`, `request.aborted` | 400 | `ValidationFailed` | `[{ field: "body", issue: "could not be read" }]` | no |
| anything else | 500 | `InternalError` | `[]` | `error` `unhandled_error`, serialized error (§3.4.4) |
| `res.headersSent === true` | — | — | — | `error` `error_after_headers_sent`; `res.end()`; no second body |

Body: `{ success: false, error: { code, message, details, requestId: req.requestId }, ...extra }`. Never includes
stack, SQL, `err.message` of non-`AppError` errors, or request data.

#### 3.4.4 `lib/logger/`
```ts
export class Logger {
  constructor(options: LoggerOptions);   // { level: LogLevel; service: "care-service"; bindings?: LogFields;
                                         //   write?: (line: string) => void /* default process.stdout.write */; now?: () => Date }
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  metric(name: string, value: number, dims?: Record<string, string | number | boolean>): void;
  child(bindings: LogFields): Logger;
}
// request-context.ts (AsyncLocalStorage)
export const requestContext: AsyncLocalStorage<RequestContext>;   // RequestContext { requestId: string; userId?: number; role?: Role; clientId?: string }
export function currentRequestId(): string | undefined;
export const logger: Logger;             // root logger from getEnv()
export function serializeError(err: unknown): SerializedError; // { name, message, code?, stack? } — never pg `detail`,
                                                                // `where`, `parameters`, `query`, or `bindings`
// redact.ts
export const REDACTED_KEYS: readonly string[];
export function redact(value: unknown): unknown;
// request-logger.ts
export function requestLogger(): RequestHandler;
```
- One JSON line per call, field order per §1.4, `timestamp` ISO UTC, levels below `LOG_LEVEL` dropped.
- Every line reads `requestContext.getStore()` and adds `requestId` (and `userId`/`role`/`clientId` once a guard
  sets them on the store) when present — logs from services, repositories, and `setImmediate`/promise
  continuations inside the request carry the id without passing a logger around. Explicit fields win over the store.
- `metric(name, value, dims)`: emits the metric line from §1.4 at `info` regardless of `LOG_LEVEL` below `warn`
  (metrics are dropped only when `LOG_LEVEL=error`); `name` must match `^[a-z][a-z0-9_]*$` (else throws in
  development/test, dropped with a `warn` in production); `dims` values pass through `redact()`; `value` must be finite.
  Foundation metric names: `rate_limiter_degraded` (dims `limiter`), `worker_heartbeat` (dims `loop`),
  `idempotency_skipped` (dims `reason`). `http_requests`/`http_latency_ms` are derived from `request_completed` lines.
- `fields` pass through `redact()` (mechanics §1.4). Field `error` holding an `Error` is replaced by `serializeError`.
- **`REDACTED_KEYS`** (compared after normalisation): `complaintText, examinationNotes, diagnosisText, diagnosisCode,
  treatmentPlan, allergies, chronicConditions, bloodType, dateOfBirth, objectKey, downloadUrl, uploadUrl, joinToken,
  authorization, cookie, setCookie, fullName, displayName, firstName, lastName, email, phone, password, token,
  accessToken, refreshToken, serviceToken, clientSecret, body, requestBody`. Later modules append keys (each addition
  gets a row in the redaction unit test).
- `requestLogger()`: records `performance.now()` at entry; on `res` `finish` logs `request_completed` with
  `requestId, userId?, role?` (from `req.auth`), `method`, `route` (`req.baseUrl + req.route.path` when matched, else
  `"unmatched"`), `status`, `code` (`res.locals.errorCode` if set), `durationMs` (1 decimal). Level: `error` when
  status ≥ 500, `debug` for `/health/` routes with status < 500, else `info`. On `close` without `finish` logs
  `warn request_aborted`. **Never** logs URL, query string, headers, or bodies.
- `console.*` is banned in `src/` (ESLint); everything goes through `Logger`.

#### 3.4.5 `lib/request-id/request-id.ts`
`export function requestId(): RequestHandler` — parity rule §1.4; sets `req.requestId`, `req.log =
logger.child({ requestId })`, `res.setHeader("X-Request-Id", id)`, then calls
`requestContext.run({ requestId: id }, () => next())` so the whole downstream chain (including async handlers and the
error handler) shares the context. Mounted first on both listeners.
`export const UUID_PATTERN: RegExp` (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`).

#### 3.4.6 `lib/http/`
```ts
// response.ts
export function sendSuccess<T>(res: Response, data: T, options?: { status?: 200 | 201 | 202; meta?: Record<string, unknown> }): void;
export function sendNoContent(res: Response): void;   // 204, no body
// no-store.ts
export function noStore(): RequestHandler;            // Cache-Control: no-store (clinical + consultation routers)
// cors.ts (in-house, dev only; no `cors` package — ADR 0016)
export function cors(options: { origins: readonly string[] }): RequestHandler;
// client-ip.ts
export function clientIp(req: Request, trustProxyHops?: number /* default env.TRUST_PROXY_HOPS */): string;
      // hops = 0 → req.socket.remoteAddress; hops = n > 0 → the n-th entry from the right of X-Forwarded-For
      // (comma-split, trimmed), falling back to the socket address when the header has fewer than n entries.
      // IPv4-mapped IPv6 (::ffff:a.b.c.d) is normalised to a.b.c.d. Never returns an empty string ("unknown" instead).
// pagination/cursor.ts
export function encodeCursor(sortValue: string | number, id: number): string;  // base64url(JSON.stringify([sortValue, id]))
export function decodeCursor(cursor: string): CursorPosition;                  // { sortValue, id }; throws ValidationFailed
                                                                               // .withDetails([{ field: "cursor", issue: "is invalid" }])
// pagination/page.ts
export const DEFAULT_PAGE_LIMIT = 20; export const MAX_PAGE_LIMIT = 100;
export function resolveLimit(limit: number | undefined): number;               // limit ?? 20
export function buildPage<T>(rows: T[], limit: number, positionOf: (row: T) => [string | number, number]): Page<T>;
      // rows fetched with limit + 1; returns { items: rows.slice(0, limit), meta: { nextCursor, hasMore, count } }
      // nextCursor = encodeCursor(position of the last returned item) when hasMore, else null
// pagination/pagination.request.dto.ts
export class PaginationQueryDto { cursor?: string /* IsOptional IsString MaxLength(512) */;
                                  limit?: number /* IsOptional Type(()=>Number) IsInt Min(1) Max(100) */ }
```
`decodeCursor` accepts only a 2-element array: element 0 string or finite number, element 1 positive safe integer.
Cursors are positions, not grants — ownership filters still apply in every query.

**CORS behaviour:** `Origin` in allowlist → `Access-Control-Allow-Origin: <origin>`, `Vary: Origin`,
`Access-Control-Expose-Headers: X-Request-Id, Retry-After` (no `Allow-Credentials`: Care uses bearer tokens).
Preflight (`OPTIONS` + `Access-Control-Request-Method`) from an allowed origin → 204 with
`Access-Control-Allow-Methods: GET, POST, PATCH, DELETE`, `Access-Control-Allow-Headers: Authorization,
Content-Type, Idempotency-Key, X-Request-Id`, `Access-Control-Max-Age: 600`. Disallowed or absent `Origin` → no CORS
headers, `next()`.

#### 3.4.7 `lib/validation/validate.ts`
```ts
export function validateBody<T extends object>(dto: ClassConstructor<T>, input: unknown): Promise<T>;
export function validateQuery<T extends object>(dto: ClassConstructor<T>, input: unknown): Promise<T>;
export function validateParams<T extends object>(dto: ClassConstructor<T>, input: unknown): Promise<T>;
export function toErrorDetails(errors: ValidationError[]): ErrorDetail[];
```
- Called from controllers (`req.query` is read-only in Express 5, so nothing is written back to `req`).
- `plainToInstance(dto, input, { enableImplicitConversion: <false for body, true for query/params>,
  exposeDefaultValues: true })`, then `validate(instance, { whitelist: true, forbidNonWhitelisted: true,
  forbidUnknownValues: true, validationError: { target: false, value: false } })`.
- Body that is not a plain object (missing, `null`, array, primitive) → `ValidationFailed` with
  `[{ field: "body", issue: "must be a JSON object" }]`.
- `toErrorDetails`: one entry per failing property (first constraint message), nested paths dotted
  (`items.0.name`), non-whitelisted properties → `issue: "is not allowed"`; sorted by `field`. Rejected **values are
  never echoed**.

#### 3.4.8 `lib/knex/`
```ts
// knex.ts
export function createKnex(options: KnexOptions): Knex;
      // { url; poolMax; statementTimeoutMs: number | null; applicationName: "care-api" | "care-worker" | "care-migrate" | "care-test" }
export const db: Knex;       // createKnex({ url: env.DATABASE_URL, poolMax: env.DATABASE_POOL_MAX, statementTimeoutMs: 2000, applicationName: "care-api" })
export function parseInt8(value: string): number;  // throws if outside Number.MAX_SAFE_INTEGER
// knexfile.ts
export const migrationConfig: Knex.MigratorConfig; // directory = path.join(__dirname, "../../migrations");
      // loadExtensions [".ts"] when running from src, [".js"] from dist; tableName "knex_migrations"
// probe.ts
export function probeDatabase(conn: Knex, timeoutMs: number): Promise<boolean>;  // SELECT 1 raced against timeoutMs
```
- `client: "pg"`, `connection: { connectionString, application_name }`, `pool: { min: 0, max: poolMax,
  afterCreate }` where `afterCreate` runs `SET TIME ZONE 'UTC'` and, when non-null,
  `SET statement_timeout = <ms>` before handing out the connection.
- `acquireConnectionTimeout`: 1000 ms for `care-api`/`care-worker` (fast-fail on pool wait, deployment.md →
  Bottlenecks 4); 60 000 ms for `care-migrate`.
- `pg` type parsers set once in `knex.ts`: OID 20 (`int8`) → `parseInt8` (BIGSERIAL ids and `COUNT(*)` are numbers,
  hub ADR 0004); OID 1082 (`date`) → raw string (no local-time shift). `TIMESTAMPTZ` stays `Date`.

#### 3.4.9 `lib/redis/redis.ts`
```ts
export function createRedis(url: string, options?: { name?: string }): Redis;
export const redis: Redis;                              // createRedis(env.REDIS_URL)
export function isRedisReady(client: Redis): boolean;   // client.status === "ready"
export function probeRedis(client: Redis, timeoutMs: number): Promise<boolean>;
```
ioredis options: `lazyConnect: true`, `enableOfflineQueue: false` (commands fail fast while down → Tier 2
fallbacks engage immediately), `maxRetriesPerRequest: 1`, `connectTimeout: 2000`, `commandTimeout: 500`,
`retryStrategy: (n) => Math.min(n * 200, 2000)` (reconnects forever). Events: first `error` after `ready` logs
`warn redis_unavailable`; next `ready` logs `info redis_recovered` (one line per transition, never per error).

#### 3.4.10 `lib/idempotency/`
```ts
export function idempotency(options: IdempotencyOptions): RequestHandler;
      // { required: boolean; redis?: Redis /* default TOKENS.Redis */; lockTtlMs?: number /* 60_000 */; ttlMs?: number /* 86_400_000 */ }
export function buildIdempotencyKey(req: Request, key: string): string;  // §1.4
export function resolvePrincipal(req: Request): string;                  // "user:<req.auth.userId>" | "client:<req.service.clientId>" | "ip:<clientIp(req)>"
export function hashBody(body: unknown): string;                         // sha256 hex of canonicalJson(body ?? null)
```
Mounted after the guard and `authorize` (so `req.auth` sets the principal) and after `express.json`.
Redis records (JSON): in progress `{ "state": "in_progress", "bodyHash" }` set with `SET key value PX lockTtlMs NX`;
completed `{ "state": "done", "bodyHash", "status", "body" }` set with `PX ttlMs` (overwrites the lock).

| # | Situation | Behaviour |
|---|---|---|
| 1 | Method `GET`/`HEAD`/`OPTIONS` | `next()` (no-op) |
| 2 | Header absent, `required: false` | `next()` |
| 3 | Header absent, `required: true` | `400 ValidationFailed` `[{ field: "Idempotency-Key", issue: "is required" }]` — even when Redis is down |
| 4 | Header present but not a UUID | `400 ValidationFailed` `[{ field: "Idempotency-Key", issue: "must be a UUID" }]` |
| 5 | Redis not ready, or any Redis command throws before the handler runs | log `warn idempotency_skipped` (`route` pattern, no key) + `metric("idempotency_skipped", 1, { reason })`; `next()` — DB-level guarantees apply (booking `uq_consultations_idempotency`, ADR 0006) |
| 6 | `SET NX` succeeds (first request) | run handler; capture status + JSON body (wrap `res.json`; `sendNoContent` → body `null`) |
| 6a | …response status 2xx or 4xx except 429 | on `finish`, store `done` record for `ttlMs` |
| 6b | …response status 5xx or 429 | on `finish`, `DEL` the lock so the client may retry |
| 6c | …storing fails (Redis dropped mid-request) | log `warn idempotency_store_failed`; response already sent; the lock expires after `lockTtlMs` |
| 7 | Record `done`, same `bodyHash` | replay: `res.status(stored.status)` + stored body (`204` → empty); handler **not** run; when the stored body is an error envelope, `error.requestId` is **replaced with the current request's id** (matching the `X-Request-Id` header) |
| 8 | Record exists (either state), different `bodyHash` | `422 IdempotencyConflict` |
| 9 | Record `in_progress`, same `bodyHash` (concurrent duplicate) | **immediate** `409 Conflict` with header `Retry-After: 1` and message `A request with this idempotency key is still being processed`; no waiting, no polling; the marker expires after `lockTtlMs` (60 s) if the first request never completes |
| 10 | `SET NX` loses and the follow-up `GET` finds no record (the first just released it, row 6b) | treated as row 9 (`409 Conflict`, `Retry-After: 1`); the client retry proceeds normally |

#### 3.4.11 `lib/rate-limit/`
```ts
export function rateLimit(options: RateLimitOptions): RequestHandler;
      // { name: string; limit: number; windowMs: number; subject: (req: Request) => string | null;
      //   onRedisDown?: "fallback" | "fail-open" /* default "fallback" */; redis?: Redis; now?: () => number }
export function fallbackLimit(limit: number, divisor: number): number;   // Math.max(1, Math.floor(limit / divisor))
// subjects.ts
export const byIp: (req: Request) => string | null;     // clientIp(req)
export const byUser: (req: Request) => string | null;   // req.auth ? String(req.auth.userId) : null
// memory-limiter.ts
export class MemoryLimiter { constructor(maxKeys?: number /* 10_000 */); hit(key: string, limit: number, windowMs: number, nowMs: number): LimitResult }
// sliding-window.lua.ts — the Lua source registered with redis.defineCommand("slidingWindowHit")
```
- Key `rl:<name>:<subject>`; `subject` returning `null` → `next()` without counting.
- **Redis path (atomic Lua):** `ZREMRANGEBYSCORE key -inf now-windowMs`; `ZCARD`; if `< limit` then
  `ZADD key now "<now>-<requestId>"` and `PEXPIRE key windowMs`, allowed; else denied, returning the oldest score.
  Denied requests are **not** added (a blocked client recovers when the window slides).
- **Denied:** `429 RateLimited`, header `Retry-After = max(1, ceil((oldest + windowMs − now) / 1000))`; log
  `warn rate_limited` with `limiter` name and `route` (never the subject — IPs and user ids stay out of this line).
- **Redis down** (`status !== "ready"` or the command throws): `fallback` → `MemoryLimiter` with
  `fallbackLimit(limit, env.RATE_LIMIT_FALLBACK_DIVISOR)` on the same key string; `fail-open` → `next()`. Either way
  log `warn rate_limiter_degraded` with `limiter` and emit `metric("rate_limiter_degraded", 1, { limiter })`, at most
  once per 60 s per limiter (feeds `RateLimiterDegraded`).
- `MemoryLimiter` keeps a per-key timestamp array pruned on each hit; beyond `maxKeys` evicts the oldest-inserted key.

#### 3.4.12 `lib/lifecycle/shutdown-state.ts`
`export class ShutdownState { isShuttingDown(): boolean; markShuttingDown(): void }` (registered as a singleton;
readiness reads it).

`lib/lifecycle/in-flight.ts`:
```ts
export class InFlightCounter { get count(): number; increment(): void; decrement(): void; whenIdle(): Promise<void> }
export function inFlight(counter?: InFlightCounter /* default TOKENS.InFlightCounter */): RequestHandler;
      // increments on entry; decrements exactly once on res "finish" or "close"
```
`TOKENS` gains `InFlightCounter: Symbol.for("InFlightCounter")`.

#### 3.4.13 `lib/lifecycle/graceful-shutdown.ts`
```ts
export function createGracefulShutdown(deps: GracefulShutdownDeps): (reason: string, exitCode?: 0 | 1) => Promise<void>;
      // { servers: http.Server[]; state: ShutdownState; inFlight: InFlightCounter; timeoutMs: number; closeResources: Array<() => Promise<void>>;
      //   logger: Logger; exit: (code: number) => void; setTimer?: typeof setTimeout }
```
Sequence (repeated calls return the first call's promise):
1. `state.markShuttingDown()` → readiness returns 503; log `info shutdown_started` with `reason`.
2. `server.close()` on **both** listeners (stop accepting; in-flight requests continue), then
   `server.closeIdleConnections()`.
3. Wait for `inFlight.whenIdle()` and both `close` callbacks, or `timeoutMs`. On timeout: log
   `error shutdown_timeout` with `unfinishedRequests: inFlight.count`, `closeAllConnections()`, mark exit code 1.
4. `closeResources` in order: `db.destroy()`, then `redis.quit()` (falls back to `redis.disconnect()` if `quit`
   rejects). A failing resource logs `error shutdown_resource_failed` and continues.
5. Log `info shutdown_complete`; `exit(exitCode ?? 0)` (1 if step 3 timed out or `exitCode` was 1).

#### 3.4.14 `lib/worker/loop-runner.ts`
```ts
export class LoopRunner {
  constructor(loops: WorkerLoop[], deps: { logger: Logger; heartbeatEveryMs?: number /* 30_000 */ });
  start(): void;          // idempotent
  stop(): Promise<void>;  // resolves after every loop finished its current tick
}
// types.ts
export interface WorkerLoop { name: string; intervalMs: number; tick(signal: AbortSignal): Promise<void> }
```
- Each loop runs `while (!stopped) { await tick(signal); await abortableSleep(intervalMs, signal) }`. Ticks never
  overlap for the same loop.
- A tick that throws logs `error worker_tick_failed` (`loop`, serialized error) and the loop continues after its
  interval.
- `logger.metric("worker_heartbeat", 1, { loop })` at most once per `heartbeatEveryMs` per loop after a completed
  tick; the runner itself emits it with `loop: "runner"` on the same cadence, so an empty loop list still
  keeps the process alive and feeds `WorkerHeartbeatStale` (ADR 0007/0008).
- `stop()`: sets `stopped`, aborts the controller (wakes sleeps immediately; a running tick receives the aborted
  signal and should finish its current batch), clears the runner timer, awaits all loop promises.

#### 3.4.15 `lib/types/`
- `types.ts`: `Role = "patient" | "doctor" | "admin"`; `AccountStatus = "pending" | "active" | "rejected" |
  "suspended"`; `AuthContext { userId: number; role: Role; status: AccountStatus; emailVerified: boolean }`.
- `types.ts` also: `ServiceContext { clientId: string; scopes: string[] }`.
- `express.d.ts`: augments `Express.Request` with `requestId: string`, `log: Logger`, `auth?: AuthContext`,
  `service?: ServiceContext`. Shapes are declared only; `lib/auth` sets them later (and updates the request context
  store with `userId`/`role`/`clientId`).

### 3.5 `pkg/utils/`
```ts
// time.ts  (pure; no clock)
export function toMs(value: number, unit: DurationUnit): number;       // "ms" | "s" | "min" | "h" | "d"; throws RangeError on negative/non-finite
export function toSeconds(value: number, unit: DurationUnit): number;  // floor
// canonical-json.ts
export function canonicalJson(value: unknown): string;                 // JSON with object keys sorted recursively; arrays keep order;
                                                                       // undefined properties dropped; throws TypeError on cycles, BigInt, functions
```

### 3.6 `src/app/health/`
| File | Contents |
|---|---|
| `enums.ts` | `enum HealthStatus { Ok = "ok", Degraded = "degraded", Down = "down" }`; `enum ProbeStatus { Up = "up", Down = "down" }` |
| `types.ts` | `ReadinessResult { httpStatus: 200 \| 503; report: ReadyReport }`, `ReadyReport`, `LiveReport` |
| `service/health.service.ts` | `@injectable() class HealthService` — ctor `@inject(TOKENS.Db) db`, `@inject(TOKENS.Redis) redis`, `@inject(TOKENS.ShutdownState) state`; `live(): LiveReport`; `ready(): Promise<ReadinessResult>` implementing §3.1 (`PROBE_TIMEOUT_MS = 500`) |
| `dto/health.response.dto.ts` | `LiveResponseDto.from(report)`, `ReadyResponseDto.from(report)` — explicit field copy |
| `controller/health.controller.ts` | `live = (req, res) => …`, `ready = async (req, res) => …`; sends bare JSON (health is the documented non-enveloped exception) with `Cache-Control: no-store` |
| `routes.ts` | `export function buildHealthRouter(): Router` — `GET /live`, `GET /ready`; resolves the controller from the container |

No entity, repository, policies, or errors files: health owns no data and no authorization (documented exception).

### 3.7 Tooling

**`package.json`**: `"name": "care-service"`, `"private": true`, `"type": "commonjs"`,
`"engines": { "node": ">=24 <25" }`. `.npmrc`: `save-exact=true`, `engine-strict=true` (exact versions pinned by
the lockfile and in `package.json`).

Runtime dependencies (locked-stack subset used now + `reflect-metadata`; nothing else):
`express@5`, `helmet@8`, `class-validator@0.14`, `class-transformer@0.5`, `zod@4`, `tsyringe@4`,
`reflect-metadata@0.2`, `knex@3`, `pg@8`, `ioredis@5`.
Not added yet (land with their module): `jose`, `luxon`, `undici`.

Dev dependencies: `typescript@5`, `@types/node@24`, `@types/express@5`, `tsx@4`, `jest@30`, `ts-jest@29`,
`@types/jest@30`, `supertest@7`, `@types/supertest@6`, `eslint@9`, `@eslint/js@9`, `typescript-eslint@8`.

Scripts:
| Script | Command |
|---|---|
| `dev` | `tsx watch --env-file-if-exists=.env src/server.ts` |
| `dev:worker` | `tsx watch --env-file-if-exists=.env src/worker.ts` |
| `build` | `tsc -p tsconfig.build.json` |
| `start` / `start:worker` | `node dist/server.js` / `node dist/worker.js` |
| `typecheck` | `tsc -p tsconfig.json --noEmit` |
| `lint` | `eslint .` |
| `test` | `jest -c jest.config.js` |
| `test:integration` | `jest -c jest.integration.config.js --runInBand` |
| `test:infra:up` / `test:infra:down` | `docker compose -f docker-compose.test.yml up -d --wait` / `… down -v` |
| `migrate` / `migrate:rollback` / `migrate:status` | `tsx --env-file-if-exists=.env src/migrate.ts latest` / `rollback` / `status` |
| `migrate:make` | `tsx src/migrate.ts make` (name as the next argument) |

`tsx` (esbuild) honours `experimentalDecorators` but emits no `design:paramtypes`; tsyringe still resolves because every
constructor parameter carries `@inject(TOKENS.X)` (§1.2). Jest keeps `ts-jest` with `isolatedModules`.

**`tsconfig.json`** (typecheck: `src`, `tests`): `target ES2024`, `module NodeNext`, `moduleResolution NodeNext`,
`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
`experimentalDecorators`, `emitDecoratorMetadata`, `esModuleInterop`, `isolatedModules`,
`forceConsistentCasingInFileNames`, `skipLibCheck`, `sourceMap`, `types: ["node", "jest"]`.
**`tsconfig.build.json`**: extends it; `rootDir src`, `outDir dist`, `include ["src"]`, `types ["node"]`.

**`eslint.config.mjs`** (flat): `@eslint/js` recommended + `typescript-eslint` `recommendedTypeChecked`; rules
`@typescript-eslint/no-explicit-any: error`, `@typescript-eslint/no-floating-promises: error`,
`@typescript-eslint/consistent-type-imports: error`, `no-console: error` (in `src/`).
- `no-restricted-imports` (all files) — `paths`/`patterns`: `@prisma/client`, `prisma`, `typeorm`, `sequelize`,
  `drizzle-orm`, `drizzle-orm/*`, `kysely`, `@mikro-orm/*`, `@nestjs/*`, `graphql`, `@apollo/*`, `@grpc/*`, `@trpc/*`,
  `passport`, `passport-*`, `auth0`, `@auth0/*`, `@clerk/*`, `jsonwebtoken`, `moment`, `moment-timezone`, `node-fetch`,
  `axios`, `uuid`, `dotenv`, `cors` — message: "Forbidden by CLAUDE.md → Tech stack (locked)".
- `src/pkg/**`: additionally patterns `**/lib/**`, `**/app/**`, `express`, `knex`, `pg`, `ioredis`, `tsyringe`
  ("pkg/ is pure: no I/O, no DI, no framework").
- `src/lib/**`: additionally pattern `**/app/**` ("lib/ must not import app/; register modules in src/bootstrap.ts").
- `no-restricted-syntax` in `src/**` except `**/types.ts` and `**/*.d.ts`: `TSInterfaceDeclaration`,
  `TSTypeAliasDeclaration` ("declare types only in types.ts").
- `no-restricted-properties` `process.env` in `src/**` except `src/lib/config/env.ts`.
- Ignores: `dist/`, `coverage/`, `node_modules/`.
Cross-module repository imports are not lint-enforced (review checks them).

**Jest** (`jest.config.js`, CommonJS):
- Unit: `roots ["<rootDir>/tests/unit"]`, `testMatch ["**/*.test.ts"]`, `transform { "^.+\\.ts$": ["ts-jest",
  { tsconfig: "tsconfig.json" }] }`, `setupFiles ["<rootDir>/tests/setup-env.ts"]`,
  `setupFilesAfterEnv ["<rootDir>/tests/setup.ts"]`, `clearMocks: true`, `testTimeout: 5000`.
- Integration (`jest.integration.config.js`): same transform/setup, `roots ["<rootDir>/tests/integration"]`,
  `globalSetup "<rootDir>/tests/integration/global-setup.ts"` (loads `.env.test`, runs `migrate latest`, destroys its
  pool), `globalTeardown "<rootDir>/tests/integration/global-teardown.ts"`, `maxWorkers: 1`, `testTimeout: 20000`.
  No `forceExit`: suites close `db` and `redis` in `afterAll`; an open handle is a bug.
- `tests/setup-env.ts`: `process.loadEnvFile(".env.test")` (does not override variables already set, so CI can
  override). `tests/setup.ts`: `import "reflect-metadata"` and `registerDependencies(getEnv())` — **no infra mocks**.

### 3.8 Docker, compose, env files, CI

**`Dockerfile`** (multi-stage, one image for `care-api`, `care-worker`, `care-migrate`):
1. `deps` — `node:24-alpine`, `WORKDIR /app`, copy `package.json package-lock.json .npmrc`, `npm ci`.
2. `build` — from `deps`; copy `tsconfig*.json src`; `npm run build`.
3. `prod-deps` — `node:24-alpine`; copy manifests; `npm ci --omit=dev`.
4. `runtime` — `node:24-alpine`; `ENV NODE_ENV=production`; copy `node_modules` from `prod-deps`, `dist` from
   `build`, `package.json`; `USER node`; `EXPOSE 3001 3101`; `STOPSIGNAL SIGTERM`; `CMD ["node", "dist/server.js"]`.
   No `HEALTHCHECK` in the image (the worker shares it); compose and the orchestrator probe HTTP.

**`.dockerignore`**: `node_modules`, `dist`, `coverage*`, `.git`, `.github`, `.env`, `.env.*` (except
`!.env.example`), `tests`, `docs`, `.claude`, `contracts`, `scripts`, `*.md`.

**`docker-compose.yml`** (`name: vcare-care`, so it never collides with identity's stack):
| Service | Image / build | Ports (host:container) | Notes |
|---|---|---|---|
| `postgres` | `postgres:17-alpine` | `5433:5432` | `POSTGRES_USER=care`, `POSTGRES_PASSWORD=care`, `POSTGRES_DB=care`; volume `care-pg-data`; healthcheck `pg_isready -U care -d care` |
| `redis` | `redis:7-alpine` | `6380:6379` | healthcheck `redis-cli ping` |
| `migrate` | build `.` | — | `command: ["node", "dist/migrate.js", "latest"]`; depends on `postgres` healthy; `restart: "no"` |
| `care-api` | build `.` | `3001:3001`, `127.0.0.1:3101:3101` | `INTERNAL_HOST=0.0.0.0` (inside the container); `DATABASE_URL=postgres://care:care@postgres:5432/care`; `REDIS_URL=redis://redis:6379`; depends on `migrate` `service_completed_successfully` and `redis` `service_started` (Tier 2); healthcheck `wget -qO- http://127.0.0.1:3001/api/health/ready`; `init: true` |
| `care-worker` | build `.` | — | `command: ["node", "dist/worker.js"]`; depends on `migrate` completed; `init: true` |
Host ports 5433/6380 leave 5432/6379 to identity; app ports stay 3001/3101 (identity uses 3000/3100).

**`docker-compose.test.yml`** (`name: vcare-care-test`): `postgres:17-alpine` on `5434:5432` (`care`/`care`,
`POSTGRES_DB=care_test`, `tmpfs: /var/lib/postgresql/data`, healthcheck) and `redis:7-alpine` on `6381:6379`
(healthcheck). Only infrastructure — tests run on the host (`npm run test:infra:up && npm run test:integration`).

**`.env.example`** (committed, local dev against `docker-compose.yml` infra, app on the host):
`NODE_ENV=development`, `PORT=3001`, `INTERNAL_PORT=3101`, `INTERNAL_HOST=127.0.0.1`, `TRUST_PROXY_HOPS=0`,
`DATABASE_URL=postgres://care:care@localhost:5433/care`, `DATABASE_POOL_MAX=20`, `REDIS_URL=redis://localhost:6380`,
`CORS_ORIGINS=http://localhost:5173`, `LOG_LEVEL=info`, `RATE_LIMIT_FALLBACK_DIVISOR=2`, `SHUTDOWN_TIMEOUT_MS=10000`,
`WORKER_POLL_INTERVAL_MS=1000`.
**`.env.test`** (committed; synthetic, local-only credentials): `NODE_ENV=test`, ports `3001`/`3101`,
`DATABASE_URL=postgres://care:care@localhost:5434/care_test`, `REDIS_URL=redis://localhost:6381/0`,
`LOG_LEVEL=warn`, `CORS_ORIGINS=http://localhost:5173`, `SHUTDOWN_TIMEOUT_MS=2000`, others default.
`.gitignore` includes `.env`, `dist/`, `coverage*/`, `node_modules/`.

**`.github/workflows/ci.yml`**: on `push` to `main` and `pull_request`; `permissions: contents: read`;
`concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`; each job `timeout-minutes: 15`,
`actions/checkout@v4`, `actions/setup-node@v4` (`node-version: 24`, `cache: npm`), `npm ci`.
| Job | Needs | Steps |
|---|---|---|
| `checks` | — | `npm run lint` · `npm run typecheck` · `npm test` |
| `integration` | — | service containers `postgres:17-alpine` (`5434:5432`, env `care`/`care`/`care_test`, `--health-cmd "pg_isready -U care -d care_test"`) and `redis:7-alpine` (`6381:6379`, `--health-cmd "redis-cli ping"`); `npm run test:integration` (global setup migrates) |
| `docker` | `checks` | `docker build -t care-service:ci .` (no push) |
Ports match `.env.test`, so CI and local runs use the same configuration.

---

## 4. Business rules (foundation invariants)

| # | Rule | Enforced by |
|---|---|---|
| F1 | The process refuses to start on invalid env, naming keys only, never values | `lib/config/env.ts` |
| F2 | Secrets (`DATABASE_URL`, `REDIS_URL`) have no defaults | zod schema |
| F3 | Every response (success, error, 404, health) carries `X-Request-Id`; a non-UUID incoming value is replaced | `requestId()` mounted first |
| F4 | Every error body is the one envelope; unknown errors → `500 InternalError` with no internals | `errorHandler` (sole producer) |
| F5 | Malformed/oversized/unreadable JSON → `400 ValidationFailed` | `errorHandler` body-parser mapping |
| F6 | Unknown properties in a DTO → `400 ValidationFailed`; rejected values are never echoed | `lib/validation` |
| F7 | Logs never contain redacted keys' values, request bodies, query strings, or headers | `Logger` + `requestLogger` |
| F8 | Every pool connection uses `TIME ZONE 'UTC'`; `int8` returns as a safe `number` | `createKnex` `afterCreate` + type parser |
| F9 | Liveness is 200 regardless of dependencies or shutdown | `HealthService.live` |
| F10 | Readiness is 503 iff Postgres is down or shutdown is in progress; Redis down → 200 `degraded` | `HealthService.ready` |
| F11 | Health routes are served only on their own listener (`/api/health/*` public, `/internal/health/*` internal) | `createPublicApp` / `createInternalApp` |
| F12 | Same `Idempotency-Key` + same body → original status and body replayed, handler runs once | `idempotency` |
| F13 | Same key + different body → `422 IdempotencyConflict` | `idempotency` |
| F14 | `required: true` + missing key → `400 ValidationFailed`, even with Redis down | `idempotency` |
| F15 | Concurrent duplicates with the same key run the handler at most once; the loser gets an immediate `409 Conflict` + `Retry-After: 1` | `SET NX` in-flight marker, 60 s TTL (table row 9) |
| F16 | Redis unavailable → idempotency skipped, never a 5xx | `idempotency` row 5 |
| F17 | A limiter admits at most `limit` requests per sliding `windowMs` per subject; excess → `429 RateLimited` + `Retry-After ≥ 1` | Lua sliding window |
| F18 | Redis unavailable → per-instance limit `max(1, floor(limit / RATE_LIMIT_FALLBACK_DIVISOR))` (or fail-open when configured) | `MemoryLimiter` |
| F19 | Shutdown: not-ready → close listeners → drain ≤ `SHUTDOWN_TIMEOUT_MS` → destroy Knex → quit Redis → exit 0 (1 on timeout) | `createGracefulShutdown` |
| F20 | The worker stops after the current tick of every loop | `LoopRunner.stop` |
| F21 | The first migration installs `btree_gist` and rolls back cleanly | migration file |
| F22 | CORS headers are emitted only in `development` and only for allowlisted origins; never on the internal listener | `createPublicApp` + `cors()` |
| F23 | `pkg/` imports nothing from `lib/`/`app/` or I/O libs; `lib/` imports nothing from `app/`; forbidden libraries fail lint | ESLint |

---

## 5. Cross-service behavior
None. No calls made or served. Identity reachability is deliberately not part of readiness.

---

## 6. Error codes
No new codes. The foundation emits only codes already in the contract `ErrorCode` enum:

| Code | HTTP | When (foundation) |
|---|---|---|
| `ValidationFailed` | 400 | DTO failure; malformed/oversized/unreadable JSON; missing required or non-UUID `Idempotency-Key`; invalid cursor |
| `NotFound` | 404 | unmatched path or method on either listener |
| `Conflict` | 409 | a duplicate request with the same `Idempotency-Key` arrives while the first is still in flight (with `Retry-After: 1`) |
| `IdempotencyConflict` | 422 | same key, different body |
| `RateLimited` | 429 | limiter tripped (with `Retry-After`) |
| `InternalError` | 500 | unhandled error |

`Unauthorized` and `Forbidden` are exported from `lib/error/errors.ts` for `lib/auth`/`lib/rbac`; the foundation
emits neither.

---

## 7. Security & privacy
- **RBAC:** health routes are public infrastructure probes (documented exception, §3.1); no other routes exist.
  Deny-by-default `authorize` arrives with `lib/rbac` in the first business module.
- **Audit events:** none (no clinical access, no state changes).
- **Never logged:** the full CLAUDE.md → Privacy and logging list; mechanically, `REDACTED_KEYS` (§3.4.4), plus
  request bodies, URLs/query strings, headers, pg error `detail`/`parameters`, idempotency keys, rate-limit subjects.
  Metric `dims` are redacted like fields and must hold only bounded labels (never ids of users, IPs, or keys).
- **Headers:** `helmet()` defaults on both listeners; `Cache-Control: no-store` on health; `noStore()` is provided for
  clinical and consultation routers; `x-powered-by` disabled.
- **Body limits:** JSON 100 kB; no multipart parser (ADR 0013).
- **Rate limits:** the factory only; actual limiters (search 60/min IP + 120/min user, booking 10/min user, uploads
  20/h user) are mounted by their modules. Health is never rate-limited.
- **Internal listener:** binds `INTERNAL_HOST` (default `127.0.0.1`); compose exposes 3101 on host loopback only.
- **Env:** only `lib/config/env.ts` reads `process.env` (lint-enforced); `.env` is git-ignored; `.env.test` holds only
  local synthetic credentials.
- **Container:** non-root `node` user; production dependencies only in the runtime stage.
- **Files:** none in this module (upload intents and download URLs arrive with `verification`/`records`).

---

## 8. Performance
- Readiness: 2 probes in parallel, each ≤ 500 ms → p95 well under 1 s even when a dependency hangs.
- Middleware overhead per request: request id (no I/O), logger (one `JSON.stringify`), idempotency (1 `SET NX` +
  1 `SET` on first use; 1 `GET` on replay), rate limit (1 `EVALSHA`). No database query in any foundation middleware.
- Redis commands time out at 500 ms and never queue while disconnected, so a Redis outage adds at most one failed
  command's latency before the Tier 2 path.
- Pool: `DATABASE_POOL_MAX=20`, acquire timeout 1 s, statement timeout 2 s on `care-api`/`care-worker`.
- No foundation query needs an index (no tables).

---

## 9. Test plan outline
Names follow `should <do something> when <condition>`. Unit tests mock collaborators (Redis, Knex, clock, servers);
integration tests use real Postgres (with `btree_gist`) and real Redis, and mount test-only routers via
`extraRouters` — never in `src/routes.ts`.

### 9.1 Helpers (`tests/helpers/`)
| File | Exports |
|---|---|
| `db.ts` | `truncateAll(conn?: Knex): Promise<void>` — lists `public` tables except `knex_migrations*`; no-op when none; `TRUNCATE … RESTART IDENTITY CASCADE` · `closeDb(): Promise<void>` |
| `redis.ts` | `flushByPrefix(prefixes?: string[] /* ["idem:", "rl:"] */): Promise<void>` — `SCAN MATCH <p>* COUNT 500` + `UNLINK` (never `KEYS`/`FLUSHALL`) · `createUnreachableRedis(): Redis` — client for `redis://127.0.0.1:1`, `lazyConnect`, `enableOfflineQueue: false`, `retryStrategy: () => null` · `closeRedis()` |
| `app.ts` | `buildTestApps(options?: { publicRouters?: MountedRouter[]; internalRouters?: MountedRouter[] }): { publicApp; internalApp }` using the real container · `withContainerOverrides(overrides: Array<{ token: symbol; value: unknown }>, fn)` — registers into a `container.createChildContainer()` for Redis-down / Postgres-down scenarios |
| `fake-http-server.ts` | `startFakeHttpServer(routes: FakeRoute[]): Promise<FakeHttpServer>` — `{ url; requests: RecordedRequest[]; setMode(mode: "normal" \| "slow" \| "fail", options?: { delayMs?: number; status?: number }): void; close(): Promise<void> }` on `node:http`, random port. Base for the future Identity fake; no Identity routes yet |
| `log-capture.ts` | `captureLogs(): LogCapture` — spies on `process.stdout.write`/`process.stderr.write`; `{ lines(): Record<string, unknown>[]; text(): string; restore(): void }` · `expectNoSensitiveStrings(capture, fixtures: string[]): void` |
| `types.ts` | the helper types above |

Synthetic fixture strings used for log assertions: `SYNTHETIC-COMPLAINT-7731`, `synthetic.patient@example.test`.

### 9.2 Unit tests (`tests/unit/`)
- `pkg/utils/time.test.ts`: should convert each unit to milliseconds when given a finite value · should throw RangeError when the value is negative or non-finite.
- `pkg/utils/canonical-json.test.ts`: should produce identical output when object keys differ only in order · should keep array order when arrays differ · should throw when the value is cyclic.
- `lib/config/env.test.ts`: should apply defaults when only the secrets are set (F2) · should throw InvalidEnvError naming DATABASE_URL when it is missing (F1) · should never include a value in the error message when parsing fails (F1) · should reject INTERNAL_PORT when it equals PORT · should reject LOG_LEVEL debug when NODE_ENV is production · should split CORS_ORIGINS when it is comma-separated · should reject a CORS origin when it has a path · should reject REDIS_URL when the scheme is not redis or rediss · should treat an empty string as unset when a default exists.
- `lib/error/AppError.test.ts`: should return a new instance and leave the constant untouched when withDetails is called.
- `lib/error/errorHandler.test.ts`: should render the envelope with status and code when an AppError is thrown (F4) · should include an empty details array when the error has none · should merge extra members next to error when withExtra is used · should return 400 ValidationFailed when JSON is malformed (F5) · should return 400 ValidationFailed when the payload is too large (F5) · should return 500 InternalError without the original message when an unknown error is thrown (F4) · should log the stack when an unknown error is thrown · should not write a second body when headers were already sent · should set res.locals.errorCode when rendering an error.
- `lib/error/not-found.test.ts`: should forward NotFound when no route matched.
- `lib/logger/logger.test.ts`: should emit the fields in parity order when logging (F7) · should drop entries below LOG_LEVEL · should include bindings when a child logger is used · should serialize an Error without pg detail or parameters when error is passed · should emit a metric line with metric, value, and dims when metric is called · should throw in test when a metric name is not snake_case · should add requestId from the AsyncLocalStorage store when logging outside the middleware · should prefer explicit fields over the store when both set requestId.
- `lib/logger/request-context.test.ts`: should return the request id inside requestContext.run across awaits and timers · should return undefined outside any request.
- `lib/http/client-ip.test.ts`: should return the socket address when TRUST_PROXY_HOPS is 0 even if X-Forwarded-For is set · should return the n-th entry from the right when hops is n · should fall back to the socket address when X-Forwarded-For has fewer entries than hops · should normalise an IPv4-mapped IPv6 address.
- `lib/lifecycle/in-flight.test.ts`: should decrement once when both finish and close fire · should resolve whenIdle when the count returns to zero.
- `lib/logger/redact.test.ts`: should redact every REDACTED_KEYS entry when present at the top level (F7, one case per key) · should redact snake_case and kebab-case variants when keys are normalised · should redact nested objects and arrays · should return "[Circular]" when a cycle exists · should return "[Truncated]" when depth exceeds 8 · should leave the message string unchanged.
- `lib/logger/request-logger.test.ts`: should log route pattern, status, code, and durationMs when the response finishes · should log "unmatched" when no route matched · should never log the URL, query, headers, or body when logging a request · should log at error when status is 5xx · should log request_aborted when the connection closes before finish.
- `lib/request-id/request-id.test.ts`: should adopt the incoming id when it is a UUID (F3) · should generate a UUID when the header is absent (F3) · should replace the header when it is not a UUID (F3) · should set the response header before calling next.
- `lib/http/response.test.ts`: should send success with data and no meta when meta is omitted · should include meta when provided · should send 204 with no body when sendNoContent is called · should set Cache-Control no-store when noStore is applied.
- `lib/http/pagination.test.ts`: should round-trip sortValue and id when encoding then decoding · should throw ValidationFailed with field cursor when the cursor is not base64url JSON · should throw when the id is not a positive safe integer · should return hasMore false and nextCursor null when rows are at most limit · should return limit items and a cursor of the last item when rows exceed limit · should default limit to 20 when absent.
- `lib/http/cors.test.ts`: should set allow-origin and Vary when the origin is allowlisted (F22) · should set no CORS headers when the origin is not allowlisted (F22) · should answer 204 with allow headers when a preflight comes from an allowed origin.
- `lib/validation/validate.test.ts`: should return a typed instance when the body is valid · should throw ValidationFailed with "is not allowed" when an unknown property is present (F6) · should report dotted paths when a nested property fails · should convert numeric query strings when validating a query · should throw "must be a JSON object" when the body is an array or missing · should not echo rejected values in details (F6).
- `lib/knex/knex.test.ts`: should run SET TIME ZONE 'UTC' and the statement timeout when a connection is created (F8) · should skip the statement timeout when statementTimeoutMs is null · should parse int8 to a number when it is a safe integer (F8) · should throw when int8 exceeds MAX_SAFE_INTEGER.
- `lib/redis/redis.test.ts`: should report not ready when status is not ready · should resolve false when PING exceeds the timeout.
- `lib/idempotency/idempotency.test.ts` (fake Redis): should call next without Redis when the method is GET · should return 400 when required and the header is missing even if Redis is down (F14) · should return 400 when the key is not a UUID · should skip and call next when Redis is not ready (F16) · should skip and call next when SET NX throws (F16) · should delete the lock when the handler responds 5xx · should keep the lock to expire when storing the result fails · should respond 409 Conflict with Retry-After 1 immediately when a duplicate arrives while the first is in flight (F15) · should respond 409 Conflict when SET NX loses and no record is found · should set the in-flight marker with a 60 s TTL · should replace error.requestId with the current request id when replaying a stored error · should build the principal as user:<id>, client:<clientId>, or ip:<ip> when auth, a service token, or neither is present · should build the key as idem:<METHOD path>:<principal>:<key> without the query string.
- `lib/rate-limit/rate-limit.test.ts` (fake Redis, fake clock): should compute max(1, floor(limit / divisor)) for fallbackLimit (F18) · should admit the fallback limit then return 429 when Redis is not ready (F18) · should call next when onRedisDown is fail-open and Redis throws · should skip counting when the subject is null · should log rate_limiter_degraded at most once per 60 seconds per limiter · should set Retry-After to at least 1 when denied (F17) · should not log the subject when a request is limited.
- `lib/rate-limit/memory-limiter.test.ts`: should admit again when the window slides past the oldest hit · should evict the oldest key when maxKeys is exceeded.
- `app/health/health.service.test.ts`: should return ok and 200 when both probes are up (F10) · should return degraded and 200 when Redis is down (F10) · should return down and 503 when Postgres is down (F10) · should return down and 503 when shutting down even if both are up (F10) · should count a probe as down when it exceeds 500 ms · should return ok for live when shutting down (F9).
- `lib/lifecycle/graceful-shutdown.test.ts`: should mark not-ready before closing listeners (F19) · should close both listeners before destroying Knex and quitting Redis (F19) · should wait for the in-flight counter to reach zero when requests are running (F19) · should exit 0 when drained before the deadline (F19) · should log unfinishedRequests, force-close connections, and exit 1 when the deadline passes (F19) · should return the same promise when called twice · should continue closing resources when one fails.
- `lib/worker/loop-runner.test.ts`: should run a loop's tick on its interval when started · should keep running when a tick throws and log worker_tick_failed · should resolve stop only after the current tick finishes (F20) · should wake a sleeping loop immediately when stop is called (F20) · should emit a runner heartbeat when there are no loops.

### 9.3 Integration tests (`tests/integration/`)
- `health.test.ts`: should return 200 {status:"ok"} when GET /api/health/live is called (F9) · should return 200 {status:"ok"} when GET /internal/health/live is called on the internal app · should return 200 ok with database and redis up when both are reachable (F10) · should return 200 degraded when Redis is unreachable (child container with `createUnreachableRedis`) (F10, F16) · should return 503 down when Postgres is unreachable (child container with a Knex on a closed port) (F10) · should return 503 when shutdown has been marked (F10) · should set X-Request-Id and Cache-Control no-store on health responses (F3) · should return 404 for /api/health on the internal app and /internal/health on the public app (F11) · should match the contract HealthLive and HealthReady shapes exactly (contract conformance).
- `migrations.test.ts`: should have btree_gist installed after migrate latest (F21) · should remove and re-create btree_gist when rolled back and migrated again (F21; re-applies in `finally`) · should report UTC when SHOW TIME ZONE runs on a pooled connection (F8).
- `envelope.test.ts`: should return a NotFound envelope with the request id when the path is unknown on either listener (F4, F11) · should echo a valid incoming X-Request-Id and replace an invalid one (F3) · should return 400 ValidationFailed when the JSON body is malformed (F5) · should return 400 ValidationFailed when the body exceeds 100kb (F5) · should return 500 InternalError without internals when a test route throws (F4) · should validate a DTO and reject unknown properties on a test route (F6).
- `idempotency.test.ts` (test router `POST /api/__test/idem` with a call counter, `required: true`): should replay the original status and body and run the handler once when the same key and body repeat (F12) · should return 422 IdempotencyConflict when the same key has a different body (F13) · should return 400 ValidationFailed when the key is missing (F14) · should run the handler once and answer the loser with 409 Conflict and Retry-After 1 when two requests with the same key race against a slow handler (F15) · should replay with the current request id in error.requestId when the stored response was an error · should run the handler again when the first attempt returned 5xx · should store the record under idem:POST /api/__test/idem:ip:<ip>:<key> with a TTL of at most 24 h · should run the handler on every request and never 5xx when Redis is unreachable (F16).
- `rate-limit.test.ts` (test router, `limit: 3`, `windowMs: 1000`, `subject: byIp`): should admit 3 requests then return 429 with Retry-After when the limit is exceeded (F17) · should store hits under rl:<name>:<subject> · should admit again when the window has slid (F17) · should apply floor(3 / 2) = 1 per instance when Redis is unreachable (F18).
- `cors.test.ts`: should return allow-origin for an allowlisted origin when NODE_ENV is development (F22) · should return no CORS headers on the internal listener (F22).
- `logs.test.ts`: should contain no synthetic complaint or email fixture strings in captured logs when requests with those values in bodies fail validation, fail JSON parsing, and throw (F7) · should carry the response's X-Request-Id on a log line written by a test service called from a route (AsyncLocalStorage).
- Lint rules (F23) are verified by CI's `npm run lint`; one unit test `tests/unit/lint/restricted-imports.test.ts` runs ESLint's Node API on in-memory snippets: should report an error when src/pkg imports lib · should report an error when src/lib imports app · should report an error when any file imports axios or jsonwebtoken.

Concurrency, RBAC, and Case 1–3 mandatory scenarios do not apply (no business routes, no Identity calls).

---

## 10. Out of scope
`lib/auth` (JWKS, user/service guards), `lib/rbac/authorize`, `lib/audit`, `lib/identity-client`, `lib/storage`,
`lib/video`, `lib/email`, notification outbox and `identity_sync_jobs` tables, `pkg/slots`, `pkg/utils/interval.ts`,
any business table or route, a metrics exporter (ADR 0007 — log-derived), OpenTelemetry, read-replica routing
(`DATABASE_READ_URL`), `checks.identityJwks` in readiness (arrives with `lib/auth`), the worker's Postgres/Redis
wiring (arrives with the first loop), and every env variable not listed in §3.4.1.

---

## 11. Open questions
None.

---

## 12. Required follow-ups (decided; not open)

### 12.1 Contract change (applied by the orchestrator before `/develop`; ADR 0006)
In `contracts/openapi.yaml`:
1. **Remove** paths `/api/health` (`getHealth`) and `/internal/health` (`getInternalHealth`) and responses `HealthOk`
   and `HealthDown`; **replace** schema `HealthStatus` with the readiness body below (name kept, identical to identity).
2. **Add** paths (all `tags: [health]` — internal ones `[health, internal]` with the `http://localhost:3101` server
   override — `security: []`, `x-roles: [public]`, `x-ownership: none`, parameter `RequestId`):
   | Path | operationId | Responses |
   |---|---|---|
   | `/api/health/live` | `getPublicLiveness` | `200 HealthLiveOk` |
   | `/api/health/ready` | `getPublicReadiness` | `200 HealthReadyOk`, `503 HealthReadyDown` |
   | `/internal/health/live` | `getInternalLiveness` | `200 HealthLiveOk` |
   | `/internal/health/ready` | `getInternalReadiness` | `200 HealthReadyOk`, `503 HealthReadyDown` |
   Descriptions: live — "Liveness: no dependency checks; used by the orchestrator to restart; never 503."
   ready — "Readiness: Postgres `SELECT 1` (500 ms) is fatal; Redis `PING` (500 ms) is reported only; 503 when
   Postgres is down or shutdown is in progress. Identity is not a dependency. Not rate-limited; not enveloped."
3. **Add** responses, each with headers `X-Request-Id` (`XRequestId`) and `Cache-Control` (`CacheControlNoStore`):
   `HealthLiveOk` → `HealthLive`; `HealthReadyOk` (description "Postgres reachable; `degraded` when Redis is down")
   → `HealthStatus`; `HealthReadyDown` (description "Postgres unreachable or shutting down") → `HealthStatus`.
4. **Add/replace** schemas:
   ```yaml
   HealthLive:
     type: object
     required: [status]
     additionalProperties: false
     properties:
       status: { type: string, const: ok }
   HealthStatus:
     type: object
     required: [status, checks]
     additionalProperties: false
     properties:
       status: { type: string, enum: [ok, degraded, down] }
       checks:
         type: object
         required: [database, redis]
         properties:
           database: { type: string, enum: [up, down] }
           redis: { type: string, enum: [up, down], description: Reported only; Redis is Tier 2 and never fails readiness. }
     example: { status: degraded, checks: { database: up, redis: down } }
   ```
5. Applied to `contracts/openapi.yaml` on 2026-09-15. The hub sync (`../vcare-hub/scripts/sync-from-spoke.sh`) is run
   separately by the orchestrator.

### 12.2 ADR written by the developer
`docs/adr/0016-foundation-runtime-dependencies.md` — adds `reflect-metadata` (tsyringe prerequisite); dev CORS
implemented in-house (`lib/http/cors.ts`) instead of the `cors` package; no `uuid` (`crypto.randomUUID`) and no
`dotenv` (`node --env-file-if-exists`, `process.loadEnvFile`); records that `jose`, `luxon`, `undici` are deferred to
their modules; lists dev dependencies (`tsx` for dev/migrate, `ts-jest`, `supertest`, `typescript-eslint`) and why
`tsx` is safe with tsyringe (explicit `@inject` on every parameter).

### 12.3 Docs updated after the build (`/update-docs foundation`)
- `docs/architecture/infrastructure.md`: mark implemented variables; add `INTERNAL_HOST`, `TRUST_PROXY_HOPS`,
  `SHUTDOWN_TIMEOUT_MS`; drop the defaults shown for `DATABASE_URL`/`REDIS_URL` (secrets) and document local
  5433/6380; health section loses "contract change pending"; add the redaction mechanics and graceful-shutdown steps.
- `docs/quickstart.md`: `docker compose up` path, host ports 5433/6380, `npm run migrate`, `curl /api/health/ready`
  with the new body; Postgres 17.
- `docs/architecture/overview.md`: Postgres 17; health routes; request-context propagation.
- `docs/service-card.md`: health endpoints now `/api/health/live|ready` and `/internal/health/live|ready` (no longer
  planned) — **service card affected**.
- `docs/runbook.md`: readiness semantics if it still references `/api/health`.
- `docs/INDEX.md`: rows for `foundation/brainstorm.md`, `foundation/spec.md` (added with this spec), later `tasks.md`,
  `manual-qa.md`, ADR 0016.
