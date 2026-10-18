---
title: records — Spec
owner: care-team
service: care-service
module: records
status: implemented
version: 0.2.0
diataxis: reference
last_verified: 2026-10-18
tags: [spec, records, clinical, medical-records, amendments, lock-trigger, timeline, follow-up, has-record, audit, clinical-privacy]
related: [records-brainstorm, sessions-spec, consultations-spec, patients-spec, clinical-records, data-model, consultation-lifecycle, rbac, file-handling, adr-0013-verified-direct-upload-lifecycle, adr-0017-generic-helpers-and-transaction-scoping, adr-0018-db-role-split-explicit-grants-partition-function]
contracts: [contracts/openapi.yaml]
---

# records — Spec

The clinical record of a **completed** consultation: **create** (assigned doctor), **read** (patient, author, consulted doctors), **update in place for
24 hours then amend** (`PATCH`), and the **patient timeline**. The unit also makes `Consultation.hasRecord` true and lets a patient book a follow-up that
carries `followUpOfRecordId` (lifts consultations C6 and C9). Scope follows [brainstorm.md](./brainstorm.md) (decisions R-D1..R-D10, binding, folded in
section 1.5). **Attachments are the next module (`record-attachments`)**: here `attachments` is always `[]` and the `RecordAttachment` schema and the
attachment operations are not touched.

> **Status (2026-10-18, v0.2.0): implemented.** The four routes, three migrations and the `consultations` / `sessions` / `patients` additions are built, tested
> and manually QA'd (359 CURL checks pass, 0 fail); the code review is closed clean. Contract edits R1-R10 and M11-M16 are **applied** in
> `contracts/openapi.yaml`. Sections 1.6 (owner decisions of the fix-review) and 13 (**As-built notes**) amend the design text below where they differ;
> read them first.

Binding rules: CLAUDE.md → "Database rules" (soft delete, clinical tables, medical records, `audit_logs`), "API conventions", "Authentication and
service-to-service auth", "Authorization — RBAC and ownership", "Security rules", "Privacy and logging", "Domain rules" 13-16, 18, 19, 22, "Testing
policy", "Performance rules". Precedents: [sessions/spec.md](../sessions/spec.md) (read it first; this spec reuses its names and test layout),
[consultations/spec.md](../consultations/spec.md), [patients/spec.md](../patients/spec.md); design background:
[architecture/clinical-records.md](../architecture/clinical-records.md), [architecture/data-model.md](../architecture/data-model.md).

---

## 1. Overview

### 1.1 What `records` owns
| Area | Delivers |
|---|---|
| Tables | `medical_records`, `medical_record_amendments` (two migrations) plus the deferred FK `fk_consultations_follow_up_of_record_id` (third migration, no new table) |
| DB objects | function `forbid_update_after_lock()` and trigger `trg_medical_records_forbid_update_after_lock` |
| Routes | `POST /api/consultations/{id}/record` · `GET /api/records/{id}` · `PATCH /api/records/{id}` · `GET /api/patients/{patientUserId}/records` |
| Module | `src/app/records/` (router mounted after the consultations router, section 3.2) |
| Cross-module service API added | `consultations`: `ConsultationRowsService.findParties`; `patients`: `PatientsService.findProfile` (read, no audit). `records`: `RecordLinksService` (`recordedConsultationIds`, `isFollowUpTarget`, `findAccessRow`) consumed by `consultations` and `sessions` |
| Behaviour lifted elsewhere | consultations C6 (`followUpOfRecordId` accepted, ownership checked, link stored) and C9 (`hasRecord` truthful on get-one, list and calendar) |
| Lib additions | `lib/knex/pg-errors.ts` `checkViolationConstraint`; `lib/logger/redact.ts` four keys (section 7) |
| Env | none |

### 1.2 Principles
- **The database decides the lock, the unique index decides the race.** `locked_at` is set from database time with a `CHECK`; one `BEFORE UPDATE` trigger refuses any later update; the partial unique index is the one-live-record guarantee. Every service check is a courtesy that gives the precise error ([clinical-records.md](../architecture/clinical-records.md)).
- **One clock for the lock.** The service and the trigger both use the transaction's database time (`NOW()`, fixed at transaction start); Node's clock never decides a lock (R-D8).
- **Nothing is overwritten after 24 hours.** An amendment is an explicit, reasoned, append-only act; the original row is byte-for-byte unchanged and no grant allows otherwise.
- **Clinical text exists only in the clinical tables and the one response that carries it.** Never in logs, audit metadata, Redis (no `Idempotency-Key` on any record route, R-D4), or error details.
- **Every access is audited.** Writes in the writing transaction; reads in the read's own transaction, written before the response is sent, and a failed audit insert fails the read with `500`.
- **Admins never touch a record.** Absent from the roles of all four routes (`403 Forbidden`); no DTO has an admin form.
- **Private resources are `404`.** A caller who may not read a record cannot learn its id exists (`404`), except the role-level `403` for admins and, on `PATCH /records/{id}` only, for a related doctor who is not the record's author (`NotAssignedDoctor`, contract-defined; owner decision M1, 1.6). `POST /consultations/{id}/record` answers `404` to every caller who is not the assigned doctor.

### 1.3 Dependencies
- **Other modules (services only):** `consultations` (`ConsultationRowsService.findParties`; `ConsultationsService` is the `PatientRelationshipChecker` bound at `TOKENS.PatientRelationship`), `doctors` (`DoctorsService.isLocallySuspended`), `patients` (`PatientsService.findProfile`, `PatientProfileResponseDto`), `audit` (`AuditRecorder`).
- **Reverse consumers:** `consultations` and `sessions` call `RecordLinksService` (`hasRecord` batch; follow-up target). `RecordLinksService` depends only on the database, so there is no constructor cycle (`RecordsService → ConsultationRowsService`, `ConsultationQueriesService → RecordLinksService`).
- **Other service:** none. No Identity call (record DTOs carry user ids, never names): no Case 1-4, no Case 2 hydration, no degrade path.
- **External:** none (no storage, video or email; the attachments module adds storage).

### 1.4 Contract drift check (against `contracts/openapi.yaml`, 2026-10-17; every numbered edit below is applied, see section 11)
Operations `createMedicalRecord`, `getMedicalRecord`, `updateMedicalRecord`, `listPatientRecords`, `bookConsultation`; schemas `MedicalRecord`, `MedicalRecordCreate`, `MedicalRecordPatch`, `MedicalRecordAmendment`, `PatientTimeline`, `PatientProfile`, `Consultation`, `ConsultationCreate`; responses `MedicalRecordOk`, `MedicalRecordCreated`, `RecordWriteForbidden`, `RecordCreateConflict`, `RecordLocked`. Roles, paths, status codes (except below), the field names and the amendment shape match. Numbered edits (each is a contract change in section 11):

| # | Finding | Contract today | This spec |
|---|---|---|---|
| R1 | `Idempotency-Key` on create (R-D4) | `createMedicalRecord` references `IdempotencyKeyOptional`, declares `422 IdempotencyConflict`, and `RecordCreateConflict` mentions the in-flight `409` with `Retry-After` | none of the three: no `Idempotency-Key` on any record route; a retried create is `409 Conflict`; drop the parameter, the `422` response and the in-flight sentence and `Retry-After` header of `RecordCreateConflict` |
| R2 | `403` versus `404` and the check order are unstated | `x-ownership: assigned-doctor`; `RecordWriteForbidden` lists `NotAssignedDoctor` or `Forbidden` | **create:** every doctor who is not the consultation's assigned doctor gets `404` (owner decision M1, 1.6; `NotAssignedDoctor` is never returned by create). **`PATCH /records/{id}`:** an unrelated doctor (no booked/waiting/in_progress/completed consultation with the patient) gets `404`; a doctor who has such a relationship but is not the author gets `403 NotAssignedDoctor`; wrong role, inactive or suspended doctor `403 Forbidden`. Create order in 3.6 |
| R3 | Text rules and the `PATCH` semantics are only prose | optional text fields have `maxLength` only; "`reason` is required for an amendment"; `minProperties: 1` also accepts a `reason`-only body | optional text fields `minLength: 1` and not blank, no NUL; `PATCH` needs at least one record field (a `reason`-only or `{}` body is `400`); `reason` is required after the lock (else `400`) and ignored before it; before the lock values equal to the stored ones are a no-op (`200`, no write, no audit); after the lock an amendment is always appended; a field cannot be cleared to null (R-D6, R-D7) |
| R4 | A trigger-detected lock has no response | `updateMedicalRecord` declares no `409`; `RecordLocked` says "attachments cannot be deleted after the 24 h lock" | add `'409'` `RecordLocked` to `updateMedicalRecord`; widen the `RecordLocked` response to "the record is locked (in-place edit refused) or an attachment cannot be deleted after the 24 h lock" (R-D8). CLAUDE.md → "Error codes owned by Care" row `RecordLocked` is widened the same way (owner edit) |
| R5 | `getMedicalRecord` promises attachment URLs and an attachment audit action | summary and `MedicalRecordOk` say "with amendments and signed attachment URLs"; `x-audit-actions: [record.read, attachment.url_issued]` | ADR 0014: read DTOs never embed URLs; `attachment.url_issued` belongs to the `record-attachments` `download-url` operation. Summary and description: "with amendments"; `x-audit-actions: [record.read]`; non-numeric `{id}` is `404`; add `'400'` `ValidationFailed` (any query member is rejected) |
| R6 | `listPatientRecords`: account state, `403`/`404` split, empty profile | no `x-account-state`; "ownership: consulted-patient-or-self"; `PatientTimeline.patient` is a required `PatientProfile` | add `x-account-state` ("status active; a locally suspended doctor receives 404") to this operation and to `getMedicalRecord`; description: admin `403`, a non-owner, a doctor without a relationship, a suspended doctor, `me` or any non-numeric id `404`; one `patient_records.listed` audit row per call; `data.patient` is **nullable** (`null` when the patient has no profile row yet, see 1.5.6) |
| R7 | `MedicalRecord.attachments` and `isLocked` | `attachments` of `RecordAttachment` (with `downloadUrl`) | the schema is left to `record-attachments`; add to the property description "always `[]` until the `record-attachments` module ships"; `isLocked` is computed with database time at read |
| R8 | `bookConsultation` rejects `followUpOfRecordId` (consultations C6) | description: "rejected with `400 ValidationFailed` until the records module ships" | accepted: a live record whose `patient_user_id` is the caller and whose `doctor_user_id` is the chosen doctor, else `404 NotFound` (R-D3); no timing or `followUpInDays` check; replace the description sentence and the `ConsultationCreate.followUpOfRecordId` description |
| R9 | `Consultation.hasRecord` (consultations C9) | "Always `false` until the records module ships" | true when a live record exists for the consultation; emitted for every viewer (a boolean, no content); only `completed` rows can be true |
| R10 | Rate limits | no `x-rate-limit` extension in the file; limits live in operation prose (e.g. `bookConsultation`) | add one prose line per operation: create and patch "20 record writes/min per user", get "120/min per user", timeline "60/min per user" (R-D9) |

### 1.5 Decisions folded in (brainstorm R-D1..R-D10 plus spec-level decisions; owner may override)
R-D1..R-D10 apply verbatim:
1. **R-D1** two modules; attachments next. 2. **R-D2** `diagnosisCode` format-checked only (`^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$`); no catalog. 3. **R-D3** follow-up link = ownership only. 4. **R-D4** no `Idempotency-Key` on any record route. 5. **R-D5** a locally suspended doctor is blocked from all record writes and from reading records or the timeline. 6. **R-D6** an amendment cannot clear a field to null (`chk_medical_record_amendments_nonempty` needs one non-null field). 7. **R-D7** pre-lock equal values are a no-op (`200`, no record write; amended by owner decision M3 of 2026-10-18, see 1.6: the no-op writes one `record.read` audit row); post-lock always appends an amendment. 8. **R-D8** the lock is decided under `FOR NO KEY UPDATE` with `locked_at <= NOW()`; a trigger `check_violation` maps to `409 RecordLocked`. 9. **R-D9** limits: record `POST`/`PATCH` 20/min, `GET /records/{id}` 120/min, timeline 60/min, per user. 10. **R-D10** `data.patient` repeats on every page with one `patient_records.listed` audit row per call.

Spec-level decisions (each follows from a source; none reopens a brainstorm decision):
1. **Resolver visibility versus `NotAssignedDoctor`.** *Superseded for create by owner decision M1 (1.6).* On `PATCH /records/{id}` the write resolver *allows* a doctor who is the author **or** holds a relationship with the record's patient, and the service answers `NotAssignedDoctor` for the latter; an unrelated doctor gets `404` (R2). A related doctor already sees every record id in that patient's timeline, so this reveals nothing new. On `POST /consultations/{id}/record` the same reasoning was **wrong**: the timeline lists only consultation ids that already have a record, so a 403 would have revealed the existence of record-less consultations (existence oracle, review M1); create therefore allows only the assigned doctor.
2. **R-D5 as `404` on reads.** The read resolvers fold local suspension into ownership (`deny-not-found`) instead of the `doctor_not_suspended` check (which answers `403`). This follows R-D5's wording ("404 on reads") and applies to **every** read by a suspended doctor, including records they authored; the patient and other consulted doctors still read those records. It deliberately differs from `GET /patients/{id}`, which keeps `403` (consultations C8). Writes use the check (`403 Forbidden`).
3. **Suspension is checked at the policy, not re-checked in the transaction**, exactly as `sessions` does for `complete`. A suspension committing between `authorize` and the write can let that one in-flight write through (milliseconds).
4. **`FOR NO KEY UPDATE`, not `FOR UPDATE`, on the record row.** A booking that inserts `follow_up_of_record_id` takes `FOR KEY SHARE` on the record through the FK; `FOR UPDATE` would make a `PATCH` and a follow-up booking block each other, `FOR NO KEY UPDATE` does not (keys never change).
5. **Create reads the consultation without a lock.** `completed` is terminal, so the status cannot change under the transaction; the partial unique index serializes concurrent creates (the loser gets `23505` → `409 Conflict`).
6. **`PatientTimeline.patient` nullable.** Booking needs no `patient_profiles` row (consultations 1.5.1), so a patient can have records and no profile. Returning `404` would hide their records from the doctor; inventing an empty profile would fabricate data. The timeline returns `patient: null` in that case (R6). With a profile it is `PatientProfileResponseDto` (R-D10).
7. **Existence of a record is not clinical content.** `hasRecord` is emitted to admins too (the same `completed` status is already visible to them); no record field ever reaches an admin.
8. **Pre-lock `reason` is accepted and ignored.** A client cannot know the exact lock instant, so rejecting a `reason` sent a moment before the lock would be hostile; `medical_records` has no column for it and the audit row keeps changed field names only.
9. **Optional text fields must not be blank and `NUL` is rejected** (R3). Newlines are allowed. `diagnosisCode` and `followUpInDays` are also checked by database `CHECK`s (2.1, 2.2): defence in depth; the DTO produces the `400`.
10. **A lost `201` is recoverable.** A retried create answers `409 Conflict` (R-D4); the doctor finds the record id in the patient timeline (they hold a `completed` relationship). No lookup-by-consultation route is added.
11. **Audit entity for the timeline.** `patient_records.listed` uses `entity_type = 'patient_records'` and `entity_id = patientUserId` (Identity user id): the timeline has no single row, and the profile row may not exist (6). It is filterable in `GET /audit-logs` by `entityType`/`entityId`.
12. **No new env variable, no `Idempotency-Key`, no Identity call.** The 24 h lock is the constant in the `CHECK` (`interval '24 hours'`); a configurable lock would need a migration.

### 1.6 Owner decisions of 2026-10-18 (fix-review of review-20261018-0432; they amend the text above and are folded into sections 2-9)
- **M1 - create is assigned-doctor-or-404.** The resolver `record_write_consultation` returns `allow` only when `consultation.doctorUserId === auth.userId`; every other caller (related or not, any consultation status, a cancelled or no-show row, another doctor's consultation, a record-less or recorded consultation) gets `404 NotFound` with the same body as an absent id. `NotAssignedDoctor` stays on `PATCH /records/{id}` (a related doctor who is not the author). The service re-reads the consultation inside the transaction and treats a mismatch as `NotFound` (defence in depth; unreachable while a consultation's doctor is immutable).
- **M3 - a pre-lock no-op `PATCH` is audited as a read.** It still returns `200` with the current record, still writes no record row (`updated_at` unchanged) and no `record.updated` row, but writes exactly **one `record.read` audit row in the same transaction** (metadata `consultationId, patientUserId, viewerRole, viaNoopPatch: true`; flat scalars, ids and flags only). Reason: the `200` body discloses the clinical text, and CLAUDE.md -> Privacy and logging requires every disclosure to be audited. This amends R-D7 ("no audit"); the brainstorm table is a past record and is not rewritten.
- **M5 - least-privilege `UPDATE` on `medical_records`.** The app role holds `SELECT, INSERT` plus a column-level `UPDATE (chief_complaint, examination_notes, diagnosis_text, diagnosis_code, treatment_plan, follow_up_in_days, updated_at)`; it cannot touch `consultation_id`, `patient_user_id`, `doctor_user_id`, `locked_at`, `created_at` or `deleted_at`. The migrations exist only on the unmerged `feature/records` branch, so migration 2.1 was edited in place.
- **M7 - amendments are read in append order.** `ORDER BY id` (ids are assigned after the row lock), index `idx_medical_record_amendments_medical_record_id_id (medical_record_id, id)` (migration 2.2 edited in place for the same reason).
- **M11-M16 - contract-only fixes** (no behaviour change): `ConsultationCreate.followUpOfRecordId` description (no `followUpInDays` check) and `minimum: 1` (M11, M14); `Consultation.required` lists every always-emitted member including `hasRecord` (M13); `Cache-Control: no-store` on the `RecordWriteForbidden`, `RecordCreateConflict` and `RecordLocked` responses (M12); `listPatientRecords` states the audit `entityType: patient_records` / `entityId` = patient Identity user id (M15); `reason` on `PATCH` is validated (3..1000, not blank) whenever present, required after the lock, otherwise ignored for the update (M16).
- **M9 - a booking replay through the database idempotency path reports a truthful `hasRecord`** (`ConsultationQueriesService.renderOwn` issues one lookup for its row only when it is `completed`).

---

## 2. Database schema

Three migrations (`npm run migrate:make`), raw SQL, owner role (`MIGRATION_DATABASE_URL`), explicit grants (ADR 0018). All sort after `20261015120100_notification_outbox_delete_sent_only`. DDL follows [data-model.md](../architecture/data-model.md) with the **documented deviations** marked below (the `/update-docs` step refreshes data-model.md).

### 2.1 `20261017120000_create_medical_records`
```sql
CREATE TABLE medical_records (
    id                  BIGSERIAL PRIMARY KEY,
    consultation_id     BIGINT NOT NULL,
    patient_user_id     BIGINT NOT NULL,
    doctor_user_id      BIGINT NOT NULL,
    chief_complaint     TEXT NOT NULL,
    examination_notes   TEXT,
    diagnosis_text      TEXT,
    diagnosis_code      VARCHAR(16),
    treatment_plan      TEXT,
    follow_up_in_days   INT,
    locked_at           TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ,
    CONSTRAINT fk_medical_records_consultation_id FOREIGN KEY (consultation_id) REFERENCES consultations(id) ON DELETE RESTRICT,
    CONSTRAINT chk_medical_records_lock CHECK (locked_at = created_at + interval '24 hours'),
    CONSTRAINT chk_medical_records_follow_up CHECK (follow_up_in_days IS NULL OR follow_up_in_days BETWEEN 1 AND 365),
    CONSTRAINT chk_medical_records_diagnosis_code CHECK (diagnosis_code IS NULL OR diagnosis_code ~ '^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$')
);

-- Domain rule 13: one live record per consultation. Serves (1) the create gate duplicate check
--   SELECT id FROM medical_records WHERE consultation_id = $1 AND deleted_at IS NULL
-- (2) the hasRecord batch  SELECT consultation_id FROM medical_records WHERE consultation_id = ANY($1) AND deleted_at IS NULL
-- (3) the concurrent-create guarantee (23505 -> 409 Conflict); also the index of fk_medical_records_consultation_id.
CREATE UNIQUE INDEX uq_medical_records_consultation_id ON medical_records (consultation_id) WHERE deleted_at IS NULL;

-- Patient timeline GET /api/patients/{patientUserId}/records, keyset newest first:
--   WHERE patient_user_id = $1 AND deleted_at IS NULL [AND (created_at, id) < ($t, $id)] ORDER BY created_at DESC, id DESC LIMIT $n + 1
CREATE INDEX idx_medical_records_patient_user_id_created_at_id ON medical_records (patient_user_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION forbid_update_after_lock() RETURNS trigger AS $$
BEGIN
    IF OLD.locked_at <= NOW() THEN
        RAISE EXCEPTION 'record % is locked', OLD.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_medical_records_forbid_update_after_lock';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_medical_records_forbid_update_after_lock
    BEFORE UPDATE ON medical_records FOR EACH ROW EXECUTE FUNCTION forbid_update_after_lock();

GRANT SELECT, INSERT ON medical_records TO vcare_app;
GRANT UPDATE (chief_complaint, examination_notes, diagnosis_text, diagnosis_code, treatment_plan, follow_up_in_days, updated_at) ON medical_records TO vcare_app;
GRANT USAGE ON SEQUENCE medical_records_id_seq TO vcare_app;
```
- **Deviations from data-model.md:** (a) `chk_medical_records_diagnosis_code` is new (R-D2 format as a `CHECK`); (b) the trigger raises with `CONSTRAINT = 'trg_medical_records_forbid_update_after_lock'` so the service recognizes it by `error.constraint` (`checkViolationConstraint`) instead of parsing a message; ERRCODE and message are unchanged.
- **Regex quantifier in the migration file.** `knex.raw` reads a bare `?` as a binding placeholder, so both migrations write the diagnosis-code quantifier escaped (`\\?` inside the template literal); the constraint stored in Postgres is exactly `^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$`. The SQL shown in 2.1 and 2.2 is the stored form.
- **No defaults on critical columns:** `locked_at` has none. The create statement sets `locked_at = NOW() + interval '24 hours'` in SQL and lets `created_at` take its `DEFAULT NOW()`; `NOW()` is the transaction start time, so both come from the same instant and `chk_medical_records_lock` holds exactly. Neither value ever comes from the client or the Node clock.
- **The trigger blocks every `UPDATE` once `OLD.locked_at <= NOW()`, including a soft delete.** There is no route that sets `deleted_at`; a future erasure feature must go through an owner-run procedure (the app role cannot defeat the trigger and holds no `DELETE`).
- **Grants (M5):** `SELECT, INSERT`, a **column-level** `UPDATE` on the six clinical columns and `updated_at` only (`id`, `consultation_id`, `patient_user_id`, `doctor_user_id`, `locked_at`, `created_at`, `deleted_at` are not updatable by the app role), and sequence `USAGE`; no `DELETE`, no `TRUNCATE`, no `ALTER DEFAULT PRIVILEGES`. Clinical tables have no `ON DELETE CASCADE`.
- Comments (`COMMENT ON`): table "Clinical record of one completed consultation; soft delete only; locked 24 h after creation"; `patient_user_id`/`doctor_user_id` "Identity user id (copied from the consultation)"; `chief_complaint`, `examination_notes`, `diagnosis_text`, `diagnosis_code`, `treatment_plan` "Clinical; never logged"; `locked_at` "created_at + 24 h, set from database time".
- `down`: `DROP TABLE IF EXISTS medical_records;` then `DROP FUNCTION IF EXISTS forbid_update_after_lock();` (the amendments and FK migrations roll back first).

### 2.2 `20261017120100_create_medical_record_amendments`
```sql
CREATE TABLE medical_record_amendments (
    id                  BIGSERIAL PRIMARY KEY,
    medical_record_id   BIGINT NOT NULL,
    author_user_id      BIGINT NOT NULL,
    chief_complaint     TEXT,
    examination_notes   TEXT,
    diagnosis_text      TEXT,
    diagnosis_code      VARCHAR(16),
    treatment_plan      TEXT,
    follow_up_in_days   INT,
    reason              TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_medical_record_amendments_medical_record_id FOREIGN KEY (medical_record_id) REFERENCES medical_records(id) ON DELETE RESTRICT,
    CONSTRAINT chk_medical_record_amendments_nonempty CHECK (
        chief_complaint IS NOT NULL OR examination_notes IS NOT NULL OR diagnosis_text IS NOT NULL
     OR diagnosis_code IS NOT NULL OR treatment_plan IS NOT NULL OR follow_up_in_days IS NOT NULL),
    CONSTRAINT chk_medical_record_amendments_follow_up CHECK (follow_up_in_days IS NULL OR follow_up_in_days BETWEEN 1 AND 365),
    CONSTRAINT chk_medical_record_amendments_diagnosis_code CHECK (diagnosis_code IS NULL OR diagnosis_code ~ '^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$')
);

-- Record view and timeline load the amendments of a whole page in ONE query:
--   WHERE medical_record_id = ANY($1) ORDER BY id   (id order is append order: ids are assigned after the record row lock, M7; also the index of fk_medical_record_amendments_medical_record_id)
CREATE INDEX idx_medical_record_amendments_medical_record_id_id ON medical_record_amendments (medical_record_id, id);

-- Append-only by grant (ADR 0018): SELECT and a column-level INSERT only. The app can never set id or created_at, and holds no UPDATE, DELETE or TRUNCATE.
GRANT SELECT ON medical_record_amendments TO vcare_app;
GRANT INSERT (medical_record_id, author_user_id, chief_complaint, examination_notes, diagnosis_text, diagnosis_code, treatment_plan, follow_up_in_days, reason)
    ON medical_record_amendments TO vcare_app;
GRANT USAGE ON SEQUENCE medical_record_amendments_id_seq TO vcare_app;
```
- **Deviations from data-model.md:** (a) the `REVOKE UPDATE, DELETE ... FROM vcare_app` line is replaced by the positive grants above (nothing is granted, so nothing needs revoking; same effect, per ADR 0018); (b) two new `CHECK`s close the range gap on `follow_up_in_days` and mirror the diagnosis-code format. `reason` is `NOT NULL` and deliberately outside the non-empty `CHECK`.
- The non-empty `CHECK` is why a field cannot be cleared by an amendment (R-D6, RC-R10): the limitation is accepted for MVP; the original is never erased, and wanting to remove a value is a correction written as new text.
- Comments: `author_user_id` "Identity user id"; text columns and `reason` "Clinical; never logged".
- `down`: `DROP TABLE IF EXISTS medical_record_amendments;`.

### 2.3 `20261017120200_add_consultations_follow_up_fk`
```sql
ALTER TABLE consultations ADD CONSTRAINT fk_consultations_follow_up_of_record_id
    FOREIGN KEY (follow_up_of_record_id) REFERENCES medical_records(id) ON DELETE RESTRICT;
```
- The covering index `idx_consultations_follow_up_of_record_id (follow_up_of_record_id) WHERE follow_up_of_record_id IS NOT NULL` already exists (consultations migration); this migration only adds the constraint. No row can violate it: the column was unwritable until this unit (consultations C6).
- `down`: `ALTER TABLE consultations DROP CONSTRAINT IF EXISTS fk_consultations_follow_up_of_record_id;` (runs first on rollback). The migration runs `SET LOCAL lock_timeout = '5s'` before the `ALTER` (it takes a `SHARE ROW EXCLUSIVE` lock on `consultations`).

### 2.4 Indexes used (no other new index)
| Index | Serves |
|---|---|
| PK `medical_records_pkey` | `GET /records/{id}` (`findById`), the `FOR NO KEY UPDATE` read of `PATCH`, the resolver access row, the follow-up target check `WHERE id = $1 AND patient_user_id = $2 AND doctor_user_id = $3 AND deleted_at IS NULL` |
| `uq_medical_records_consultation_id` | create-gate duplicate check; `hasRecord` batch; concurrent-create guard |
| `idx_medical_records_patient_user_id_created_at_id` | timeline page (both first page and keyset continuation) |
| `idx_medical_record_amendments_medical_record_id_id` | amendments of a page or of one record (`ORDER BY id`) |
| `consultations_pkey` | `findParties` (resolver, create gate) |
| `idx_consultations_doctor_user_id_patient_user_id` (existing) | the relationship `EXISTS` of the read and write resolvers |
| `idx_consultations_follow_up_of_record_id` (existing) | FK index of `fk_consultations_follow_up_of_record_id` |

### 2.5 Migration tests
`tests/integration/migrations.test.ts` (additions): round-trip all three (`down` then `up`; named constraints and indexes exist); `chk_medical_records_lock` rejects a `locked_at` that is not `created_at + 24 h`; the trigger rejects an `UPDATE` when `locked_at <= NOW()` and allows it before; the equality case is proven in **one transaction** (insert with `created_at = NOW() - interval '24 hours'`, `locked_at = NOW()`, then `UPDATE` → `check_violation` with `constraint = 'trg_medical_records_forbid_update_after_lock'`); soft delete after the lock is refused; the amendment `CHECK`s (empty amendment, `follow_up_in_days = 0` and `366`, bad code) reject; grants asserted with `has_table_privilege` / `has_column_privilege` for `care_app` (`medical_records`: select/insert yes, table-level update no, column `UPDATE` yes for exactly the six clinical columns and `updated_at` and no for `id`, `consultation_id`, `patient_user_id`, `doctor_user_id`, `locked_at`, `created_at`, `deleted_at`, delete/truncate no; `medical_record_amendments`: select yes, insert on the nine columns yes, insert on `id`/`created_at` no, update/delete/truncate no); `fk_consultations_follow_up_of_record_id` rejects a dangling id on insert with `23503` (`foreign_key_violation`) and a `DELETE` of a referenced record (owner role) with `23001` (`restrict_violation`: with `ON DELETE RESTRICT` PostgreSQL raises `restrict_violation`, not `foreign_key_violation`); the test asserts the constraint name in both cases. `tests/integration/db-roles.test.ts` gets the same grant rows.

### 2.6 Migration notes (edited in place before merge)
- The two table migrations were **edited in place on the unmerged `feature/records` branch** by the fix-review: `20261017120000_create_medical_records` gained the column-level `UPDATE (...)` grant (M5, replacing a table-level `UPDATE`) and `20261017120100_create_medical_record_amendments` renamed its index to `idx_medical_record_amendments_medical_record_id_id (medical_record_id, id)` (M7, replacing a `(medical_record_id, created_at, id)` index). Nothing was merged to `main` before the edit.
- **Dev and test databases that already ran the earlier versions keep the old grant and index** (knex records the migration name, not its content). Roll back and re-run: `npm run migrate:rollback` (it rolls back the last **batch**; repeat while `npm run migrate:status` still lists `20261017120000_create_medical_records` as applied; the three records migrations roll back in reverse order: FK, amendments, records), then `npm run migrate`, then `npm run migrate:ensure-app-login` as usual. If the rolled-back batch also holds migrations of other branches, they are re-applied by `migrate`. Verify with `\dp medical_records` (column privileges for `care_app`) and `\d medical_record_amendments` (index name). A fresh database needs nothing.

---

## 3. API contract and file-level design

### 3.1 Endpoints (the contract wins on disagreement; edits R1-R10 first)
Common: `userGuard()` → `authorize(policy)` → limiter → controller. **No `Idempotency-Key`** on any of the four (R1). `Cache-Control: no-store` on every response: `/api/consultations` and `/api/patients` are already in `NO_STORE_PREFIXES`; **`/api/records` is added** (section 3.10). Non-numeric `{id}` / `{patientUserId}` → `404 NotFound` (resolver `deny-not-found`). Identity headers are ignored. Account state for all four: `status=active` (default); patients additionally need nothing else (no `emailVerified`).

| | `POST /consultations/{id}/record` | `PATCH /records/{id}` |
|---|---|---|
| Guard | user | user |
| Roles | doctor | doctor |
| Ownership | resolver `record_write_consultation` (3.8): consultation exists and the caller is its assigned doctor; every other caller `404` (M1). The service re-checks inside the transaction (a mismatch is `404`) | resolver `record_write_record`: record exists and the doctor is its author **or** holds a relationship with its patient; else `404`. Service: author only (`403 NotAssignedDoctor`) |
| Account state | `status=active` + `doctor_not_suspended` check (`403 Forbidden`) | same |
| Audit | `record.created` (policy class `clinical-write`), same transaction | `record.updated` (in place) or `record.amended` (after the lock), same transaction; a pre-lock no-op writes one `record.read` row (M3) and nothing else |
| Rate limit | `records-write-user` 20/min per user | same bucket (shared) |
| Body | `MedicalRecordCreate` | `MedicalRecordPatch` |
| Success | `201` `MedicalRecord` | `200` `MedicalRecord` (in place, or unchanged no-op) **or** `201` `MedicalRecordAmendment` (after the lock) |
| Errors | 400 `ValidationFailed`, 401, 403 (`Forbidden` only), 404, 409 (`RecordRequiresCompleted`, `Conflict`), 429, 500 | 400 (including `reason` missing after the lock and no record field), 401, 403 (`Forbidden`, `NotAssignedDoctor`), 404, 409 `RecordLocked` (R4), 429, 500 |

| | `GET /records/{id}` | `GET /patients/{patientUserId}/records` |
|---|---|---|
| Guard | user | user |
| Roles | patient, doctor (**admin `403`**) | patient, doctor (**admin `403`**) |
| Ownership | resolver `record_reader`: patient owns the record; doctor not locally suspended **and** (author **or** relationship with the record's patient); else `404` | resolver `records_timeline_reader`: patient `:patientUserId = auth.userId`; doctor not locally suspended **and** holds a relationship with that patient; else `404` |
| Account state | `status=active`; a locally suspended doctor receives `404` through the resolver (R-D5, decision 1.5.2) | same |
| Audit | `record.read` (policy class `clinical-read`), before the response, in the read transaction | `patient_records.listed`, same rule; one row per call |
| Rate limit | `records-read-user` 120/min per user | `records-timeline-user` 60/min per user |
| Query | none (unknown members rejected) | `cursor`, `limit` (1..100, default 20); unknown members rejected |
| Success | `200` `MedicalRecord` | `200` `PatientTimeline` + `meta { nextCursor, hasMore, count }` |
| Errors | 400 (any query member), 401, 403, 404, 429, 500 | 400 (cursor, limit, unknown member), 401, 403, 404, 429, 500 |

**Request rules (class-validator, `forbidNonWhitelisted`, implicit conversion off):**
- `MedicalRecordCreateDto`: `chiefComplaint` required `@IsString @NotBlank @CodePointLength(3, 2000) @NoControlCharacters("nul")`; `examinationNotes` optional (`@ValidateIf` not undefined) `@IsString @NotBlank @CodePointLength(1, 10000) @NoControlCharacters("nul")`; `diagnosisText` same with `(1, 2000)`; `treatmentPlan` same with `(1, 10000)`; `diagnosisCode` optional `@IsString @Matches(/^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/)` (so at most 8 characters, inside `VARCHAR(16)`); `followUpInDays` optional `@IsInt @Min(1) @Max(365)`. Unknown properties → `400`. JSON `null` for an optional field is rejected (`@IsString`/`@IsInt` fail on `null`): a value is set or absent.
- `MedicalRecordPatchDto`: the same six optional fields (here `chiefComplaint` is optional `(3, 2000)`) plus `reason` optional `@IsString @NotBlank @CodePointLength(3, 1000) @NoControlCharacters("nul")`. `toInput()` returns `{ changes: RecordChanges; reason?: string }`. The controller rejects a body with **no record field** (`reason` alone, or `{}`) with `EmptyRecordUpdate` (`400`, `details[].field = body`, "must contain at least one record field") before any database access.
- `TimelineQueryDto` extends `PaginationQueryDto` (`cursor` `@IsString @MaxLength(1024)`, `limit` `ToInt @IsInt @Min(1) @Max(100)`); the cursor is decoded with `decodeTimestampCursor` (`400` `details[].field = cursor` when malformed).
- `GET /records/{id}` takes no query: the controller calls `assertEmptyBody(req.query)` (any member → `400 ValidationFailed`; the `'400'` response is added to the operation by R5).

**Response shapes** (plain DTO classes, `static from(...)`, viewer-aware; none contains a URL):
- `MedicalRecord` (`MedicalRecordResponseDto.from(entity, amendments, viewer)`): `id, consultationId, patientUserId, doctorUserId, chiefComplaint, examinationNotes, diagnosisText, diagnosisCode, treatmentPlan, followUpInDays` (optional ones `null` when absent), `lockedAt` (UTC ISO `Z`), `isLocked`, `amendments[]` (oldest first), `attachments: []` (always, this unit), `createdAt, updatedAt`. A viewer with role `admin` is a programming error (`Error("medical_record_viewer_not_permitted")`, `500` if ever reached); patients and doctors receive the same shape.
- `MedicalRecordAmendment` (`MedicalRecordAmendmentResponseDto.from(entity, viewer)`): `id, recordId, authorUserId, chiefComplaint, examinationNotes, diagnosisText, diagnosisCode, treatmentPlan, followUpInDays` (`null` when not amended), `reason, createdAt`. The patient sees the `reason`.
- `PatientTimeline` (`PatientTimelineResponseDto.from(profile, records, amendmentsByRecord, viewer)`): `{ patient: PatientProfile | null, records: MedicalRecord[] }`; `patient` via `PatientProfileResponseDto.from` (clinical fields for the patient themself or a related doctor), `null` without a profile (1.5.6); `records` newest first; each carries its amendments; `meta` from `buildPage`.
- Never emitted: `deleted_at`, and for the create `201` the amendment list is `[]` and `isLocked` is `false`.

### 3.2 Route composition (`src/app/records/routes.ts`)
```ts
router.post ("/consultations/:id/record",           userGuard(), authorize(p.create),   writeLimit(),    c.create);
router.get  ("/records/:id",                        userGuard(), authorize(p.get),      readLimit(),     c.get);
router.patch("/records/:id",                        userGuard(), authorize(p.update),   writeLimit(),    c.update);
router.get  ("/patients/:patientUserId/records",    userGuard(), authorize(p.timeline), timelineLimit(), c.timeline);
return sealRouter(router);
```
`src/routes.ts`: `router.use(buildRecordsRouter())` is registered **after** `buildConsultationsRouter()`. No path collides: `/consultations/:id/record` is a distinct path from `/consultations/:id` and the sessions literals; `/patients/:patientUserId/records` is distinct from `/patients/:patientUserId` and from `/patients/me`; a request to `/patients/me/records` reaches the timeline route with `patientUserId = "me"`, which the resolver answers `404`. The boot assertion (`assertRoutesAuthorized`) covers the new router. `limits` are built from the constants in `records/constants.ts` by `records/rate-limits.ts` (3.9), not copied from another module.

### 3.3 File list
```
src/app/records/
  constants.ts   enums.ts   errors.ts   types.ts   policies.ts   routes.ts   rate-limits.ts
  entity/medical-record.entity.ts   entity/medical-record-amendment.entity.ts
  dto/records.request.dto.ts        dto/records.response.dto.ts
  repository/medical-records.repo.ts   repository/medical-record-amendments.repo.ts
  service/records.service.ts           create / update
  service/record-queries.service.ts    get / timeline
  service/record-links.service.ts      recordedConsultationIds / isFollowUpTarget / findAccessRow
  controller/records.controller.ts
src/migrations/20261017120000_create_medical_records.ts
src/migrations/20261017120100_create_medical_record_amendments.ts
src/migrations/20261017120200_add_consultations_follow_up_fk.ts
```
Edited:
- `consultations`: `repository/consultations.repo.ts` (`findParties`; `insertConsultation` writes `follow_up_of_record_id`), `service/consultation-rows.service.ts` (`findParties`), `service/consultations.service.ts` (book step 0 removed, follow-up check, 3.7), `service/consultation-queries.service.ts` (`hasRecord` batch on list and get-one), `dto/consultations.response.dto.ts` (`hasRecord: view.hasRecord`), `view.ts` (`buildConsultationView` gains `recordedIds: ReadonlySet<number> = NO_RECORDS`), `types.ts` (`ConsultationParties`, `NewConsultation.followUpOfRecordId`, `ConsultationView.hasRecord`), `errors.ts` (`FollowUpNotSupported` removed with its tests).
- `sessions`: `service/session-queries.service.ts` (calendar `hasRecord` batch).
- `patients`: `service/patients.service.ts` (`findProfile`).
- `lib`: `knex/pg-errors.ts` (`checkViolationConstraint`), `logger/redact.ts` (4 keys, 7), `di/tokens.ts` (`RecordsService`, `RecordQueriesService`, `RecordLinksService`, `RecordsController`).
- `bootstrap.ts` (registration order: `RecordLinksService`, `RecordsService`, `RecordQueriesService`, `RecordsController`, **before** `ConsultationsService`/`ConsultationQueriesService`/`SessionQueriesService` so they can inject it), `src/routes.ts` (mount and `NO_STORE_PREFIXES`), `tests/helpers` (`records-fixtures.ts`).

### 3.4 Entities
`MedicalRecord` plain class (`constructor(data: Partial<MedicalRecord>)`, camelCase mirror of the columns; `isLocked: boolean` is derived in SQL, section 3.5; dates as `Date`). `MedicalRecordAmendment` likewise (`recordId` = `medical_record_id`). `types.ts` holds the non-entity types: `MedicalRecordRow`, `AmendmentRow`, `NewRecord`, `RecordChanges` (`chiefComplaint?`, `examinationNotes?`, `diagnosisText?`, `diagnosisCode?`, `treatmentPlan?`, `followUpInDays?`), `RecordColumnChanges`, `RecordUpdateResult` (`{ kind: "updated" | "unchanged"; record: MedicalRecord } | { kind: "amended"; amendment: MedicalRecordAmendment }`), `RecordAccessRow` (`{ id; patientUserId; doctorUserId }`), `TimelineQuery`, `TimelineFilter`, `TimelinePage`, `RecordViewer`, `RecordsRoute`, `RecordsPolicies`.

### 3.5 Repository (functions, `conn: Knex = db`, explicit `MEDICAL_RECORD_COLUMNS`, `whereNull("deleted_at")` on every read)
`medical-records.repo.ts`. Every read selects `MEDICAL_RECORD_COLUMNS` plus the raw expression `(locked_at <= NOW()) AS is_locked` (database time, the trigger's clock).
- `insertRecord(input, trx)` — `INSERT ... (consultation_id, patient_user_id, doctor_user_id, chief_complaint, examination_notes, diagnosis_text, diagnosis_code, treatment_plan, follow_up_in_days, locked_at) VALUES (..., NOW() + interval '24 hours') RETURNING <cols>, is_locked`. `created_at` and `updated_at` take their defaults. A concurrent duplicate raises `23505` on `uq_medical_records_consultation_id`.
- `findById(id, conn)` and `findByIdForNoKeyUpdate(id, trx)` (`.forNoKeyUpdate()`; the lock and the `is_locked` flag come from the same statement).
- `findLiveByConsultationId(consultationId, conn)` — `SELECT id ... WHERE consultation_id = $1 AND deleted_at IS NULL` (create-gate courtesy check).
- `updateRecordFields(id, columns, trx)` — `UPDATE medical_records SET <changed columns>, updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING <cols>, is_locked`; the trigger is the guard.
- `findAccessRow(id, conn)` — `SELECT id, patient_user_id, doctor_user_id ... WHERE id = $1 AND deleted_at IS NULL` (no clinical text; resolvers).
- `isFollowUpTarget(recordId, patientUserId, doctorUserId, conn)` — `SELECT 1 ... WHERE id = $1 AND patient_user_id = $2 AND doctor_user_id = $3 AND deleted_at IS NULL LIMIT 1`.
- `listConsultationIdsWithRecord(consultationIds, conn)` — `SELECT consultation_id ... WHERE consultation_id = ANY($1) AND deleted_at IS NULL`.
- `listTimelineQuery(filter, conn)` (exported for EXPLAIN) / `listTimeline`: `SELECT <cols>, is_locked, to_char(created_at AT TIME ZONE 'UTC', ...) AS created_at_cursor ... WHERE patient_user_id = $p AND deleted_at IS NULL [AND (created_at, id) < ($t::timestamptz, $id)] ORDER BY created_at DESC, id DESC LIMIT $n + 1` (`timestampCursorSelect`).

`medical-record-amendments.repo.ts`: `insertAmendment(input, trx)` — `INSERT ... (the nine granted columns) RETURNING <cols>`; `listByRecordIds(ids, conn)` — `WHERE medical_record_id = ANY($1) ORDER BY id` (append order, M7), grouped in memory by `recordId` (one query for any number of records; never one per record).

`consultations.repo.ts` `findParties(id, conn)` — `SELECT id, doctor_user_id, patient_user_id, status FROM consultations WHERE id = $1 AND deleted_at IS NULL` (primary key; reads no complaint text).

### 3.6 Services

**`RecordsService`** (`@injectable()`; deps `Db, AuditRecorder, ConsultationRowsService`). Transactions in Knex's handler form; repositories take the `trx`; no Identity, storage or video call anywhere.

**Creation gate — `create(actor, consultationId, input)`.** The order is fixed; the first failure wins:

| # | Check | Where | Failure |
|---|---|---|---|
| 1 | verified user token, role `doctor`, `status=active`, local suspension (`doctor_not_suspended`) | `userGuard` + `authorize` (role, account state, check) | `401` / `403 Forbidden` |
| 2 | consultation exists and the caller is its assigned doctor | resolver `record_write_consultation` | `404 NotFound` (absent, any doctor who is not the assigned one, related or not, whatever the status; non-numeric id) |
| 3 | rate limit | limiter | `429` |
| 4 | body validates | controller (`validateBody`) | `400 ValidationFailed` |
| 5 | one transaction opens; `rows.findParties(id, trx)`; absent, or `parties.doctorUserId !== actor.userId` (defence in depth; the resolver already guaranteed it) | service | `404 NotFound` |
| 6 | (removed by M1: no `NotAssignedDoctor` on create) | - | - |
| 7 | `parties.status === completed` | service | `409 RecordRequiresCompleted` |
| 8 | no live record: `findLiveByConsultationId` | service (courtesy) | `409 Conflict` |
| 9 | `insertRecord` with `patient_user_id` / `doctor_user_id` from `parties`, `locked_at = NOW() + 24 h`; `23505` on `uq_medical_records_consultation_id` | DB | `409 Conflict` (the transaction is already aborted and rolled back when the catch maps it) |
| 10 | `audit.record` `record.created` | same transaction | — |

Steps 5-10 are **one** transaction; the `201` is rendered after commit. Steps 2 and 5 read the same row twice (resolver outside the transaction, service inside): the resolver decides visibility, the transaction decides the write. Step 5 precedes 7 so a caller who is not the assigned doctor never learns the status (they get `404`, M1). The status is read **without a lock** (decision 1.5.5): `completed` is terminal (sessions SS-R2), so only the unique index can race, and it is the guarantee for RC-R2. Lock order: the transaction holds no lock before the insert; the insert takes `FOR KEY SHARE` on the consultation row through `fk_medical_records_consultation_id` and the unique-index entry, which a concurrent `cancel`/`complete` `FOR UPDATE` on the same row serializes with and cannot cycle with (neither takes a second lock afterwards).

`update(actor, recordId, input)` returns `RecordUpdateResult`:
1. (Policy already ran: role, active, not suspended, record visible.) Body validated (≥ 1 record field) in the controller.
2. One transaction: `record = findByIdForNoKeyUpdate(recordId, trx)` — absent → `404`. The returned `is_locked` is decided by the transaction's database time (R-D8), in the same statement that took the row lock.
3. `record.doctorUserId !== actor.userId` → `403 NotAssignedDoctor`.
4. **Not locked** (`is_locked = false`): `diff` = provided fields whose value differs from the stored one (strict equality; `null` stored versus a value counts; `reason` ignored, decision 1.5.8). No difference → return `{ kind: "unchanged", record }` with **no record write**; the transaction writes exactly one `record.read` audit row `{ consultationId, patientUserId, viewerRole: "doctor", viaNoopPatch: true }` (M3, owner decision 2026-10-18: the `200` discloses the clinical text, so it is audited as a read; no `record.updated` row, `updated_at` unchanged); the response is `200` with the current record (`amendments: []`: a record cannot have amendments before its lock, because amendments are created only after it). Otherwise `updateRecordFields(diff)` and `audit.record` `record.updated` `{ consultationId, patientUserId, changedFields }` → `{ kind: "updated", record }`, `200`.
5. **Locked** (`is_locked = true`): `reason` absent → `400 ValidationFailed` (`details[].field = reason`, "is required after the record is locked"). Otherwise `insertAmendment` (only the provided non-null fields, `author_user_id = actor.userId`, `reason`) and `audit.record` `record.amended` `{ consultationId, patientUserId, amendmentId, changedFields, reasonLength }` → `{ kind: "amended", amendment }`, `201`. **No diff against the effective (original + earlier amendments) value**: an amendment is an explicit, reasoned act (R-D7); the original row is not touched.
6. Race and defence in depth: any `check_violation` whose `constraint` is `trg_medical_records_forbid_update_after_lock` (`checkViolationConstraint`) → `409 RecordLocked`. The service and the trigger read the same `NOW()` inside one transaction, so this can happen only if a row was altered outside the service; it is mapped instead of surfacing a `500`. Other `23514` violations (a named `chk_*`) are programming errors (`500`).
7. The lock instant is the **transaction start**: a `PATCH` whose transaction began before `locked_at` and waited on the row lock still commits in place, bounded by the lock wait (the same time the trigger sees). Accepted.

Boundary summary (all with database time): `locked_at = NOW() + ε` (ε > 0) → in place; `locked_at = NOW()` or earlier → locked (`<=`).

**`RecordQueriesService`** (`@injectable()`; deps `Db, AuditRecorder, PatientsService`).
- `get(actor, recordId)`: one transaction: `findById(recordId, trx)` (absent → `404`); defence in depth: an `admin` actor → `Forbidden`, a `patient` actor who is not `patientUserId` → `404` (the doctor's relationship was decided once by the resolver); `amendments = listByRecordIds([id], trx)`; `audit.record` `record.read` `{ consultationId, patientUserId, viewerRole, viewerIsAuthor, amendmentCount }`; return. The audit row is the last statement before commit, so a failed insert rolls back and the request fails with `500` without a body (RC-R14). A `404` writes no audit row.
- `timeline(actor, patientUserId, query)`: `limit = resolveLimit(query.limit)`, `after = decodeTimestampCursor(...)` when a cursor is given. One read transaction:
  1. `listTimeline({ patientUserId, after, fetch: limit + 1 })`.
  2. `buildPage(rows, limit, row => [row.createdAtCursor, row.id])`.
  3. `listByRecordIds(page ids)` — **one** query, skipped only when the page is empty.
  4. `patients.findProfile(patientUserId, trx)` — **one** query; absent → `patient: null` (1.5.6). Repeated on every page (R-D10); no `patient_profile.read` row.
  5. `audit.record` `patient_records.listed` (`entity_type = 'patient_records'`, `entity_id = patientUserId`) `{ patientUserId, viewerRole, recordCount, hasMore, firstPage }` — one row per call, also for an empty page; a failed insert fails the read.
  Total: 4 statements (3 on an empty page) in one transaction.

**`RecordLinksService`** (`@injectable()`; deps `Db`; thin, no rules; the one way other modules reach `medical_records`):
- `recordedConsultationIds(consultationIds, conn = db): Promise<Set<number>>` — `listConsultationIdsWithRecord`; returns an empty set **without a query** for an empty input.
- `isFollowUpTarget(recordId, patientUserId, doctorUserId, conn = db): Promise<boolean>`.
- `findAccessRow(recordId, conn = db): Promise<RecordAccessRow | undefined>`.

### 3.7 Changes in `consultations` and `sessions`

**`hasRecord` (C9 lifted), no N+1.** Only a `completed` consultation can have a record, so callers collect the ids of the **`completed`** rows of the page and call `RecordLinksService.recordedConsultationIds(ids)` once (zero completed rows → no query):
- `ConsultationQueriesService.list`: one extra query per page (after the page read, before building views); `get`: one extra query when the row is `completed` (outside the audit transaction; read-only).
- `SessionQueriesService.calendar`: the same, for the `completed` rows of the window; `waitingRoom` (only `booked`/`waiting`) never queries.
- `buildConsultationView(consultation, viewer, context, users, detail, recordedIds = NO_RECORDS)` sets `view.hasRecord = recordedIds.has(consultation.id)`; `ConsultationResponseDto.from` emits `hasRecord: view.hasRecord`.
- **Write responses keep `hasRecord: false` and need no query**: book (first execution), reschedule, cancel, join, start, no-show can never be on a record-bearing row, and `complete` returns the row it just completed, before any record can exist (RC-R17). **Exception (M9):** a booking replayed through the database idempotency path (`findByIdempotencyKey`, e.g. after the Redis key expired) returns the *current* row, which may be `completed` and recorded; `ConsultationQueriesService.renderOwn` (the consultations write-response renderer, used by book, reschedule and cancel) therefore resolves `recordedConsultationIds` for its one row when, and only when, it is `completed` (no query for any other status), so `hasRecord` is truthful. The sessions `renderOwn` is unchanged (`complete` returns the row it just completed).
- Failure policy: the lookup is a database read in the same pool; an error is a `500` like any other read of that route (no degrade).

**Follow-up link (C6 lifted).** In `ConsultationsService.bookOnce`, inside the booking transaction, after the doctor profile `FOR SHARE` lock, the bookable check and the type lookup, and **before** the past/horizon/grid checks:
```ts
if (input.followUpOfRecordId !== undefined
    && !(await this.records.isFollowUpTarget(input.followUpOfRecordId, actor.userId, doctor.userId, trx))) throw NotFound;
```
and `insertConsultation` writes `follow_up_of_record_id`. The old step 0 (`FollowUpNotSupported`, before any database access) is removed. Rules: the record is live, its `patient_user_id` is the caller (from the token) and its `doctor_user_id` is the chosen `doctorId`; a missing, foreign, other-doctor or deleted record is the same `404 NotFound` (no probing, R-D3). No check of `followUpInDays`, of timing, or that the record's consultation is related to the new slot. The idempotent replay path (same key, same body) returns the stored consultation before this check, as for every other check.
- **Locks:** the check is a plain read; no lock on the record is needed (no route deletes a record; soft delete is blocked after the lock by the trigger and has no route before it). The consultation insert takes `FOR KEY SHARE` on the record row through `fk_consultations_follow_up_of_record_id`, which does not conflict with the `FOR NO KEY UPDATE` that `PATCH` holds (decision 1.5.4). The booking lock order is unchanged: doctor profile (`FOR SHARE`) → consultation insert → record key-share (taken last, held to commit); a record writer never takes a profile or consultation row lock after its record lock, so there is no cycle.

### 3.8 Policies (`policies.ts`, `buildRecordsPolicies(doctors, rows, links, relationship)`)
`doctors: Pick<DoctorsService, "isLocallySuspended">`, `rows: Pick<ConsultationRowsService, "findParties">`, `links: Pick<RecordLinksService, "findAccessRow">`, `relationship: PatientRelationshipChecker` (`TOKENS.PatientRelationship`).

| Route | Policy |
|---|---|
| `create` | roles `[doctor]`, owner resolver `record_write_consultation` (below), `checks: [doctorNotSuspendedCheck(doctors)]`, `audit: "clinical-write"` |
| `update` | roles `[doctor]`, owner resolver `record_write_record`, `checks: [doctorNotSuspendedCheck(doctors)]`, `audit: "clinical-write"` |
| `get` | roles `[patient, doctor]`, owner resolver `record_reader`, `audit: "clinical-read"` (no check: suspension is inside the resolver) |
| `timeline` | roles `[patient, doctor]`, owner resolver `records_timeline_reader`, `audit: "clinical-read"` |

Resolvers (all return `deny-not-found` for a non-numeric path id; they see only `auth` and the path params):
- `record_write_consultation` (`x-ownership: assigned-doctor`): `id` → `rows.findParties(id)`; absent → `deny-not-found`; `doctorUserId === auth.userId` → `allow`; otherwise `deny-not-found` (no relationship lookup: M1).
- `record_write_record`: `links.findAccessRow(id)` (author = `doctorUserId`); author → `allow`; else `relationship.hasConsultationRelationship(auth.userId, patientUserId)` → `allow` (the service answers `NotAssignedDoctor`) or `deny-not-found`.
- `record_reader`: `links.findAccessRow(id)`; absent → `deny-not-found`; patient → `allow` iff `patientUserId === auth.userId`; doctor → `deny-not-found` if `doctors.isLocallySuspended(auth.userId)`; else `allow` iff `doctorUserId === auth.userId` or the relationship holds; any other role → `deny-forbidden`.
- `records_timeline_reader`: `patientUserId` from the path; patient → `allow` iff equal to `auth.userId`; doctor → `deny-not-found` if locally suspended, else `allow` iff the relationship holds; else `deny-forbidden`. (It reuses the `PatientRelationshipChecker` port exactly as `consulted_patient_or_self` does; it is a separate resolver because its suspended-doctor answer is `404`.)
- A pending, rejected or otherwise non-`active` doctor or patient is stopped by the role/account-state step with `403 Forbidden` before any resolver runs.
- **Admins** are absent from every role list: `403 Forbidden` at the role step on all four routes (the first step after authentication, before any lookup), so an admin learns nothing about ids.

### 3.9 Rate limits (`constants.ts`, `rate-limits.ts`; `429` + `Retry-After`; Redis sliding window, all per user)
```ts
export const RECORDS_RATE_WINDOW_MS = 60_000;
export const RECORDS_WRITE_USER_LIMIT = 20;      export const RECORDS_WRITE_RATE_NAME = "records-write-user";     // POST + PATCH share one bucket
export const RECORDS_READ_USER_LIMIT = 120;      export const RECORDS_READ_RATE_NAME = "records-read-user";       // GET /records/{id}
export const RECORDS_TIMELINE_USER_LIMIT = 60;   export const RECORDS_TIMELINE_RATE_NAME = "records-timeline-user"; // GET /patients/{id}/records
```
`rate-limits.ts` exports `writeLimit()`, `readLimit()`, `timelineLimit()` (each `rateLimit({ name, limit, windowMs, subject: byUser })`). Admin calls never reach a limiter (denied at `authorize`). The limiter runs after `authorize`, so a `403`/`404` does not consume budget.

### 3.10 No-store
`src/routes.ts`: `NO_STORE_PREFIXES` gains `"/api/records"` (the other three record paths already sit under `/api/consultations` and `/api/patients`). `app.ts` applies the list before body parsing, so a malformed-JSON `PATCH /api/records/1` also answers `400` with `Cache-Control: no-store`. Test: one malformed-JSON `PATCH` per new prefix in `tests/integration/no-store.test.ts`.

### 3.11 Controller, DI, errors, constants, enums
- `RecordsController` (arrow methods only: validate → service → render → `sendSuccess`; `requireAuth`; path ids parsed with `parsePositiveId`, `undefined` → `NotFound`). `create` → `201`; `update` → `200`/`201` by `RecordUpdateResult.kind`; `get` → `200`; `timeline` → `200` with `{ meta }`. The controller never reads clinical text except to pass the validated DTO on.
- `errors.ts`: `NotAssignedDoctor` (403, "Only the assigned doctor can write this record"), `RecordRequiresCompleted` (409, "A record can be written only for a completed consultation"), `RecordLocked` (409, "The record is locked"), `RecordAlreadyExists` = `Conflict.withMessage("A record already exists for this consultation")`, `EmptyRecordUpdate`, `ReasonRequiredAfterLock` (both `ValidationFailed.withDetails`). The three Care codes already exist in `ErrorCode` (`lib/error/types.ts`).
- `enums.ts`: `RecordAuditAction { Created = "record.created", Read = "record.read", Updated = "record.updated", Amended = "record.amended", TimelineListed = "patient_records.listed" }`; `RecordField { ChiefComplaint = "chiefComplaint", ... }` (the field names used in `changedFields`).
- `constants.ts`: rate constants (3.9), `MEDICAL_RECORD_ENTITY_TYPE = "medical_record"`, `PATIENT_RECORDS_ENTITY_TYPE = "patient_records"`, `UQ_MEDICAL_RECORDS_CONSULTATION_ID`, `TRG_MEDICAL_RECORDS_FORBID_UPDATE_AFTER_LOCK`, `CHIEF_COMPLAINT_MIN/MAX_LENGTH` (3, 2000), `NOTES_MAX_LENGTH` and `TREATMENT_PLAN_MAX_LENGTH` (10000), `DIAGNOSIS_TEXT_MAX_LENGTH` (2000), `DIAGNOSIS_CODE_PATTERN`, `FOLLOW_UP_MIN/MAX_DAYS` (1, 365), `AMENDMENT_REASON_MIN/MAX_LENGTH` (3, 1000).
- `lib/knex/pg-errors.ts`: `PG_CHECK_VIOLATION = "23514"` and `checkViolationConstraint(error)` (the constraint name when the error is a pg check violation carrying a constraint string, else `undefined`), beside `uniqueViolationConstraint` / `exclusionViolationConstraint`.
- DI: tokens `RecordsService`, `RecordQueriesService`, `RecordLinksService`, `RecordsController`; `bootstrap.ts` registers `RecordLinksService`, then `RecordsService`, `RecordQueriesService`, `RecordsController` (only `bootstrap.ts` wires `app/` into the container).

---

## 4. Business rules

| # | Rule | Enforced by |
|---|---|---|
| RC-R1 | A record exists only for a `completed` consultation; any other status → `409 RecordRequiresCompleted` for the assigned doctor (Domain rule 13) | service (creation gate step 7) |
| RC-R2 | One live record per consultation; a repeat or concurrent create is `409 Conflict`; two simultaneous creates → exactly one `201` | `uq_medical_records_consultation_id` (`23505` → `Conflict`) + courtesy pre-check |
| RC-R3 | Only the consultation's assigned doctor writes its record. Create: every other caller gets `404` (M1, no existence oracle). `PATCH /records/{id}`: a related doctor who is not the author gets `403 NotAssignedDoctor`; an unrelated doctor gets `404` (Domain rule 14) | resolver (create); resolver + service (`PATCH`) |
| RC-R4 | `patient_user_id` and `doctor_user_id` are copied from the consultation (create) and never from the body; `PATCH` cannot change them | service + request DTO (`forbidNonWhitelisted`) |
| RC-R5 | `locked_at = created_at + 24 h` exactly, set from database time, never from the client or Node's clock | `chk_medical_records_lock` + raw `NOW() + interval '24 hours'` insert |
| RC-R6 | Before the lock `PATCH` updates in place (`200`) and audits `record.updated` with the changed field names; values equal to the stored ones are a no-op: `200` with the current record, no record write, exactly one `record.read` audit row (M3) | service (`FOR NO KEY UPDATE`, diff) |
| RC-R7 | After the lock `PATCH` inserts a `medical_record_amendments` row (`201`) and audits `record.amended`; the original row is never touched; no diff against the effective value; `reason` required (else `400`) | service; no `UPDATE` on the original after the lock |
| RC-R8 | The lock is decided with database time under the row lock, the same clock as the trigger; any `UPDATE` once `OLD.locked_at <= NOW()` (soft delete included) is refused; the trigger's `check_violation` maps to `409 RecordLocked` | service + `trg_medical_records_forbid_update_after_lock` |
| RC-R9 | Amendments are append-only: the app role can `SELECT` and `INSERT` nine columns only, never `UPDATE`, `DELETE`, `TRUNCATE`, and never set `id`/`created_at`; `medical_records` has no `DELETE`/`TRUNCATE` grant | grants (migrations 2.1, 2.2) |
| RC-R10 | An amendment carries at least one non-null amended field and cannot clear a field to null (accepted limitation, R-D6); `follow_up_in_days` 1..365 and the diagnosis-code format also hold in the database | `chk_medical_record_amendments_nonempty`, `_follow_up`, `_diagnosis_code`; request DTO |
| RC-R11 | Patients never write a clinical field; admins never reach any of the four routes (`403 Forbidden`) and no DTO has an admin form (Domain rules 16, 19) | `authorize` roles; response DTOs throw for an admin viewer |
| RC-R12 | Read visibility: the patient reads their own records and timeline; a doctor reads a record they authored or of a patient with whom they hold a `booked`/`waiting`/`in_progress`/`completed` consultation; cancelled and no-show rows grant nothing; everyone else `404` (Domain rules 17, 18) | resolvers + `idx_consultations_doctor_user_id_patient_user_id` |
| RC-R13 | A locally suspended doctor: `403 Forbidden` on create and `PATCH`, `404 NotFound` on `GET /records/{id}` and the timeline (R-D5); their authored records stay readable by the patient and by other consulted doctors | `doctor_not_suspended` check (writes); resolver (reads) |
| RC-R14 | Every successful read (`record.read`, `patient_records.listed`) writes an audit row in the read's transaction before the response; a failed audit insert fails the read (`500`, no body); a `404`/`403` writes no audit row | `AuditRecorder` in the read transaction |
| RC-R15 | Every write writes its audit row in the same transaction (`record.created`, `record.updated`, `record.amended`); metadata holds ids, roles, counts and changed field **names** only — never clinical text, codes or the amendment reason | service + `AuditRecorder` key validation |
| RC-R16 | The timeline is `(created_at DESC, id DESC)` keyset, `limit + 1`, `meta { nextCursor, hasMore, count }`, amendments loaded by **one** `= ANY($1)` query per page, `data.patient` repeated on every page, exactly one `patient_records.listed` row per call | repository + service |
| RC-R17 | `Consultation.hasRecord` is true iff a live record exists, computed with one batched query per page over the `completed` rows (none when there are none); write responses are `false` by construction, except the booking replay through the database idempotency path, which looks up the replayed row when it is `completed` (M9) | `RecordLinksService` + view builder |
| RC-R18 | `followUpOfRecordId` must reference a live record whose `patient_user_id` is the caller and whose `doctor_user_id` is the chosen doctor, else `404 NotFound`; no timing or `followUpInDays` check; the link is stored and FK-protected | booking transaction + `fk_consultations_follow_up_of_record_id` |
| RC-R19 | No record route takes an `Idempotency-Key` or is behind the idempotency middleware; no record text is ever held in Redis; a retried create is `409 Conflict` | route composition; log/Redis hygiene test |
| RC-R20 | Rate limits per user: record `POST`/`PATCH` 20/min (one bucket), `GET /records/{id}` 120/min, timeline 60/min → `429 RateLimited` | `rateLimit` (Redis sliding window) |
| RC-R21 | Input: `chiefComplaint` 3..2000 and required on create; optional text non-blank (`examinationNotes`, `treatmentPlan` ≤ 10000; `diagnosisText` ≤ 2000); `diagnosisCode` matches `^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$`; `followUpInDays` 1..365; `reason` 3..1000; NUL rejected; unknown properties and JSON `null` members rejected; a body with no record field is `400` | request DTOs + controller; `CHECK`s as backstop |
| RC-R22 | Every record response carries `Cache-Control: no-store` | `NO_STORE_PREFIXES` (`/api/records` added) |
| RC-R23 | `attachments` is `[]` on every record DTO; no response contains a URL, object key or file field | response DTO |
| RC-R24 | Record routes make no Identity call and hydrate no names (DTOs carry user ids) | design |
| RC-R25 | Every read filters `deleted_at IS NULL`; no route sets `deleted_at` or deletes | repository |
| RC-R26 | Lock-order safety: record writes hold only the record row (`FOR NO KEY UPDATE`) and the create takes no lock before its insert; a follow-up booking's `FOR KEY SHARE` on the record never blocks or deadlocks a `PATCH` | `FOR NO KEY UPDATE`; section 3.7 |

---

## 5. Cross-service behavior
**None.** No call to Identity (no Case 1, 2, 3 or 4): record and timeline DTOs carry `patientUserId`, `doctorUserId` and `authorUserId` only, so there is nothing to hydrate and no degrade path; no record route is a must-not-degrade path either. The only cross-module reads are inside Care (`consultations` relationship port and parties lookup, `doctors` suspension, `patients` profile). Platform changes: none.

## 6. Error codes
| Code | HTTP | When |
|---|---|---|
| `ValidationFailed` | 400 | DTO failure (unknown/`null` member, bad lengths, blank text, bad `diagnosisCode`, `followUpInDays` out of range, NUL); no record field in a `PATCH` body; `reason` missing after the lock; malformed `cursor`/`limit`; any query member on `GET /records/{id}` |
| `Unauthorized` / `TokenExpired` | 401 | token problems |
| `Forbidden` | 403 | admin on any record route; patient on create/`PATCH`; non-`active` account; locally suspended doctor on create/`PATCH` |
| `NotAssignedDoctor` | 403 | `PATCH /records/{id}` only: a doctor with a relationship to the patient who is not the record's author (create answers `404`, M1) |
| `NotFound` | 404 | absent, soft-deleted, or invisible consultation / record / patient timeline (non-owner patient, unrelated doctor, any doctor who is not the consultation's assigned doctor on create, suspended doctor on reads, non-numeric id, `me`); foreign or missing `followUpOfRecordId` on booking |
| `RecordRequiresCompleted` | 409 | create on a consultation that is not `completed` |
| `Conflict` | 409 | a live record already exists for the consultation (pre-check or `23505`) |
| `RecordLocked` | 409 | the lock trigger refused an in-place update (R4) |
| `RateLimited` | 429 | write 20/min, read 120/min or timeline 60/min exceeded |
| `InternalError` | 500 | unhandled, including an audit insert that fails on a read |

New codes: none (all exist in CLAUDE.md → API conventions; `RecordLocked`'s "when" is widened by contract edit R4).

## 7. Security & privacy
- **RBAC summary:** create = the assigned doctor only (active, not suspended; everyone else `404`); `PATCH` = the author (a related doctor gets `403 NotAssignedDoctor`); `GET /records/{id}` = the patient, the author, or a consulted doctor (not suspended); timeline = the patient themself or a consulted doctor (not suspended); **admin denied on all four**, `404` for everyone else. Deny-by-default `authorize` on every route; the boot assertion covers the new router.
- **Audit** (entity type `medical_record`, entity id = record id, unless stated); metadata is flat scalars (≤ 20 keys, no redacted key names, `AuditRecorder` enforces both):

  | Action | Written | Metadata |
  |---|---|---|
  | `record.created` | create transaction | `consultationId, patientUserId, doctorUserId, providedFields` (comma-joined field names) |
  | `record.read` | get-one transaction, before the response; also the pre-lock no-op `PATCH` (M3) | get-one: `consultationId, patientUserId, viewerRole, viewerIsAuthor, amendmentCount`; no-op `PATCH`: `consultationId, patientUserId, viewerRole, viaNoopPatch` (`true`) |
  | `record.updated` | patch transaction (in place) | `consultationId, patientUserId, changedFields` |
  | `record.amended` | patch transaction (after the lock) | `consultationId, patientUserId, amendmentId, changedFields, reasonLength` |
  | `patient_records.listed` (entity type `patient_records`, entity id = `patientUserId`) | timeline transaction, before the response | `patientUserId, viewerRole, recordCount, hasMore, firstPage` |

  Never in metadata: chief complaint, notes, diagnosis text or code, treatment plan, the amendment reason, names. Field names are not data. No row for a `404`/`403`/`400`/`409` or a rate-limited call. A no-op `PATCH` writes the `record.read` row above and no `record.updated` row.
- **Never logged** (defence in depth in `lib/logger/redact.ts`, each key with a row in the redaction unit test): `REDACTED_KEYS` already contains `examinationNotes`, `diagnosisText`, `diagnosisCode`, `treatmentPlan`, `allergies`, `chronicConditions`, `bloodType`, `dateOfBirth`, `body`, `requestBody`. This unit **adds** `chiefComplaint`, `followUpInDays`, `amendments` (so a logged record or timeline object cannot leak the nested `reason`) and `amendmentReason`. The bare key `reason` is **not** added: `authorize` logs `access_denied` with a `reason` field and the audit metadata allowlist would also reject it; request bodies are never logged. Log lines on these routes carry ids, statuses and the route pattern only; validation `details` carry field names and constraint text, never values.
- **No clinical text in Redis**: no idempotency middleware on any record route (R-D4); only rate-limit counters. A test scans Redis keys and values for the fixture strings.
- **No-store** on every response (3.10). **Existence:** non-owners get `404`; the one deliberate `403` for a non-admin is `NotAssignedDoctor` on `PATCH /records/{id}` toward a doctor who can already see that record id in the patient's timeline.
- **Rate limits:** 3.9. **Files:** not applicable in this unit (`attachments` is `[]`; `record-attachments` adds intents, `complete` and audited `download-url`).
- **Accepted-by-design** (CLAUDE.md RBAC, consultations D-R4): any doctor holding a `booked`/`waiting`/`in_progress`/`completed` consultation with a patient reads that patient's **whole** timeline, including other doctors' records.

## 8. Performance
No CLAUDE.md budget covers records; targets (p95): create and `PATCH` < 150 ms, `GET /records/{id}` < 150 ms, timeline page (20 records) < 200 ms, each excluding nothing (no external call).
- **create:** resolver 1 + transaction (`findParties` 1, duplicate check 1, insert 1, audit 1) = 4 in the transaction.
- **PATCH:** resolver 1-3 + transaction (locked read 1, update 1 or amendment insert 1, audit 1; a no-op does 2: the locked read and the `record.read` audit row).
- **get-one:** resolver 1 (+ suspension 1 and relationship ≤ 1 for a doctor) + transaction (record 1, amendments 1, audit 1).
- **timeline:** resolver (doctor: suspension 1, relationship 1) + transaction (page 1, amendments 1, profile 1, audit 1). **Amendments are one query per page**, never per record.
- **hasRecord:** +1 indexed query per list page / calendar window / get-one only when a `completed` row is present; 0 otherwise.
- **Index coverage** (section 2.4): the timeline page uses `idx_medical_records_patient_user_id_created_at_id` for the first page and for the keyset continuation; amendments use `idx_medical_record_amendments_medical_record_id_id`; duplicate check and `hasRecord` use `uq_medical_records_consultation_id`; everything else is a primary-key access or the existing relationship index. `tests/integration/records-explain.test.ts` asserts no sequential scan on `medical_records` / `medical_record_amendments` for the timeline (both pages), the amendments batch, the duplicate check and the `hasRecord` batch, on tables large enough that the planner has a real choice (ANALYZEd synthetic rows).
- **Unbounded inputs:** the number of amendments per record is not capped in MVP (writes are limited to 20/min and a doctor-driven act); a page loads the amendments of at most 100 records. If an amendment-heavy record appears in practice, a per-record cap is a follow-up (a new error code and a contract edit).
- **No N+1:** one amendments query per page, one `= ANY` `hasRecord` batch, one profile query per timeline call.

## 9. Test plan outline
**Unit** (`tests/unit/`, mocked collaborators, fake clock only where a service uses `Clock`; the lock tests use a stubbed repository because the lock clock is the database's):
- `app/records/dto`: create/patch/timeline tables — required `chiefComplaint`, 2 vs 3 code points, 2000/2001, blank, whitespace-only, NUL, newline allowed, optional fields 1..N, `diagnosisCode` valid/invalid (`A00`, `A00.1`, `a00`, `A0`, `A00.12345`), `followUpInDays` 0/1/365/366, JSON `null` members, unknown property, `reason` 2/3/1000/1001; patch with `reason` only and `{}` → `EmptyRecordUpdate`.
- `app/records/service/records.service.test.ts`: the creation gate order (each failure beats the next: 404 (including a caller who is not the assigned doctor) before `RecordRequiresCompleted` before `Conflict`); insert uses ids from the consultation (a body id cannot override); `23505` on `uq_medical_records_consultation_id` → `Conflict`; any other `23505` rethrown; audit called once with the right action/metadata and rolled back with the transaction; `update`: not locked + change → `updated`, equal values → `unchanged` with no record write and exactly one `record.read` audit row (`viaNoopPatch`), mixed (one equal, one different) writes only the different field, `reason` ignored before the lock; locked + reason → `amended` with only provided fields and `reasonLength`, locked without reason → `400`, locked with identical value still appends (no diff); not author → `NotAssignedDoctor`; absent → `NotFound`; `checkViolationConstraint === trg_…` → `RecordLocked`, other `23514` rethrown.
- `app/records/service/record-queries.service.test.ts`: get (404 writes no audit, audit failure propagates and no result, patient not owner `404`, admin actor refused), timeline (page building, `hasMore`/`nextCursor`, patient `null` without a profile, one audit row, empty page, amendments grouped and ordered, the amendments query skipped only for an empty page).
- `app/records/policies.test.ts`: roles per route (admin and wrong role `403`), each resolver's decision table (non-numeric id, absent, patient own/other, author, related doctor (`record_write_consultation`: `deny-not-found`; `record_write_record`: `allow`), unrelated doctor, suspended doctor on reads `deny-not-found`, writes through the check `403`), `me` as `patientUserId`.
- `app/records/record-links.service.test.ts`: empty input → no query; follow-up target predicate.
- `app/records/dto/records.response.dto.test.ts`: viewer matrix (admin throws; patient/doctor shape; `attachments: []`; `isLocked`; amendment fields null when not amended; `patient: null`); no `downloadUrl`/`objectKey` key anywhere.
- `app/consultations`: `hasRecord` in `buildConsultationView`/`ConsultationResponseDto` (set membership; default false); `ConsultationQueriesService` calls the batch once per page with only `completed` ids and never for a page without them; `book` follow-up branch (`404` for a rejected target, stored on success, replay unaffected, check runs after the bookable and type lookups and before `BookingInPast`); `FollowUpNotSupported` tests removed. `app/sessions`: calendar batch with only `completed` ids.
- `lib/knex/pg-errors.test.ts`: `checkViolationConstraint` (23514 with/without constraint, other codes). `lib/logger/redact.test.ts`: a row for each added key; assert the bare `reason` is still logged. `lib/http` no-store prefix list contains `/api/records`.
- Contract (`tests/unit/contract/records-contract.test.ts`): paths, methods, roles, status codes (including `409 RecordLocked` on `updateMedicalRecord`, no `422`/idempotency parameter on `createMedicalRecord`), response shapes of `MedicalRecord`, `MedicalRecordAmendment`, `PatientTimeline` (nullable `patient`) against `contracts/openapi.yaml`.

**Integration** (`tests/integration/records.test.ts`, `records-rbac.test.ts`, `records-rules.test.ts`, `records-privacy.test.ts`, `records-explain.test.ts`; real Postgres (`btree_gist`), real Redis; the fake Identity is not called by these routes, only by the fixtures that book; fixtures in `tests/helpers/records-fixtures.ts` approve a doctor, book and drive a consultation to `completed` through the real routes with a fake clock, and "age" a record by one owner statement that backdates `created_at` and `locked_at` together):
- **Creation gate:** author doctor on a completed consultation → `201`, ids copied from the consultation, `lockedAt = createdAt + 24 h` exactly, `isLocked:false`, `attachments:[]`, one `record.created` row in the same commit; consultation `booked`/`waiting`/`in_progress`/`cancelled`/`no_show` → `409 RecordRequiresCompleted` (assigned doctor); second create → `409 Conflict`; **a related non-assigned doctor posting to a cancelled, no-show, booked, other-doctor and record-less consultation of the same patient → `404`, body identical in shape to an absent id (M1 probing test)**; unrelated doctor, unknown and non-numeric id → `404`; audit-failure on create rolls the record back; the check order across combined failures.
- **Concurrency:** two simultaneous creates for one consultation → exactly one `201` and one `409 Conflict`, one record row, one audit row; a create racing a follow-up booking and a `PATCH` racing a follow-up booking both complete without deadlock (no `40P01`).
- **Lock boundary (database time):** repository-level in one transaction with a frozen `NOW()` — `locked_at = NOW()` → `is_locked = true`, `locked_at = NOW() + 1 µs` → `false`; route-level — just before the lock (`created_at` backdated so `locked_at` is 2 s ahead) → `PATCH` in place `200`; at/after the lock (backdated 24 h + 1 s) → `201` amendment with the original row untouched (compare the row before/after byte for byte); the trigger-only path — a direct `UPDATE` as `care_app` after the lock raises `check_violation` and the service-level injected update maps to `409 RecordLocked`; a soft delete after the lock is refused by the trigger.
- **PATCH rules:** pre-lock equal values → `200` current record, `updated_at` unchanged, no `record.updated` row and exactly one `record.read` row (`viaNoopPatch`, M3); a pre-lock `reason` shorter than 3 characters → `400` (M16); pre-lock changed → `200`, `record.updated` with `changedFields`; `reason` before the lock ignored; after the lock without `reason` → `400`; with `reason` → `201`, `record.amended` with `amendmentId`, `reasonLength`; identical-to-current value after the lock still appends; amendment cannot clear a field (JSON `null` → `400`); `reason`-only and `{}` bodies `400`; amendments appear oldest first on the next `GET`; many amendments preserved in order.
- **RBAC matrix** (every route × patient owner, other patient, author doctor, other doctor with a relationship, doctor without relationship, suspended author doctor, pending doctor, admin; plus a cancelled-only/no-show-only relationship): create — patient/admin/pending `403 Forbidden`, author `201`, related `404` (M1), unrelated `404`, suspended `403 Forbidden`; get-one — owner `200`, other patient `404`, author `200`, related doctor `200`, unrelated `404`, suspended author **`404`**, admin **`403`** (id existing or not), cancelled-only relationship `404`; `PATCH` — patient/admin `403`, author `200`/`201`, related `403 NotAssignedDoctor`, unrelated `404`, suspended `403`; timeline — self `200`, other patient `404`, related doctor `200`, unrelated `404`, suspended doctor `404`, admin `403`, `/patients/me/records` `404`, `booked`-only relationship `200` (consultations D-R4). The same rows assert that the patient and other consulted doctors still read a suspended author's records.
- **Timeline:** newest first with `(created_at, id)` tie order; page 1 and page 2 on the default sort (cursor round trip, `hasMore`, `count`, last page `nextCursor:null`); `limit` 1/100/101 and malformed cursor → `400`; `data.patient` identical on every page; `patient:null` without a profile; records of several doctors; amendments attached to the right records; exactly **one** `patient_records.listed` row per call (also for an empty page) and no `patient_profile.read` row; the amendments query count per page is 1 (query log).
- **`hasRecord` and follow-up:** `GET /consultations/{id}`, the list and the doctor calendar show `hasRecord:true` after create and `false` before; a list page with no `completed` row issues no records query; write responses `false`; a patient books with `followUpOfRecordId` of their own record with the same doctor → `201`, `followUpOfRecordId` echoed and stored; another patient's record, another doctor's record, an unknown id → `404 NotFound` and no consultation row; replay with the same key returns the stored row; `fk_consultations_follow_up_of_record_id` rejects a dangling id at the database level.
- **Audit:** `record.created/read/updated/amended` and `patient_records.listed` rows have the documented entity type/id and clinical-free flat metadata; **a failing audit insert fails the read** (`record.read` and `patient_records.listed` → `500`, no clinical text in the body, no row) and fails the write (rolled back); `404`/`403` write no row; admin audit listing (`GET /audit-logs`) shows the rows without clinical content.
- **Log hygiene / privacy** (`records-privacy.test.ts`, as `sessions-privacy.test.ts`): after create, patch, amend, get and timeline with synthetic marker strings in every clinical field and in the amendment reason, the captured logs, every `audit_logs.metadata`, all Redis keys and values, and the error responses of rejected requests contain none of the markers (including a `400` validation response and a `409`); `Cache-Control: no-store` on every response, including `400`/`404`/`429`; no `Idempotency-Key` header is read (a request carrying one behaves as without).
- **Rate limits:** the 21st record write in a minute → `429` + `Retry-After` (create and `PATCH` share the bucket); 121st `GET /records/{id}`; 61st timeline; buckets are independent and per user; an admin's denied calls consume nothing.
- **Query plans and budgets** (`records-explain.test.ts`): `EXPLAIN` of `listTimelineQuery` (first page and continuation) uses `idx_medical_records_patient_user_id_created_at_id`, the amendments batch uses `idx_medical_record_amendments_medical_record_id_id`, the duplicate check and `hasRecord` batch use `uq_medical_records_consultation_id`, none shows `Seq Scan` on the clinical tables; timing guards (timeline page of 20 records with amendments and `get-one` within the targets of section 8).
- **Contract conformance:** every status code and error code of the four operations (including `409 RecordLocked` on `PATCH`), `data` shapes, `PaginationMeta`, no `Idempotency-Key` parameter on create.
- **Migrations:** section 2.5. **No-store:** malformed-JSON `PATCH /api/records/1` → `400` + `Cache-Control: no-store`.

## 10. Out of scope
- **Attachments** (`record-attachments`, the next module): upload intents, `complete`, `download-url`, `DELETE`, `attachment.*` audit actions, the `RecordAttachment` schema rewrite and the removal of the legacy multipart operation. `attachments` is `[]` here.
- Record deletion or erasure endpoints (soft delete exists in the schema; no route; blocked by the trigger after the lock); clearing a field through an amendment (R-D6); a per-record amendment cap; a record-by-consultation lookup route.
- Phase-2 AI drafts (complaint parse, summary, ICD-10 suggestions) and any `/internal/*` record endpoint; an ICD-10 catalog or validation against real codes (R-D2).
- Doctor-initiated follow-up booking on a patient's behalf (a `/system-design` topic); a timing or `followUpInDays` check on the follow-up link (R-D3).
- Notifications about records (PRD 7.11 lists none); an outbox kind; hydration of doctor or patient names on record DTOs (ids only).
- Making the lock duration configurable (a migration would be needed); read replicas for the timeline.

## 11. Open questions
No undecided design question remains (the brainstorm's R-D6..R-D10 are resolved and folded in; the spec-level decisions in 1.5 follow from CLAUDE.md, the contract and the sources). Nothing below is pending: every item was **applied** (state as of 2026-10-18, v0.2.0).

**Contract changes (APPLIED).** All of R1-R10 landed in `contracts/openapi.yaml` before code (commit `cc2dac1`), and M11-M16 plus the M1/M3/M15/M16 text corrections landed with the fix-review (commit `fa71c81`); the contract in the hub is a verbatim copy of the current file. No new endpoint or request/response schema was introduced; the changes are removals, descriptions, one added response, one nullable property and tightened text constraints. The list is kept as the record of what changed (each item numbered as in 1.4; where the fix-review changed an item the as-built wording is given in parentheses):
- **R1** `createMedicalRecord`: remove the `IdempotencyKeyOptional` parameter and the `'422'` `IdempotencyConflict` response; in the `RecordCreateConflict` response remove the in-flight/`Retry-After` sentence and the `Retry-After` header (the response is used by this operation only).
- **R2** `createMedicalRecord`, `updateMedicalRecord`: description of the `403`/`404` split and the check order (create: every non-assigned doctor `404`, never `NotAssignedDoctor` (M1); `PATCH`: unrelated doctor `404`, related non-author `403 NotAssignedDoctor`; wrong role, non-active or suspended doctor `403 Forbidden`). **As built the order is:** role / account state / suspension check, then the ownership resolver (`404`), then the rate limit, then the body (`400`), then the transaction gate (`RecordRequiresCompleted`, `Conflict`, or on `PATCH` `NotAssignedDoctor`); the contract descriptions state exactly this order. `RecordWriteForbidden` description says create never returns `NotAssignedDoctor`.
- **R3** `MedicalRecordCreate`, `MedicalRecordPatch`: `minLength: 1` on `examinationNotes`, `diagnosisText`, `treatmentPlan`, with a description that text must not be blank and must not contain NUL; `updateMedicalRecord` / `MedicalRecordPatch` description: at least one record field is required (`reason` alone is `400`), `reason` required after the lock (`400`) and, when present, validated (3..1000, not blank; M16) but not used for the update before it, values equal to the stored ones before the lock are a no-op returning `200` with the current record and one `record.read` audit row (M3; `x-audit-actions: [record.updated, record.amended, record.read]`), an amendment is always appended after the lock, a field cannot be cleared to null.
- **R4** `updateMedicalRecord`: add `'409': RecordLocked`; widen the `RecordLocked` response description to "the record is locked (an in-place edit was refused) or an attachment cannot be deleted after the 24 h lock". CLAUDE.md → "Error codes owned by Care" row `RecordLocked` is widened to match (owner edit; **applied** in CLAUDE.md, line "`RecordLocked` | 409 | an in-place record edit refused because the record is locked, or deleting an attachment after the 24 h lock").
- **R5** `getMedicalRecord`: summary "Read a medical record with its amendments", `MedicalRecordOk` description "The medical record with its amendments", `x-audit-actions: [record.read]` (`attachment.url_issued` moves to the `record-attachments` `download-url` operation), description: non-numeric `{id}` is `404`, a locally suspended doctor `404`, admin `403`; add the `'400'` `ValidationFailed` response (any query member is rejected); add `x-account-state: 'status active; a locally suspended doctor receives 404'`.
- **R6** `listPatientRecords`: add `x-account-state: 'status active; a locally suspended doctor receives 404'`; description of the `403` (admin) / `404` (non-owner, no relationship, suspended doctor, `me`/non-numeric id) split, newest-first order, one audit row per call (stored with `entityType: patient_records`, `entityId` = the patient's Identity user id; M15); `PatientTimeline.patient` becomes `oneOf: [PatientProfile, null]` (not required to be non-null); the `required` list is unchanged.
- **R7** `MedicalRecord`: `attachments` description "always `[]` until the `record-attachments` module ships" (the `RecordAttachment` schema is not edited); `isLocked` description "computed with database time at read".
- **R8** `bookConsultation`: replace the `followUpOfRecordId` sentence (no longer `400`): must reference a live record of this patient with the chosen doctor, else `404 NotFound`; `ConsultationCreate.followUpOfRecordId` description likewise (no `followUpInDays` check, M11; `minimum: 1`, M14).
- **R9** `Consultation.hasRecord`: description "true when a live medical record exists for the consultation"; `Consultation.required` lists every always-emitted member including `hasRecord` (M13).
- **R10** `createMedicalRecord`, `updateMedicalRecord`, `getMedicalRecord`, `listPatientRecords`: one prose line each — "Rate limit 20 record writes/min per user" (create and patch share the bucket), "120 record reads/min per user", "60 timeline reads/min per user".

**Platform changes required (/system-design):** none (checked 2026-10-18 against the hub's `landscape.md`, `data-ownership.md` and `TODO.md`: records add no cross-service call, no new data owner and no runtime component).

**Docs refreshed at `/update-docs` (2026-10-18, done):** `architecture/clinical-records.md`, `architecture/data-model.md`, `architecture/api.md`, `architecture/rbac.md`, `architecture/consultation-lifecycle.md`, `architecture/overview.md`, `architecture/infrastructure.md` (grants, redaction keys), `architecture/file-handling.md` (one note), `consultations/spec.md` (C6 and C9 lifted), `sessions/spec.md` (calendar `hasRecord`), `patients/spec.md` (`findProfile`, timeline built), `docs/service-card.md`, `docs/runbook.md`, `docs/system-design.md`, `docs/INDEX.md`, `records/tasks.md`, `records/brainstorm.md` (status note only); CLAUDE.md `RecordLocked` row was already widened by the owner.

## 12. Task ordering (CLAUDE.md → Build order for a new module)
0. Contract edits R1-R10.
1. Generic additions with unit tests: `checkViolationConstraint`; four redaction keys + test rows; `/api/records` in `NO_STORE_PREFIXES` (own commit with its no-store test).
2. Migrations 2.1, 2.2, 2.3 (+ migration and `db-roles` tests).
3. `records` `enums.ts`, `errors.ts`, `types.ts`, `constants.ts`; consultations additions (`ConsultationParties`, `NewConsultation.followUpOfRecordId`, `ConsultationView.hasRecord`).
4. Entities; request DTOs; response DTOs (viewer-aware).
5. Repositories (`medical-records`, `medical-record-amendments`, `consultations.findParties`, `insertConsultation` follow-up column); `ConsultationRowsService.findParties`; `PatientsService.findProfile`.
6. `RecordLinksService`, `RecordsService`, `RecordQueriesService`; DI tokens and `bootstrap.ts` (links first); `hasRecord` in `ConsultationQueriesService` and `SessionQueriesService`; follow-up check in `ConsultationsService.book` (remove `FollowUpNotSupported`).
7. `policies.ts`; controller; `rate-limits.ts`; `routes.ts`; mount after the consultations router.
8. Tests (unit, integration, RBAC matrix, contract, concurrency, lock boundary, privacy, EXPLAIN).
9. Manual QA with CURL (`scripts/curl-test-records.sh`; local Identity fake for the booking fixtures), docs (section 11 list).

## 13. As-built notes (2026-10-18, version 0.2.0)
Built, tested and manually QA'd as specified (four routes, three migrations, `hasRecord`, follow-up link). Verification: unit 2988 passing, records integration green on an isolated PostgreSQL 18 cluster (real Postgres with `btree_gist`, real Redis), manual QA 359 pass / 0 fail ([manual-qa.md](./manual-qa.md)); the code review of 2026-10-18 04:32 was fixed (M1-M16) and re-verified clean, its file deleted. Contract and code agree on paths, roles, status codes, error codes and shapes (checked 2026-10-18; no contract edit was needed at `/update-docs`). Where the sections above and this list differ, **this list wins**.

**Behaviour as built (owner decisions of the fix-review, 1.6)**
1. **Create is assigned-doctor-or-404 (M1).** Resolver `record_write_consultation` returns `allow` only for the consultation's assigned doctor; every other caller (related or not, any consultation status, record-less or recorded) gets `404 NotFound` with the same body as an absent id. `NotAssignedDoctor` exists **only** on `PATCH /records/{id}` (a doctor with a `booked`/`waiting`/`in_progress`/`completed` relationship who is not the author). The creation-gate table in 3.6 therefore has no `NotAssignedDoctor` step (step 6 removed); the service re-reads the consultation in the transaction and maps a mismatch to `404` (unreachable while a consultation's doctor is immutable).
2. **A pre-lock no-op `PATCH` is audited (M3).** It returns `200` with the current record, writes no record row (`updated_at` unchanged) and no `record.updated` row, and writes exactly one `record.read` row in the same transaction (metadata `consultationId, patientUserId, viewerRole, viaNoopPatch: true`). This amends R-D7 and RC-R6; `x-audit-actions` of `updateMedicalRecord` is `[record.updated, record.amended, record.read]`.
3. **`reason` is validated whenever present (M16)**: 3..1000 code points, not blank, no NUL, also before the lock where it is otherwise ignored (a too-short pre-lock `reason` is `400`).
4. **Least-privilege `UPDATE` (M5).** `care_app` holds `SELECT, INSERT` plus a column-level `UPDATE (chief_complaint, examination_notes, diagnosis_text, diagnosis_code, treatment_plan, follow_up_in_days, updated_at)` on `medical_records`; any `UPDATE` of `id`, `consultation_id`, `patient_user_id`, `doctor_user_id`, `locked_at`, `created_at` or `deleted_at` fails with `42501`. Asserted by `has_column_privilege` tests and by the manual QA.
5. **Amendments are read in append order (M7).** `listByRecordIds` is `WHERE medical_record_id = ANY($1) ORDER BY id`; the index is `idx_medical_record_amendments_medical_record_id_id (medical_record_id, id)`. `created_at` is the transaction start and can invert under a double submit, ids are assigned after the record row lock.
6. **`hasRecord` is truthful on a booking replayed through the database idempotency path (M9)**: `ConsultationQueriesService.renderOwn` (used by book, reschedule and cancel) looks the row up in `RecordLinksService` only when it is `completed`. Get-one, list and the doctor calendar (`SessionQueriesService.render`) do one batched lookup over the `completed` rows only.
7. **Migrations edited in place before merge** (M5, M7): see 2.6 for the rollback-and-rerun note for databases that already ran the earlier files.
8. **Contract-only fixes M11-M16** (no behaviour change) are listed in 1.6 and applied.

**Divergences from the design text (none changes a contract shape)**
9. **Migration regex needs an escaped question mark.** `knex.raw` reads a bare `?` as a binding placeholder, so both migrations write the diagnosis-code quantifier escaped; the stored constraint is exactly the specified pattern (2.1 note).
10. **`records/rules.ts` added** (not in the 3.3 file list): the pure `providedFields` and `diffRecord` helpers (pre-lock no-op diff; audit field names). `RecordParties` (doctor and patient ids shared by the two write resolvers) is an extra type in `types.ts`.
11. **Repository names:** `findLiveIdByConsultationId` (returns the id) instead of `findLiveByConsultationId` in 3.5/3.6; `listTimelineQuery` and `listByRecordIdsQuery` are exported for the EXPLAIN tests.
12. **`MedicalRecordResponseDto.from` also refuses a patient viewer who is not the record's patient** (same guard as `PatientProfileResponseDto`), in addition to the admin refusal required in 3.1.
13. **`NO_RECORDS`**, the default `recordedIds` of `buildConsultationView`, is exported from `consultations/view.ts` so write responses and the waiting room share one constant.
14. **Existing tests changed because behaviour changed** (no new suites): `consultations.service.test.ts` (the `FollowUpNotSupported` test became follow-up tests; a records double is a new constructor argument), `consultation-queries.service.test.ts` and `session-queries.service.test.ts` (new `RecordLinksService` argument), `tests/integration/consultations.test.ts` (`followUpOfRecordId` is `404`, not `400`), `tests/integration/migrations.test.ts` (records migrations stepped down and up around `consultations`; the new FK is in the expected list; the constraint-name query excludes `contype = 'n'` because PostgreSQL 18 lists NOT NULL constraints in `pg_constraint`, the expected lists are unchanged), `tests/unit/lib/logger/redact.test.ts`, `tests/unit/lib/knex/pg-errors.test.ts`, `tests/integration/no-store.test.ts` (`/api/records` row).
15. **Test environment.** The suite ran against PostgreSQL 18 (an isolated native cluster, trust auth) and Redis db 14/12; `db-roles.test.ts` password-rejection cases need a password-authenticating server and `storage-adapter.test.ts` needs MinIO (both pre-existing and unrelated to records). Docker was not available during the QA run.
16. **FK error codes (2.5):** a `DELETE` of a record referenced by a follow-up consultation raises `23001` (`restrict_violation`), not `23503`; a dangling id on insert is `23503`.
17. **Stale comment, not a behaviour defect:** the doc comment above `RecordUpdateResult` in `src/app/records/types.ts` still says the `unchanged` result is "nothing written, nothing audited"; the code (and the contract) audit the no-op as `record.read` (decision 2). Source comments are outside the docs updater's remit; fix at the next code touch.
