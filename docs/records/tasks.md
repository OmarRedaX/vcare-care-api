---
title: records — Tasks
owner: care-team
service: care-service
module: records
status: in-progress
last_verified: 2026-10-18
tags: [tasks, records, clinical, medical-records]
related: [records-spec, records-brainstorm, sessions-tasks]
---

# records — Tasks

Source: [spec.md](./spec.md) (v0.1.0, ready). Branch `feature/records`. Contract edits R1-R10 and the CLAUDE.md `RecordLocked` row landed in commit `cc2dac1`. Attachments are the next module (`record-attachments`): here `attachments` is always `[]`.

## Legend
- [ ] todo · [~] in progress · [x] done

## Tasks
- [x] (contract) R1-R10 in `contracts/openapi.yaml` + CLAUDE.md `RecordLocked` row (already applied in `cc2dac1`; verified, no further change)
- [x] (generic) `lib/knex/pg-errors.ts` `checkViolationConstraint`; `lib/logger/redact.ts` + `chiefComplaint`, `followUpInDays`, `amendments`, `amendmentReason`; `NO_STORE_PREFIXES` + `/api/records`
- [x] (migration) `20261017120000_create_medical_records` (table, lock CHECK, partial unique index, timeline index, `forbid_update_after_lock` trigger, grants)
- [x] (migration) `20261017120100_create_medical_record_amendments` (CHECKs, index, column-level INSERT grant)
- [x] (migration) `20261017120200_add_consultations_follow_up_fk` (`fk_consultations_follow_up_of_record_id`)
- [x] (enums-errors-types) `records` `constants.ts` / `enums.ts` / `errors.ts` / `types.ts`; consultations `ConsultationParties`, `NewConsultation.followUpOfRecordId`, `ConsultationView.hasRecord`
- [x] (entity) `MedicalRecord`, `MedicalRecordAmendment`
- [x] (request-dto) `MedicalRecordCreateDto`, `MedicalRecordPatchDto`, `TimelineQueryDto`
- [x] (response-dto) `MedicalRecordResponseDto`, `MedicalRecordAmendmentResponseDto`, `PatientTimelineResponseDto` (viewer-aware, admin throws)
- [x] (repository) `medical-records.repo.ts`, `medical-record-amendments.repo.ts`; `consultations.repo.ts` `findParties` + follow-up column on insert; `ConsultationRowsService.findParties`; `PatientsService.findProfile`
- [x] (service) `RecordLinksService`, `RecordsService`, `RecordQueriesService`; DI tokens + `bootstrap.ts` (links first); `hasRecord` in `ConsultationQueriesService` / `SessionQueriesService`; follow-up check in `ConsultationsService.book` (`FollowUpNotSupported` removed)
- [x] (policies) `records/policies.ts` + resolvers `record_write_consultation`, `record_write_record`, `record_reader`, `records_timeline_reader`
- [x] (controller) `RecordsController`
- [x] (routes) `records/rate-limits.ts`, `records/routes.ts`
- [x] (mount) `src/routes.ts` — after the consultations router
- [ ] (tests) ← /write-tests
- [ ] (manual-qa) ← /manual-qa
- [ ] (docs) ← /update-docs (service-card, INDEX, architecture shards listed in spec section 11)

## As-built notes (deviations from the spec, found while implementing)
- **Migration regex needs an escaped question mark.** `knex.raw` reads a bare `?` as a binding placeholder, so the diagnosis-code `CHECK` as written in spec 2.1/2.2 became `...{1,4})$1$` and rejected `A00.1`. Both migrations write the quantifier as a double-backslash question mark in the template literal (the constraint stored in Postgres is exactly `^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$`). The spec SQL itself is unchanged.
- **`records/rules.ts` added** (not in the spec file list): the pure `providedFields` and `diffRecord` helpers (pre-lock no-op diff, audit field names). `RecordParties` is a fourth shared type in `types.ts` for the two write resolvers.
- **Repository names:** `findLiveIdByConsultationId` (returns the id) instead of the spec `findLiveByConsultationId`; `listByRecordIdsQuery` and `listTimelineQuery` are exported for the EXPLAIN tests.
- **`MedicalRecordResponseDto`** also rejects a patient viewer who is not the record patient (same guard as `PatientProfileResponseDto`), in addition to the admin rejection the spec requires.
- **`NO_RECORDS`** (the default `recordedIds` of `buildConsultationView`) is exported from `consultations/view.ts` so callers that never carry a record (write responses, waiting room) share one constant.
- **Existing tests changed because behaviour changed (no new suites):** `tests/unit/app/consultations/consultations.service.test.ts` (the `FollowUpNotSupported` test became three follow-up tests; a `records` double is a new constructor argument), `consultation-queries.service.test.ts` and `session-queries.service.test.ts` (new `RecordLinksService` constructor argument), `tests/integration/consultations.test.ts` (`followUpOfRecordId` is now `404`, not `400`), `tests/integration/migrations.test.ts` (the records migrations are stepped down and up around `consultations`; `fk_consultations_follow_up_of_record_id` is in the expected constraint list), `tests/unit/lib/logger/redact.test.ts` (four keys), `tests/unit/lib/knex/pg-errors.test.ts` (`checkViolationConstraint`), `tests/integration/no-store.test.ts` (`/api/records` row).
- **Environment note for the next phases:** the suite runs against Postgres 18 in this workspace; `migrations.test.ts` "named constraints" compares `pg_constraint` names, and PG 18 lists `*_not_null` constraints there, so that one test fails on PG 18 independent of this unit (docker-compose uses an older image). `db-roles.test.ts` password-rejection cases need a password-authenticating server.

