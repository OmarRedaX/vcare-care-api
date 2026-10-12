---
title: consultations — Tasks
owner: care-team
service: care-service
module: consultations
status: done
last_verified: 2026-10-12
tags: [tasks, consultations]
related: [consultations-spec, consultations-brainstorm]
---

# consultations — Tasks

Source: [spec.md](./spec.md) (ready, owner-approved 2026-10-11). Issue #38, branch `feature/consultations`.

## Legend
- [ ] todo · [~] in progress · [x] done

## Tasks
- [x] (contract) C1-C9 description edits in `contracts/openapi.yaml` (no shape change)
- [x] (generic) no-store prefix fix: `NO_STORE_PREFIXES` in `src/routes.ts`, loop in `src/app.ts` before `express.json`, per-router `noStore()` removed from patients/admin-doctors/audit, four malformed-JSON integration tests (`tests/integration/no-store.test.ts`) — **own commit**
- [x] (generic) `exclusionViolationConstraint`, `byUserOfRoles`, `ToCommaList`, `currentRequestIdOrNew`, `Clock` type + `TOKENS.Clock`, `cancelReason` redaction key (+ unit tests)
- [x] (migration) `20261011130000_create_consultations` — table, named constraints, exclusion, commented indexes, grants (+ migration tests: round-trip, grants, `23P01`)
- [x] (migration) `20261011130100_create_notification_outbox` — insert-side only, grants `SELECT, INSERT`
- [x] (pure) `pkg/slots/slot-fit.ts` (`isSlotOnGrid`, `isCoveredByOpenIntervals`) + `toIsoInZone` (+ unit tests incl. DST forward/back)
- [x] (env) `BOOKING_HORIZON_DAYS`, `CANCELLATION_POLICY_MINUTES` in `lib/config/env.ts` + `types.ts`, `.env.example`, `infrastructure.md`
- [x] (enums-errors-types) `constants.ts`, `enums.ts`, `errors.ts`, `types.ts` for `consultations` and `notifications`
- [x] (entity) `Consultation`
- [x] (request-dto) `ConsultationCreateDto`, `RescheduleDto`, `CancelDto`, `ListConsultationsQueryDto`, `GetConsultationQueryDto`
- [x] (response-dto) `ConsultationResponseDto` (viewer-aware; no `complaintText` for admin or list items) + pure `view.ts`
- [x] (repository) `consultations.repo.ts`, `notification-outbox.repo.ts`
- [x] (service) cross-module accessors (`DoctorsService.lockBookingTarget`/`findTimezone`, `SchedulesService.findBookableType`/`resolveOpenDays`, `PatientsService.getForViewer`)
- [x] (service) `NotificationsService`, `ConsultationsService`, `ConsultationQueriesService`, providers, no-op listener, DI tokens + `bootstrap.ts` rebinding
- [x] (policies) `consultations/policies.ts` + `patients` `buildPatientByIdPolicy`
- [x] (controller) `ConsultationsController`, `PatientsController.getById`
- [x] (routes) `consultations/routes.ts`, `GET /patients/:patientUserId` after `/patients/me`
- [x] (mount) `src/routes.ts`
- [x] (tests) unit (pure `slot-fit`, `toIsoInZone`, generic helpers, DTOs, response viewer matrix, policies, env, service rules with mocks, providers incl. `findAffected` benchmark, queries service), contract (`tests/unit/contract/consultations-contract.test.ts` + `tests/integration/consultations-contract.test.ts`), and integration (`consultations.test.ts` smoke, `consultations-rbac`, `consultations-rules`: concurrency, idempotency, DST with a fake clock, suspension race, outbox/audit atomicity, audit, log hygiene, budgets; `consultations-reads`: pagination per scope, Case 2 degrade). Shared harness `tests/helpers/consultations-harness.ts`
- [x] (manual-qa) `scripts/curl-test-consultations.sh` + `docs/consultations/manual-qa.md` (384 pass / 0 fail, 2026-10-12)
- [x] (docs) `/update-docs` 2026-10-12: `data-model`, `api`, `rbac`, `consultation-lifecycle`, `scheduling-slots`, `integration`, `infrastructure`, `resilience`, `clinical-records`, `runbook`, `patients/spec.md` (1.2.0), `schedules/spec.md` (1.2.0), `consultations/spec.md` section 13, service card, INDEX; CLAUDE.md D-R4 wording aligned

- [x] (fix-review) review-20261012-0500: schedule_blocked once per booking, list column subset, hydration pipeline, contract no-store/404 notes, conformance coverage, same-key race and idempotency-retention tests; decisions D-R2/R4/R7/R8 in spec 11 (unit 125/2322, integration 33/1062 +2 skipped). Docs item 16 done at `/update-docs`

## Notes
- Out of this slice (spec 10): sessions, records, discovery cache, outbox delivery/reminder scan.
- Deviation from spec 3.3 / 3.6: `DoctorsService.findBookingTarget` (non-locking variant) is not built; nothing calls it.
- Added: `ConsultationQueriesService.renderOwn` renders the actor's own write responses (zone default per role, unhydrated participants).
