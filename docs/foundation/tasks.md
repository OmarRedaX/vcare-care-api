---
title: foundation — Tasks
owner: care-team
service: care-service
module: foundation
status: done
last_verified: 2026-09-28
tags: [tasks, foundation, bootstrap, infrastructure, health, ci, docker]
related: [foundation-spec, foundation-brainstorm, foundation-manual-qa, adr-0016-foundation-runtime-dependencies, adr-0006-health-split-redis-tier-2, adr-0008-care-worker-component]
---

# foundation — Tasks

Source of truth: [spec.md](./spec.md) (status `implemented`, version 1.1.0; As-built notes in §13). Build order tags follow CLAUDE.md → "Build order for a new module".

## Legend
- [ ] todo · [~] in progress · [x] done

## Units
This run has two independent units, developed in parallel by separate agents in separate repos:

| Unit | Repo | Owns |
|---|---|---|
| `care:foundation` | `vcare-care-api` (this repo) | everything in this file |
| `identity:foundation` | `vcare-identity-api` | the identity-service skeleton; parity items in spec §1.4 are shared definitions and change only in both repos |

No file in this unit is shared with `identity:foundation`; the hub is not touched by either.

## Tasks

- [x] (contract) health live/ready operations + schemas in `contracts/openapi.yaml` — applied by the orchestrator on 2026-09-15 (spec §12.1); implemented to match, not re-edited
- [x] (docs) `docs/adr/0016-foundation-runtime-dependencies.md` (spec §12.2)
- [x] (tooling) `package.json`, `.npmrc`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.mjs`, `jest.config.js`, `jest.integration.config.js`
- [x] (enums-errors-types) `lib/config/{env,types}.ts` — zod env schema, `parseEnv`, `getEnv`, `InvalidEnvError` (keys only)
- [x] (enums-errors-types) `lib/error/{AppError,errors,errorHandler,not-found,types}.ts`
- [x] (enums-errors-types) `lib/types/{types.ts,express.d.ts}`
- [x] (service) `lib/logger/{logger,redact,request-context,request-logger,types}.ts`
- [x] (service) `lib/request-id/request-id.ts`
- [x] (service) `lib/http/{response,no-store,cors,client-ip,types}.ts` + `lib/http/pagination/{cursor,page,types}.ts`
- [x] (request-dto) `lib/http/pagination/pagination.request.dto.ts`
- [x] (service) `lib/validation/{validate,types}.ts`
- [x] (repository) `lib/knex/{knex,knexfile,probe,types}.ts` — lazy pool, UTC + statement timeout `afterCreate`, int8/date parsers
- [x] (service) `lib/redis/{redis,types}.ts`
- [x] (service) `lib/idempotency/{idempotency,idempotency-store,types}.ts`
- [x] (service) `lib/rate-limit/{rate-limit,sliding-window.lua,memory-limiter,subjects,types}.ts`
- [x] (service) `lib/lifecycle/{shutdown-state,in-flight,graceful-shutdown,types}.ts`
- [x] (service) `lib/worker/{loop-runner,types}.ts`
- [x] (service) `lib/di/{tokens,container,register-core}.ts`
- [x] (service) `pkg/utils/{time,canonical-json,types}.ts`
- [x] (enums-errors-types) `app/health/{enums,types}.ts`
- [x] (response-dto) `app/health/dto/health.response.dto.ts`
- [x] (service) `app/health/service/health.service.ts` + registration in `src/bootstrap.ts`
- [x] (controller) `app/health/controller/health.controller.ts` + registration in `src/bootstrap.ts`
- [x] (routes) `app/health/routes.ts` — documented no-`authorize` exception (public infrastructure probe)
- [x] (mount) `src/app.ts`, `src/internal-app.ts`, `src/routes.ts`, `src/internal-routes.ts`, `src/bootstrap.ts`, `src/server.ts`, `src/worker.ts`, `src/worker-loops.ts`, `src/migrate.ts`
- [x] (migration) `src/migrations/20260915000000_create_extension_btree_gist.ts` — applied, rolled back, and re-applied against Postgres 17
- [x] (tooling) Docker + env: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `docker-compose.test.yml`; `.env.example`, `.env.test`, `.env.test.example` created by a human from spec §3.8 (commit `74f3ce6`) because a local permission deny rule blocks agents from env files
- [x] (tooling) CI: `.github/workflows/ci.yml`
- [x] (tests) scaffolding only — `tests/setup-env.ts`, `tests/setup.ts`, `tests/helpers/{db,redis,app,fake-http-server,log-capture,types}.ts`, `tests/integration/global-{setup,teardown}.ts`
- [x] (tests) verify green: `npm install`, `npm run lint` (0 problems), `npm run typecheck` (0 errors), `npm run build`
- [x] (manual-qa) verified against real infra (compose test stack, Postgres 17 + Redis 7): migrate latest/rollback/latest, `btree_gist` present/absent/present, `GET /api/health/live|ready` and `/internal/health/live|ready` 200 with the contract bodies, cross-listener 404s, `NotFound` envelope with echoed request id, dev CORS preflight
- [x] (tests) `/write-tests foundation` — every spec §9.2/§9.3 file written and green (2026-09-25): `npm test` 27 suites / 347 tests passed; `npm run test:integration` 9 suites / 72 passed, 2 skipped (SIGTERM process tests, win32 only — run on CI); lint 0, typecheck 0. Kept `[~]` because the tests exposed 3 product bugs, pinned as `test.failing` (see "Open product bugs found by tests"); flip to `[x]` once `/develop --fix-review` fixes them and the `test.failing` markers become plain tests. **2026-09-28:** all three bugs fixed, the 5 `test.failing` markers are plain tests, `npm test` 33 suites / 424 tests passed; `npm run test:integration` could not run (Docker Desktop down, globalSetup `ECONNREFUSED`) — re-run it before merging (it ran later the same day: 11 suites / 85 passed + 2 skipped, see "Fix-review round 2" below)
- [x] (manual-qa) `/manual-qa foundation` (2026-09-26) against the containerised dev stack (`care-api` `NODE_ENV=production`, 3001/3101): [manual-qa.md](./manual-qa.md), 52 scenarios, 50 pass / 1 fail / 1 known; `scripts/curl-test-foundation.sh` 94 pass / 3 fail (read-only) and 121 pass / 3 fail / 1 known (`RUN_INFRA_CASES=1`, Redis and Postgres stopped and restored). Kept `[~]`: one real failure, open product bug 4 below (the 3 failing assertions are all that bug). Known bug 2 reproduced (15–18 raw Knex lines per Postgres outage); bugs 1 and 3 are not observable through CURL · **Re-run 2026-09-28 after `--fix-review`** (rebuilt dev stack): `scripts/curl-test-foundation.sh` 97 pass / 0 fail / 0 known (read-only) and 125 pass / 0 fail / 0 known (`RUN_INFRA_CASES=1`); bug 4 (`OPTIONS`, #4) fixed; dev DB `knex_migrations` names stripped of `.js` for the new migration source
- [x] (docs) ← `/update-docs foundation` (spec §12.3: infrastructure, quickstart, overview, service-card, runbook, INDEX) — done 2026-09-28; every backlog bullet below verified against the code first
  - Docs backlog carried over from the deleted review file (2026-09-28), for `/update-docs foundation`:
    - [x] contract: say `X-Request-Id` is echoed lower-cased — care's `XRequestId` header and `RequestId` parameter descriptions updated (flagged for the hub sync); identity's contract is an identity-side follow-up (not edited here)
    - [x] stale health references: `architecture/api.md` (health table, conventions: `details` always present, lower-cased id), `architecture/infrastructure.md` (Health section, "contract change pending" removed), `architecture/deployment.md` (§6 health item marked done), `quickstart.md` (`/api/health` → `/api/health/live|ready`, 404 noted), `service-card.md` (health live, status "foundation built") → hub re-sync needed
    - [x] `docs/INDEX.md`: rows for `foundation/tasks.md`, `foundation/manual-qa.md`, `adr/0016`; `system-design.md` Key decisions gained ADR 0016 (ADR 0017 already had rows in both)
    - [x] spec §12.1 "identical" claim corrected in place (bodies identical, schemas differ: `additionalProperties: false`) + spec §13.2; `manual-qa.md` Contract conformance gained the same correction
    - [x] `architecture/capacity.md`: connections now `DATABASE_POOL_MAX + 1` per task, shown for the code default 20 (47 / 131) and the earlier assumed 10 (27 / 71); production value left undecided → `/system-design` platform delta for hub `capacity.md`
    - [x] `architecture/resilience.md`: timeouts table (pg connect 2 s, acquire 1 s, statement 2 s, query 3 s, keepalive, probes 500 ms, Redis connect 2 s / command 500 ms, HTTP, shutdown) + new "Postgres failure modes" (`pool.validate` discard, readiness recovery after one ≤ 3 s timed-out probe query, pooler caveat); idempotency rows now say immediate `409 Conflict` + `Retry-After: 1`
    - [x] `architecture/infrastructure.md`: env split into implemented / planned; rows for `INTERNAL_HOST` (IP literal), `TRUST_PROXY_HOPS` (#16), `SHUTDOWN_TIMEOUT_MS`; `DATABASE_URL` query-string restriction; no defaults shown for secrets; new "Database connection" (pools, timeouts, startup parameters, `validate`, pooler caveat, `int8[]` #17), "Redis connection", redaction mechanics, "Boot and shutdown" (`boot_failed`, drain, per-resource deadline), "Local stack" (loopback-only ports)
    - [x] `runbook.md`: new "Boot and shutdown log lines" (`invalid_environment` naming `DATABASE_URL` → check its query string, `boot_failed`, `shutdown_resource_timeout`, `knex_warn`/`knex_error`, …); `HealthCheckFailing` action; Identity health path
    - [x] `quickstart.md`: steps 1–3 rewritten for the built foundation (compose, loopback ports, `npm run migrate`, health checks), dev-DB reset note (`docker compose down -v` or the `knex_migrations` UPDATE), `migrate:make` loads `.env`; steps 4–9 marked `(planned)`

### Fix-review — `reviews/review-20260926-0822.md` (2026-09-28; scope fixed by the user on 2026-09-26: 11 fixes, 13 deferred)
- [x] (docs) spec-first edits in `spec.md` (§3.3, §3.4.1, §3.4.4, §3.4.8, §3.4.9, §3.4.10, §3.4.12, §3.4.13, §3.1, §3.8, §8)
- [x] (contract) in-flight idempotency `409 Conflict` + `Retry-After: 1` on every `Idempotency-Key` operation (Medium)
- [x] (service) `serializeError` drops pg/knex messages; frames-only stacks; `compileSqlOnError: false` (Critical, bug 1)
- [x] (service) idempotency settles on `res.end`; owner nonce + compare-and-delete when `SET NX` throws; `autoResendUnfulfilledCommands: false` (High + parity e)
- [x] (service) graceful shutdown: `Connection: close` while draining, `closeIdleConnections()` once idle, resources bounded by the deadline (Medium ×2)
- [x] (service) readiness probes through a dedicated 1-connection pool (Medium)
- [x] (repository) pg connect/query timeouts, TCP keepalive, startup-parameter session settings (Medium)
- [x] (service) Knex `log` routed through `Logger` (Low, bug 2)
- [x] (enums-errors-types) `INTERNAL_HOST` must be an IP literal (Low, bug 3)
- [x] (mount) `OPTIONS` on a known path → 404 envelope on both listeners (Low, bug 4)
- [x] (tooling) `migrate:make` loads `.env`; compose binds Postgres/Redis to 127.0.0.1 (Low ×2)
- [x] (service) parity c: `boot_failed` JSON line + exit 1 on boot errors; parity d: extension-free migration names
- [x] (tests) regression tests per finding; the 5 `test.failing` markers become plain tests — verified 2026-09-28: unit 33 suites / 424 passed; `npm run test:integration` 10 suites / 81 passed + 2 skipped (SIGTERM, win32 only) against the test stack (5434/6381)

#### Fix-review notes (2026-09-28)
- Deferred by the user: 13 latent findings, each marked `DISPUTED — deferred to #5…#17` in the review file (fix before the first module that mounts routes reaching them).
- **Local dev database:** migration names are now recorded without the file extension (parity d). A dev volume migrated by the old code (`care-pg-data`) still holds `20260915000000_create_extension_btree_gist.js` and will report "migration directory is corrupt": `docker compose down -v`, or `UPDATE knex_migrations SET name = regexp_replace(name, '\.(js|ts)$', '')`. The test stack is `tmpfs`.
- **Needs the user (not an agent):** add the in-flight idempotency case (`409 Conflict` + `Retry-After: 1`) to the CLAUDE.md "API conventions" `Conflict` row — agents do not edit CLAUDE.md.
- **Platform delta for `/system-design`:** each `care-api` task now opens up to `DATABASE_POOL_MAX + 1` Postgres connections (the readiness probe pool, `application_name=care-api-probe`); the hub capacity roll-up and the local capacity shard should count it.
- **For `/update-docs`:** `docs/architecture/infrastructure.md` / `resilience.md` (pg connect/query timeouts, TCP keepalive, startup-parameter session settings, probe pool, `Connection: close` drain, bounded resource close, `boot_failed`), `quickstart.md` (compose ports bound to 127.0.0.1; the dev-DB migration-name reset above).
- `npm run test:integration` and `scripts/curl-test-foundation.sh` were not run (Docker Desktop down); manual QA stays `[~]` until section D is re-run against a server. _(Superseded the same day: both ran green — see round 2 below and the manual-qa row.)_

### Fix-review round 2 — `reviews/review-20260926-0822.md` "Re-review 2026-09-28" (2 OPEN items, both RESOLVED 2026-09-28)
- [x] (docs) spec-first edits in `spec.md` (§2, §3.4.1 `DATABASE_URL` row + rationale, §3.4.8 `query_timeout` row + `pool.validate` bullet, §8, §9.4)
- [x] (repository) re-opened Medium: a connection whose query timed out is discarded by the pool, not reissued — `pool.validate: isConnectionIdle` (`src/lib/knex/pg-connection-state.ts`) on every `createKnex` pool (`db`, `probeDb`, worker, migrate)
- [x] (enums-errors-types) new Low: `DATABASE_URL` carrying `options` / `statement_timeout` / `query_timeout` / `application_name` is rejected at env validation (option (a); rationale in spec §3.4.1)
- [x] (tests) regression tests: `tests/integration/knex-dead-connection.test.ts` (TCP black-hole proxy `tests/helpers/black-hole-proxy.ts`; request pool + readiness on both listeners; both cases fail with the `validate` line removed), `tests/unit/lib/knex/pg-connection-state.test.ts` (pg 8.23 private-field shape pin), `env.test.ts` rejection cases, `migrations.test.ts` `SHOW TIME ZONE` on `probeDb`/migrator + rejected-`options` case
- [x] (tests) verify (observed 2026-09-28): `npm run typecheck` 0 errors · `npm run lint` 0 problems · `npm test` 34 suites / 442 passed · `npm run test:integration` 11 suites / 85 passed + 2 skipped (SIGTERM process tests, win32 only) against the test stack (5434/6381)

#### Round-2 notes
- **For `/update-docs`:** `resilience.md` / `infrastructure.md` — a connection whose query hit `query_timeout` is discarded on its next acquire; `DATABASE_URL` must not carry `options`, `statement_timeout`, `query_timeout`, or `application_name` (boot fails with `invalid_environment`); `runbook.md` — the `invalid_environment` line names only `DATABASE_URL`, so check the URL's query string.
- **pg upgrade watch:** `isConnectionIdle` reads pg-private fields; `pg-connection-state.test.ts` fails on any pg other than 8.23.x or a changed field shape — re-verify the helper before bumping pg.

## Notes for the next phases
- Graceful shutdown (`shutdown_started` … `shutdown_complete`) could not be proven from this shell: Git Bash `kill -TERM` force-terminates native Windows processes instead of delivering SIGTERM. It is covered by the unit tests in spec §9.2 (`graceful-shutdown.test.ts`) and by Linux CI / Docker (`STOPSIGNAL SIGTERM`).
- `requestLogger` logs `/health/` routes at `debug`, so health requests are invisible at `LOG_LEVEL=info` by design (spec §3.4.4).
- `@types/pg` was added as a dev dependency (types-only, for the already-locked `pg`); recorded in ADR 0016.

## Open product bugs found by tests (2026-09-25, `/write-tests foundation`)
**All four fixed on 2026-09-28 by `/develop foundation --fix-review`** (see `reviews/review-20260926-0822.md`); the `test.failing` markers are now plain tests and bug 4 has unit + integration tests.
Each was pinned by a `test.failing` case (passes while the bug exists; turns red when the code is fixed, prompting removal of the marker).
1. **Request values leak into logs through pg error messages** (privacy) — `src/lib/logger/logger.ts:25-37` `serializeError` keeps `message` + `stack`; Postgres puts the rejected value in the message (`invalid input syntax for type integer: "<value>"`); `src/lib/error/errorHandler.ts:49` logs it as `unhandled_error`. Test: `tests/integration/logs.test.ts` → "should not leak a request value into logs when Postgres rejects it in an unhandled error (F7)".
2. **Knex writes raw console output** — `src/lib/knex/knex.ts:23-46` passes no `log` option, so Knex's default logger prints an ANSI `console.log` "Acquire connection error: …" line outside the JSON logger during a Postgres outage. Test: `tests/integration/health.test.ts` → "should write no raw (non-JSON) console output when the Postgres pool cannot connect".
3. **`INTERNAL_HOST` accepts non-IPs** — `src/lib/config/env.ts:29` refine accepts `999.999.999.999`, `cafe`, `1.2.3` (spec §3.4.1: `string().ip()`); the process fails later at `listen()` instead of at env validation (F1). Test: `tests/unit/lib/config/env.test.ts` → "should reject INTERNAL_HOST when it is not a valid IP address".

4. **`OPTIONS` on a known path answers 200 `text/plain` instead of the 404 envelope** (found by `/manual-qa foundation`, 2026-09-26; low severity). `OPTIONS /api/health/live` and `OPTIONS /internal/health/ready` → 200, `Allow: GET, HEAD`, body `GET, HEAD`. Express 5's router auto-answers `OPTIONS` for a matched path with no `OPTIONS` handler, so `notFound`/`errorHandler` never run. Violates spec §3.4.3 ("Unmatched methods on a known path are also 404"). Every later router inherits it. Fix: an `OPTIONS` fall-through to `notFound` on both apps (after `cors()`), or amend the spec. No test pins it yet; `scripts/curl-test-foundation.sh` section D asserts it. identity-service shares the design (spec §1.4 parity).

## Test-side fixes made by `/write-tests foundation`
- `tests/integration/global-setup.ts`: `.env.test` is now loaded before `src/lib/knex/knex` is imported (that module calls `getEnv()` at load; globalSetup runs outside `setupFiles`, so the old import order made every integration run `exit(1)` on "invalid_environment").
- `tests/helpers/redis.ts`: added `ensureRedisReady()`; new helpers `tests/helpers/contract.ts` (contract conformance read from `contracts/openapi.yaml`, no new dependency) and `tests/helpers/test-routers.ts` (test-only routers mounted via `extraRouters`).
