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
- [x] (tests) ← /write-tests (unit + integration + RBAC + contract + concurrency + lock + privacy + EXPLAIN + schema; see "Test notes")
- [x] (manual-qa) ← /manual-qa (`scripts/curl-test-records.sh`): 328 pass / 0 fail, 2026-10-18, see `docs/records/manual-qa.md`
- [ ] (docs) ← /update-docs (service-card, INDEX, architecture shards listed in spec section 11)

## As-built notes (deviations from the spec, found while implementing)
- **Migration regex needs an escaped question mark.** `knex.raw` reads a bare `?` as a binding placeholder, so the diagnosis-code `CHECK` as written in spec 2.1/2.2 became `...{1,4})$1$` and rejected `A00.1`. Both migrations write the quantifier as a double-backslash question mark in the template literal (the constraint stored in Postgres is exactly `^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$`). The spec SQL itself is unchanged.
- **`records/rules.ts` added** (not in the spec file list): the pure `providedFields` and `diffRecord` helpers (pre-lock no-op diff, audit field names). `RecordParties` is a fourth shared type in `types.ts` for the two write resolvers.
- **Repository names:** `findLiveIdByConsultationId` (returns the id) instead of the spec `findLiveByConsultationId`; `listByRecordIdsQuery` and `listTimelineQuery` are exported for the EXPLAIN tests.
- **`MedicalRecordResponseDto`** also rejects a patient viewer who is not the record patient (same guard as `PatientProfileResponseDto`), in addition to the admin rejection the spec requires.
- **`NO_RECORDS`** (the default `recordedIds` of `buildConsultationView`) is exported from `consultations/view.ts` so callers that never carry a record (write responses, waiting room) share one constant.
- **Existing tests changed because behaviour changed (no new suites):** `tests/unit/app/consultations/consultations.service.test.ts` (the `FollowUpNotSupported` test became three follow-up tests; a `records` double is a new constructor argument), `consultation-queries.service.test.ts` and `session-queries.service.test.ts` (new `RecordLinksService` constructor argument), `tests/integration/consultations.test.ts` (`followUpOfRecordId` is now `404`, not `400`), `tests/integration/migrations.test.ts` (the records migrations are stepped down and up around `consultations`; `fk_consultations_follow_up_of_record_id` is in the expected constraint list), `tests/unit/lib/logger/redact.test.ts` (four keys), `tests/unit/lib/knex/pg-errors.test.ts` (`checkViolationConstraint`), `tests/integration/no-store.test.ts` (`/api/records` row).
- **Environment note for the next phases:** the suite runs against Postgres 18 in this workspace; `migrations.test.ts` "named constraints" compares `pg_constraint` names, and PG 18 lists `*_not_null` constraints there, so that one test fails on PG 18 independent of this unit (docker-compose uses an older image). `db-roles.test.ts` password-rejection cases need a password-authenticating server.


## Test notes (/write-tests, 2026-10-18)
- **Unit** (`tests/unit/app/records/`): `rules`, `records.dto`, `records.response.dto`, `records.service`, `record-queries.service`, `records.policies` (incl. router composition and `assertRoutesAuthorized`), `record-links.service`, `records.repo` (SQL shape), `records.controller`, `records.rate-limits`, `records.logging` (redaction, no-store prefix); `tests/unit/app/consultations/consultation-has-record.test.ts` (view, DTO, list/get/calendar batch wiring); extra follow-up ordering/replay tests in `consultations.service.test.ts`; `tests/unit/contract/records-contract.test.ts`. Fixtures: `tests/unit/app/records/records.fixtures.ts`.
- **Integration** (real Postgres + Redis; Identity/video faked only through the shared harness): `records` (creation gate, concurrency, atomicity, no Idempotency-Key, no Identity), `records-rules` (PATCH, lock boundary, trigger-only path, GET, timeline, rate limits, audit), `records-rbac` (matrix), `records-links` (hasRecord, follow-up), `records-privacy`, `records-explain` (plans + budgets), `records-contract`, `records-schema`; grant rows added to `db-roles.test.ts`; helpers in `tests/helpers/records-fixtures.ts`.
- **Test-only change outside records:** `migrations.test.ts` constraint-name query now excludes `contype = 'n'` (PostgreSQL 18 lists NOT NULL constraints in `pg_constraint`); the expected lists are unchanged, so the assertion is not weakened and the PG 18 failure is gone.
- **Findings (no src change made):**
  - Contract text vs implemented check order: `createMedicalRecord`/`updateMedicalRecord` descriptions read "body -> 400" before "consultation/record missing or unrelated -> 404", but the resolver (spec 3.6 steps 2 and 4) answers `404` before the body is validated. Tests assert the spec 3.6 order; owner to align the contract sentence (or the order).
  - Spec 2.5 says deleting a referenced record raises `23503`; with `ON DELETE RESTRICT` PostgreSQL raises `23001` (restrict_violation). Tests accept either and assert the constraint name `fk_consultations_follow_up_of_record_id`. Spec wording to refresh at `/update-docs`.
- **Environment:** run against an isolated native PostgreSQL 18 cluster (:5499, trust auth) and Redis db 14. `db-roles.test.ts` password-rejection cases fail on a trust-auth server and `storage-adapter.test.ts` needs MinIO: both pre-existing and unrelated to records.
