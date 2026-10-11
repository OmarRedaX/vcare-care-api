---
title: consultations — Tasks
owner: care-team
service: care-service
module: consultations
status: in-progress
last_verified: 2026-10-12
tags: [tasks, consultations]
related: [consultations-spec, consultations-brainstorm]
---

# consultations — Tasks

Source: [spec.md](./spec.md) (ready, owner-approved 2026-10-11). Issue #38, branch `feature/consultations`.

## Legend
- [ ] todo · [~] in progress · [x] done

## Tasks
- [~] (contract) C1-C9 description edits in `contracts/openapi.yaml` (no shape change)
- [ ] (generic) no-store prefix fix: `NO_STORE_PREFIXES` in `src/routes.ts`, loop in `src/app.ts` before `express.json`, drop per-router `noStore()` in patients/admin-doctors/audit, four malformed-JSON integration tests — **own commit**
- [ ] (generic) `exclusionViolationConstraint`, `byUserOfRoles`, `ToCommaList`, `currentRequestIdOrNew`, `Clock` type + token, `cancelReason` redaction key (+ unit tests)
- [ ] (migration) `20261011130000_create_consultations` — table, named constraints, exclusion, commented indexes, grants
- [ ] (migration) `20261011130100_create_notification_outbox` — insert-side only, grants `SELECT, INSERT`
- [ ] (pure) `pkg/slots/slot-fit.ts` (`isSlotOnGrid`, `isCoveredByOpenIntervals`) + `toIsoInZone` (+ unit tests)
- [ ] (env) `BOOKING_HORIZON_DAYS`, `CANCELLATION_POLICY_MINUTES` in `lib/config/env.ts` + `types.ts`
- [ ] (enums-errors-types) `constants.ts`, `enums.ts`, `errors.ts`, `types.ts` for `consultations` and `notifications`
- [ ] (entity) `Consultation`
- [ ] (request-dto) `ConsultationCreateDto`, `RescheduleDto`, `CancelDto`, `ListConsultationsQueryDto`, `GetConsultationQueryDto`
- [ ] (response-dto) `ConsultationResponseDto` (viewer-aware; no `complaintText` for admin or list items)
- [ ] (repository) `consultations.repo.ts`, `notification-outbox.repo.ts`
- [ ] (service) cross-module accessors (`DoctorsService` booking target/timezone, `SchedulesService` bookable type/open days, `PatientsService.getForViewer`)
- [ ] (service) `NotificationsService`, `ConsultationsService`, `ConsultationQueriesService`, providers, listener, DI tokens + `bootstrap.ts` rebinding
- [ ] (policies) `consultations/policies.ts` + `patients` `getById` policy
- [ ] (controller) `ConsultationsController`, `PatientsController.getById`
- [ ] (routes) `consultations/routes.ts`, `GET /patients/:patientUserId` after `/patients/me`
- [ ] (mount) `src/routes.ts`
- [ ] (tests) unit tests alongside code (pure `slot-fit`, helpers); full suite is `/write-tests`
- [ ] (manual-qa) <- /manual-qa
- [ ] (docs) service-card / INDEX; as-built refresh list is `/update-docs`

## Notes
- Out of this slice (spec 10): sessions, records, discovery cache, outbox delivery/reminder scan.
