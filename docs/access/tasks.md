---
title: access — Tasks
owner: care-team
service: care-service
module: access
status: done
last_verified: 2026-10-03
tags: [tasks, access, auth, jwks, rbac, audit, audit-logs, db-roles, worker, redis-breaker]
related: [access-spec, access-brainstorm, adr-0018-db-role-split-explicit-grants-partition-function, adr-0009-audit-logs-monthly-partitions, adr-0016-foundation-runtime-dependencies, adr-0017-generic-helpers-and-transaction-scoping]
---

# access — Tasks

Source of truth: [spec.md](./spec.md) (status `implemented`, version 1.1.0). Build order tags follow CLAUDE.md → "Build
order for a new module". The unit adds **no business route**: its "routes" are the mechanism (`userGuard`,
`authorize`, boot assertion) and test-only routers mounted by integration tests (spec §9.3).

## Legend
- [ ] todo · [~] in progress · [x] done

## Tasks

### Step 0 — contract and hub
- [x] (contract) C1 `HealthStatus.checks.identityJwks` + both readiness descriptions; C2 `bearerUser` JWKS wording (spec §14.2)
- [x] (contract) hub sync `scripts/sync-from-spoke.sh care-service ../vcare-care-api` (hub catalog + contract copy refreshed; hub architecture edits untouched)

### Build
- [x] (tooling) `jose` + `undici` exact deps; ESLint: `jose` only under `lib/auth`, `undici` only in `jwks-fetcher.ts`, no global `fetch` in `src/`; `migrate:ensure-app-login` script (spec §3.11, §3.8)
- [x] (enums-errors-types) `lib/config/{env,types}.ts`: `MIGRATION_DATABASE_URL` (optional, different user), `IDENTITY_JWKS_URL`, `AUDIT_PARTITION_MONTHS_AHEAD`, `getMigrationEnv()`; `.env.example`, `.env.test`, `.env.test.example`, `docker-compose.yml` (spec §3.10)
- [x] (enums-errors-types) `lib/error/errors.ts`: `TokenExpired`, `EmailNotVerified`; `lib/logger/redact.ts` new keys; `pkg/utils/id.ts` `parsePositiveId`
- [x] (migration) `create_app_role` — `vcare_app` NOLOGIN, `CONNECT`, `USAGE ON SCHEMA public` (spec §2.2 #1)
- [x] (migration) `create_audit_logs` — partitioned parent + `DEFAULT`, checks, explicit grants, sequence grant (spec §2.2 #2)
- [x] (migration) `create_audit_logs_ensure_partitions` — `SECURITY DEFINER` function, `EXECUTE` grant, initial partitions (spec §2.2 #3)
- [x] (repository) `lib/knex/app-login.ts` `ensureAppLogin` + `src/migrate.ts` (owner URL, `ensure-app-login` command, make-template grant reminder) (spec §3.8)
- [x] (service) `lib/http/route-pattern.ts` `captureRoute` / `sealRouter` / `routePattern` via `res.locals` — fix #6 (spec §12.2)
- [x] (service) `lib/error/errorHandler.ts` — `URIError` / 4xx non-`AppError` mapping — fix #5 (spec §12.1)
- [x] (service) `lib/redis/breaker.ts` + `isRedisUsable` / `withRedis`; idempotency + rate-limit use them — fix #10 (spec §12.3)
- [x] (service) idempotency record shape guard, compare-and-delete of invalid records, terminal `.catch` in idempotency and rate-limit — fix #11 (spec §12.4)
- [x] (service) `lib/auth/{constants,types,jwks-fetcher,jwks.dto,jwks-cache,user-token-verifier}.ts` (spec §3.3.1–§3.3.5)
- [x] (policies) `lib/rbac/{types,roles,markers,authorize,assert-routes-authorized}.ts` (spec §3.4)
- [x] (routes) `lib/auth/user-guard.ts` (spec §3.3.6)
- [x] (service) `lib/audit/{types,constants,audit}.ts` `AuditRecorder` + `actorFromAuth` (spec §3.5)
- [x] (service) `lib/audit/partition-loop.ts` + `src/worker.ts` (own pool, `--once <loop>`, pool closed on stop) + `src/worker-loops.ts` + `lib/worker/types.ts` (spec §3.6)
- [x] (service) DI tokens + `registerCore` (`JwksCache`, `UserTokenVerifier`, `AuditRecorder`); `server.ts` starts/stops the JWKS cache (spec §3.9)
- [x] (response-dto) health: `checks.identityJwks` in types, service, DTO; health router `markProbeExempt(sealRouter(...))` (spec §3.7)
- [x] (mount) `createPublicApp` / `createInternalApp` call `assertRoutesAuthorized(app.router)` before `extraRouters` (spec §3.2, §3.4.4)
- [x] (tooling) `scripts/access-qa-server.ts` + `tests/helpers/test-routers.ts` `buildAccessTestRouter()` (spec §3.11, §9.3)
- [x] (tests) keep existing unit tests green after the signature changes; integration infra: `global-setup.ts` migrates as owner + `ensureAppLogin`, `db.ts` `ownerDb` + parent-only `truncateAll` (spec §9.1). Full suites ← `/write-tests access`
- [x] (tests) ← `/write-tests access` (spec §9, §12 regressions) — unit 46 suites / 724, integration 18 suites / 180 + 2 skipped on win32 (2026-10-03; at the end of the fix-review rounds: unit 48 suites / 767, integration 18 suites / 192 + 2 skipped)
- [x] (manual-qa) ← `/manual-qa access` (spec §9.7, real local Identity) — 167 pass / 0 fail (2026-10-03): [manual-qa.md](./manual-qa.md), `scripts/curl-test-access.sh` (+ dev-only `scripts/access-qa-fake-identity.ts`; harness `scripts/access-qa-server.ts` now also mounts the audit/params/nested/idempotency/rate-limit test routers)

### Docs (written during development — spec §13)
- [x] (docs) `docs/adr/0018-db-role-split-explicit-grants-partition-function.md` (spec §13.1)
- [x] (docs) `.claude/skills/write-migration/SKILL.md` explicit grants; `.claude/skills/rbac-ownership-guard/SKILL.md` policy shape (spec §13.1)
- [x] (docs) `architecture/{rbac,overview,infrastructure,resilience,data-model,deployment,api,integration}.md`, `runbook.md`, `quickstart.md`, `foundation/spec.md` §1.4 / §13.3 (spec §13.2)
- [x] (docs) `service-card.md` + hub re-sync (`check-freshness.sh`: OK); `docs/INDEX.md` rows (tasks, ADR 0018)

### Fix-review — `reviews/review-20261003-1600.md` (2026-10-03; the review file was deleted after the clean re-review)
- [x] (policies) H1 boot route assertion: handler before `authorize`, terminal `router.use(path, fn)`, mounted sub-app, `router.route()` per-method chains; `markPreAuth` marker
- [x] (repository) M1 `ensureAppLogin`: DDL failures rethrown as `app_login_ddl_failed` (SQLSTATE only)
- [x] (service) M2 Redis `socketTimeout` (`REDIS_SOCKET_TIMEOUT_MS`); stall test recovers without a manual disconnect
- [x] (repository) L1 `ensureAppLogin` refuses a privileged existing role (`app_login_role_privileged`)
- [x] (migration) L2 column-level `INSERT` grant on `audit_logs` + partitions; function re-grants with the column list
- [x] (migration) L3 partition creation via `CREATE TABLE … (LIKE …)` + `ATTACH PARTITION`, `lock_timeout` 200 ms
- [x] (service) L4 `worker --once audit-partitions` exits 1 when partitions were not ensured or the lock was held
- [x] (service) L5 JWKS DTO strips unknown public members, still rejects a private `d` member
- [x] (service) L6 `lib/http/once-next.ts` shared by idempotency + rate-limit; `isRedactedKey` used by `lib/audit`
- [x] (service) L7 `route` on `unhandled_error`, `error_after_headers_sent`, `rate_limit_internal_error`
- [x] (tests) L8 JWKS refresh lifecycle pinned (interval tick, body-phase timeout, boot refresh)
- [x] (tests) L9 `assertTestDatabase()` guard in integration global setup + `ownerDb`
- [x] (contract) D1 `bearerUser` claims `exp`, `iat`, `jti` + 30 s tolerance; hub re-sync
- [x] (docs) D2 `docs/INDEX.md` access/tasks row + these notes

### Fix-review round 2 — same review file, 2 new findings from the re-review (2026-10-03)
- [x] (policies) H `assertRoutesAuthorized` throws `param_callback_without_policy` for any `router.param` / `app.param` callback on a walked router (root, nested, sub-app, probe-exempt)
- [x] (repository) L `ensureAppLogin` refuses an existing role that is a member of any role other than `vcare_app` (`app_login_role_privileged`); the role check also runs under the fixed-error wrapper

## Notes
- **Final state (2026-10-03):** `/review-code access` re-review 2 verified all 16 findings resolved and found nothing
  new, so `docs/access/reviews/` no longer exists (no review file = clean module). Unit 48 suites / 767 passed;
  integration 18 suites / 192 passed + 2 skipped.
- **Current state (2026-10-03):** build, `/write-tests access`, and `/manual-qa access` are done (commits `efc1d83`,
  `fc4da16`, `5af702c`); Docker was up for them — migrations, `ensure-app-login`, the worker loop, and the
  integration suite all ran against the test stack (Postgres 5434 / Redis 6381). The fix-review above adds two
  migrations (`20261003120000_audit_logs_column_insert_grants`, `20261003120100_audit_logs_partitions_attach`): the
  local dev database must be migrated by the user (`npm run migrate`); nothing touched it from this workflow.
- History — results at the end of `/develop access` (2026-10-02): `npm run typecheck` clean · `npm run lint` clean ·
  `npm test` 34 suites / 448 tests pass · `npm run build` clean; `node dist/worker.js --once <unknown>` exits 1 with
  `worker_loop_unknown`, `--once audit-partitions` with Postgres down logs `audit_partition_missing` then
  `worker_tick_failed` and exits 1. A throwaway tsx smoke run (no DB; deleted) confirmed: no token 401, patient on an
  admin route 403, pending doctor on onboarding 200, suspended doctor 403, expired 401 `TokenExpired`, tampered 401,
  `%E0%A4%A` path param 400 `ValidationFailed`, nested-router route label keeps the prefix, one JWKS fetch, readiness
  `identityJwks: up`, boot assertion `route_without_policy` / `route_without_guard`, `policy_invalid` for `suspended`.
- (History, resolved — see the first note.) **Docker Desktop was not running** during `/develop access`: the three migrations, `ensure-app-login`, the worker
  loop against Postgres, and the integration suite were **not** run against a database. The integration helpers were
  updated to compile and to the role split (owner `ownerDb`, global setup migrates as owner + `ensureAppLogin`); the
  migrations / health / knex-dead-connection suites got minimal compatibility edits only. Run
  `npm run test:infra:down && npm run test:infra:up && npm run test:integration` first in `/write-tests access`.
- The dev database must be migrated **in place** by the user (spec §2.3): update `.env` from `.env.example`
  (`MIGRATION_DATABASE_URL`, `DATABASE_URL` → `care_app`, `IDENTITY_JWKS_URL`, `AUDIT_PARTITION_MONTHS_AHEAD`), then
  `npm run migrate && npm run migrate:ensure-app-login`. Until `.env` has `IDENTITY_JWKS_URL`, every local entrypoint
  exits with `invalid_environment`.
- `npm test` / `npm run test:integration` now run Jest through `node --experimental-vm-modules` (jose 6 is ESM-only;
  identity parity). `dist/` loads jose through Node 24's `require(esm)`.
- (History, done in `/write-tests access`.) Every suite of spec §9.2–§9.4 and the §12 regressions, including the three
  `restricted-imports` lint cases (jose, undici, global `fetch`).
- Platform delta (done by the orchestrator 2026-10-02): hub `architecture/deployment.md` → Observability
  `IdentityJwksStale` alert (spec §13.1).
