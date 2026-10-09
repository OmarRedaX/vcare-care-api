---
title: admin-doctors — Tasks
owner: care-team
service: care-service
module: admin-doctors
status: in-progress
last_verified: 2026-10-09
tags: [tasks, admin-doctors, identity-sync, suspension, reinstatement]
related: [admin-doctors-spec, admin-doctors-brainstorm, adr-0021-identity-sync-engine-module]
---

# admin-doctors — Tasks

Spec: [spec.md](./spec.md) v0.2.0 (Appendix B ordering). Build-order tags in parentheses.

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
- [x] (tests) admin-doctors and identity-sync unit + integration suites of spec 9 (`tests/integration/admin-doctors.test.ts` 67 tests; unit suites under `tests/unit/app/admin-doctors/`, `tests/unit/app/identity-sync/`, `tests/unit/contract/admin-doctors-contract.test.ts`), fake Identity server (`suspended -> active`, recorded PATCH bodies, 500 code point reason limit), `FakeClock`, `truncateCodePoints`, `siblings`; verification, schedules, doctors, boot, db-roles and worker-partitions integration re-run green. Open note: the contract operations do not declare `Idempotency-Key`, `422` or the in-flight `409` that the routes implement (tracked by a `test.failing` in `admin-doctors-contract.test.ts`)
- [ ] (manual-qa) <- /manual-qa
- [~] (docs) service-card, INDEX and ADR 0021 done; `architecture/*`, `runbook.md` and `system-design.md` deltas of spec Appendix A are left to /update-docs
