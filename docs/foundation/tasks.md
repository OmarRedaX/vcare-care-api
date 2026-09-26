---
title: foundation — Tasks
owner: care-team
service: care-service
module: foundation
status: in-progress
last_verified: 2026-09-26
tags: [tasks, foundation, bootstrap, infrastructure, health, ci, docker]
related: [foundation-spec, foundation-brainstorm, adr-0016-foundation-runtime-dependencies, adr-0006-health-split-redis-tier-2, adr-0008-care-worker-component]
---

# foundation — Tasks

Source of truth: [spec.md](./spec.md) (status `ready`). Build order tags follow CLAUDE.md → "Build order for a new module".

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
- [~] (tests) `/write-tests foundation` — every spec §9.2/§9.3 file written and green (2026-09-25): `npm test` 27 suites / 347 tests passed; `npm run test:integration` 9 suites / 72 passed, 2 skipped (SIGTERM process tests, win32 only — run on CI); lint 0, typecheck 0. Kept `[~]` because the tests exposed 3 product bugs, pinned as `test.failing` (see "Open product bugs found by tests"); flip to `[x]` once `/develop --fix-review` fixes them and the `test.failing` markers become plain tests
- [~] (manual-qa) `/manual-qa foundation` (2026-09-26) against the containerised dev stack (`care-api` `NODE_ENV=production`, 3001/3101): [manual-qa.md](./manual-qa.md), 52 scenarios, 50 pass / 1 fail / 1 known; `scripts/curl-test-foundation.sh` 94 pass / 3 fail (read-only) and 121 pass / 3 fail / 1 known (`RUN_INFRA_CASES=1`, Redis and Postgres stopped and restored). Kept `[~]`: one real failure, open product bug 4 below (the 3 failing assertions are all that bug). Known bug 2 reproduced (15–18 raw Knex lines per Postgres outage); bugs 1 and 3 are not observable through CURL
- [ ] (docs) ← `/update-docs foundation` (spec §12.3: infrastructure, quickstart, overview, service-card, runbook, INDEX)

## Notes for the next phases
- Graceful shutdown (`shutdown_started` … `shutdown_complete`) could not be proven from this shell: Git Bash `kill -TERM` force-terminates native Windows processes instead of delivering SIGTERM. It is covered by the unit tests in spec §9.2 (`graceful-shutdown.test.ts`) and by Linux CI / Docker (`STOPSIGNAL SIGTERM`).
- `requestLogger` logs `/health/` routes at `debug`, so health requests are invisible at `LOG_LEVEL=info` by design (spec §3.4.4).
- `@types/pg` was added as a dev dependency (types-only, for the already-locked `pg`); recorded in ADR 0016.

## Open product bugs found by tests (2026-09-25, `/write-tests foundation`)
Each is pinned by a `test.failing` case (passes while the bug exists; turns red when the code is fixed, prompting removal of the marker).
1. **Request values leak into logs through pg error messages** (privacy) — `src/lib/logger/logger.ts:25-37` `serializeError` keeps `message` + `stack`; Postgres puts the rejected value in the message (`invalid input syntax for type integer: "<value>"`); `src/lib/error/errorHandler.ts:49` logs it as `unhandled_error`. Test: `tests/integration/logs.test.ts` → "should not leak a request value into logs when Postgres rejects it in an unhandled error (F7)".
2. **Knex writes raw console output** — `src/lib/knex/knex.ts:23-46` passes no `log` option, so Knex's default logger prints an ANSI `console.log` "Acquire connection error: …" line outside the JSON logger during a Postgres outage. Test: `tests/integration/health.test.ts` → "should write no raw (non-JSON) console output when the Postgres pool cannot connect".
3. **`INTERNAL_HOST` accepts non-IPs** — `src/lib/config/env.ts:29` refine accepts `999.999.999.999`, `cafe`, `1.2.3` (spec §3.4.1: `string().ip()`); the process fails later at `listen()` instead of at env validation (F1). Test: `tests/unit/lib/config/env.test.ts` → "should reject INTERNAL_HOST when it is not a valid IP address".

4. **`OPTIONS` on a known path answers 200 `text/plain` instead of the 404 envelope** (found by `/manual-qa foundation`, 2026-09-26; low severity). `OPTIONS /api/health/live` and `OPTIONS /internal/health/ready` → 200, `Allow: GET, HEAD`, body `GET, HEAD`. Express 5's router auto-answers `OPTIONS` for a matched path with no `OPTIONS` handler, so `notFound`/`errorHandler` never run. Violates spec §3.4.3 ("Unmatched methods on a known path are also 404"). Every later router inherits it. Fix: an `OPTIONS` fall-through to `notFound` on both apps (after `cors()`), or amend the spec. No test pins it yet; `scripts/curl-test-foundation.sh` section D asserts it. identity-service shares the design (spec §1.4 parity).

## Test-side fixes made by `/write-tests foundation`
- `tests/integration/global-setup.ts`: `.env.test` is now loaded before `src/lib/knex/knex` is imported (that module calls `getEnv()` at load; globalSetup runs outside `setupFiles`, so the old import order made every integration run `exit(1)` on "invalid_environment").
- `tests/helpers/redis.ts`: added `ensureRedisReady()`; new helpers `tests/helpers/contract.ts` (contract conformance read from `contracts/openapi.yaml`, no new dependency) and `tests/helpers/test-routers.ts` (test-only routers mounted via `extraRouters`).
