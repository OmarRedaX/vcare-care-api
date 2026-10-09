---
title: schedules — Tasks
owner: care-team
service: care-service
module: schedules
status: fix-review-applied-awaiting-re-review
last_verified: 2026-10-09
tags: [tasks, schedules, working-hours, exceptions, consultation-types, pkg-slots]
related: [schedules-spec, schedules-brainstorm]
---

# schedules — Tasks

Spec: [spec.md](./spec.md) v1.1.0 (authoritative; section 14 holds the as-built notes). Step numbers are CLAUDE.md → "Build order for a new module".

## Legend
- [ ] todo · [~] in progress · [x] done

## Tasks
- [x] (contract, step 0) C1–C6 edits in contracts/openapi.yaml
- [x] (lib/pkg, step 0a) `src/pkg/slots` open-interval resolution + `lib/validation/date-decorator.ts` (`IsCalendarDate`)
- [x] (migration, step 1) `working_hours` (+ overlap exclusion, grants)
- [x] (migration, step 1) `schedule_exceptions` (+ live-date unique index, grants)
- [x] (migration, step 1) `consultation_types` (+ name unique, active partial index, grants)
- [x] (enums-errors-types, step 2) constants.ts / enums.ts / errors.ts / types.ts / rules.ts
- [x] (entity, step 3) WorkingHour / ScheduleException / ConsultationType entities
- [x] (request-dto, step 4) schedules.request.dto.ts
- [x] (response-dto, step 5) schedules.response.dto.ts
- [x] (repository, step 6) working-hours / schedule-exceptions / consultation-types repos
- [x] (service, step 7) SchedulesService + no-op provider/listener + ScheduleOwnerResolver + DoctorsService additions + tokens + bootstrap
- [x] (doctors-wiring, step 7) `isBookable` active-type term (loadView 5 queries) + doctors unit test delta
- [x] (policies, step 8) policies.ts
- [x] (controller, step 9) SchedulesController
- [x] (routes, step 10) routes.ts
- [x] (mount, step 11) src/routes.ts
- [x] (tests, step 12) written and green (unit 1557 / integration schedules+doctors+boot+db-roles 227); the 5 ms `pkg/slots` budget is verified by the opt-in `npm run test:bench` (3.07 to 3.30 ms best of 100; `npm test` keeps deterministic guards only); review C1/C3 tests added (year 0000 helper, decorator, integration 400; invalid zones after cache) ← was /write-tests: spec §9 in full (pkg/slots exhaustive incl. DST table, IsCalendarDate, DTO/rules/response/service/policies/routes/resolver/no-op/contract unit tests, `tests/integration/schedules.test.ts`, boot/db-roles additions, doctors integration `isBookable` flip). Already done in /develop: doctors unit tests moved to five queries + `isBookable` from the view flag; `migrations.test.ts` round-trip now drops/recreates the three schedules tables first
- [x] (manual-qa, step 13) 2026-10-09: 220 pass / 0 fail on a local PG18 + Memurai + fake-JWKS Care server; `docs/schedules/manual-qa.md`, `scripts/curl-test-schedules.sh`, `scripts/schedules-qa-fake-identity.mjs`; 409 ScheduleConflictsUnconfirmed and in-flight idempotency not provokable over HTTP (see notes)
- [x] (docs, step 14) 2026-10-09 /update-docs: architecture shards (data-model, api, rbac, scheduling-slots, overview), schedules spec v1.1.0 section 14 (as-built notes, QA results, open findings), doctors spec v1.3.0 (five-query view, D-R12, deferred timezone-change impact), INDEX rows, service card, quickstart. Contract unchanged (no drift found).

## Open decisions for the owner
