---
title: admin-doctors — Tasks
owner: care-team
service: care-service
module: admin-doctors
status: done
last_verified: 2026-10-09
tags: [tasks, admin-doctors, identity-sync, suspension, reinstatement]
related: [admin-doctors-spec, admin-doctors-brainstorm, adr-0021-identity-sync-engine-module]
---

# admin-doctors — Tasks

Spec: [spec.md](./spec.md) v1.0.0 (Appendix B ordering; section 12 holds the as-built notes). Build-order tags in parentheses.

## Legend
- [ ] todo · [~] in progress · [x] done

## Tasks
- [x] (contract) four edits of spec section 11 applied to `contracts/openapi.yaml` (no-op wording for suspend/reinstate, `x-audit-actions`, `SuspensionPending.data` required)
- [x] (verify) baseline before the refactor: typecheck clean, `npm test` 90 suites / 1557 tests green; integration suites could not run (Postgres :5434 unreachable in this environment)
- [x] (engine) `src/app/identity-sync/`: enums, constants, types, sync-policy, repository, `IdentitySyncService`, `identity-sync` loop; `VerificationService`, `worker-loops.ts`, `bootstrap.ts`, tokens repointed; sync unit tests ported to `tests/unit/app/identity-sync/`
- [x] (engine) intentional changes (a)-(f) of spec 5.1 inside the extraction (kind-agnostic selection, policy alerts, 500 code point clamp, `SyncTiming`, suspension first, `kind` in alert logs)
- [x] (lib) `pkg/utils/code-points.ts` (`truncateCodePoints`), `sendSuccess` `siblings`
- [x] (enums-errors-types) admin-doctors `constants.ts`, `enums.ts`, `errors.ts`, `types.ts`
- [x] (entity) none: entity-free module, reuses the `doctors` profile entity and mapper
- [x] (request-dto) `SuspendDoctorDto`, `ReinstateDoctorDto`, `DoctorUserIdParamsDto`
- [x] (response-dto) `SuspensionResultResponseDto`, `ReinstatementResultResponseDto`
- [x] (repository) `lockProfileByUserId`, `applySuspension`, `clearSuspension`; `findLatestSyncJob` in the identity-sync repository
- [x] (service) `AdminDoctorsService` + `NoopSuspensionImpactProvider` + container registration
- [x] (policies) `policies.ts`
- [x] (controller) `AdminDoctorsController` + container registration
- [x] (routes) `routes.ts` (no-store, guard, authorize, rate limit, idempotency)
- [x] (mount) `src/routes.ts`
- [x] (tests) admin-doctors and identity-sync unit + integration suites of spec 9 (`tests/integration/admin-doctors.test.ts` 67 tests; unit suites under `tests/unit/app/admin-doctors/`, `tests/unit/app/identity-sync/`, `tests/unit/contract/admin-doctors-contract.test.ts`), fake Identity server (`suspended -> active`, recorded PATCH bodies, 500 code point reason limit), `FakeClock`, `truncateCodePoints`, `siblings`; verification, schedules, doctors, boot, db-roles and worker-partitions integration re-run green. Closed in review: the contract now declares `Idempotency-Key`, `422` and the in-flight `409` (`DoctorTransitionConflict`); the `test.failing` is gone
- [x] (manual-qa) 155 CURL cases pass / 0 fail on two consecutive runs (fake Identity with runtime healthy/down/hang/conflict modes, real API + worker); results in `manual-qa.md`, repeatable via `scripts/curl-test-admin-doctors.sh`; unverified paths listed there
- [x] (review) code review findings resolved and verified clean (2026-10-09, review file removed): `NotBlank` reasons, permanent Identity `400`/`403`/`422`, `attemptsMade`, `syncNow` from the re-read profile, handled-503 `warn`, `suspensionReason` redacted; `npm test` 103 suites / 1824 tests green, DB integration green
- [x] (docs) spec v1.0.0 with as-built notes (section 12), `integration.md`, `resilience.md`, `api.md`, `rbac.md`, `data-model.md`, `overview.md`, `deployment.md`, `system-design.md`, `runbook.md`, `INDEX.md`, `service-card.md`, ADR 0021 reconciled by /update-docs 2026-10-09
