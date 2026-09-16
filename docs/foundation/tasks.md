---
title: foundation — Tasks
owner: care-team
service: care-service
module: foundation
status: in-progress
last_verified: 2026-09-16
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
- [~] (tooling) Docker + env: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `docker-compose.test.yml` done — **`.env.example` and `.env.test` BLOCKED** by a local permission deny rule on env files; contents are in spec §3.8 and must be created by a human before `npm run test:integration` can run (`tests/setup-env.ts` reads `.env.test`)
- [x] (tooling) CI: `.github/workflows/ci.yml`
- [x] (tests) scaffolding only — `tests/setup-env.ts`, `tests/setup.ts`, `tests/helpers/{db,redis,app,fake-http-server,log-capture,types}.ts`, `tests/integration/global-{setup,teardown}.ts`
- [x] (tests) verify green: `npm install`, `npm run lint` (0 problems), `npm run typecheck` (0 errors), `npm run build`
- [x] (manual-qa) verified against real infra (compose test stack, Postgres 17 + Redis 7): migrate latest/rollback/latest, `btree_gist` present/absent/present, `GET /api/health/live|ready` and `/internal/health/live|ready` 200 with the contract bodies, cross-listener 404s, `NotFound` envelope with echoed request id, dev CORS preflight
- [ ] (tests) ← `/write-tests foundation` (unit + integration test files per spec §9)
- [ ] (manual-qa) ← `/manual-qa foundation`
- [ ] (docs) ← `/update-docs foundation` (spec §12.3: infrastructure, quickstart, overview, service-card, runbook, INDEX)

## Notes for the next phases
- Graceful shutdown (`shutdown_started` … `shutdown_complete`) could not be proven from this shell: Git Bash `kill -TERM` force-terminates native Windows processes instead of delivering SIGTERM. It is covered by the unit tests in spec §9.2 (`graceful-shutdown.test.ts`) and by Linux CI / Docker (`STOPSIGNAL SIGTERM`).
- `requestLogger` logs `/health/` routes at `debug`, so health requests are invisible at `LOG_LEVEL=info` by design (spec §3.4.4).
- `@types/pg` was added as a dev dependency (types-only, for the already-locked `pg`); recorded in ADR 0016.
