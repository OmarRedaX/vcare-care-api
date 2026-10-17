---
title: records — Brainstorm
owner: care-team
service: care-service
module: records
status: draft
diataxis: explanation
last_verified: 2026-10-17
tags: [brainstorm, records, clinical, amendments, timeline, follow-up]
related: [system-design, clinical-records, consultation-lifecycle, data-model, rbac, sessions-brainstorm, consultations-brainstorm, patients-brainstorm]
---

# records — Brainstorm

Scope decided 2026-10-17 (branch `feature/records`, from `main` @ b92607d). Fifth lifecycle slice after
patients → consultations → notifications → sessions. The design already exists in
[clinical-records.md](../architecture/clinical-records.md) and the contract (`createMedicalRecord`, `getMedicalRecord`,
`updateMedicalRecord`, `listPatientRecords`), so this brief decides **slicing and the open edges**, not new shapes.
Nothing could reach `completed` before `sessions`; with it merged, `records` is unblocked. It is also the prerequisite for
three Phase-2 capabilities: ICD-10 coding writes `diagnosis_code`, the pre-consultation summary reads the timeline, and
both need the draft-confirm boundary to have a stable record to confirm into.

## Problem & purpose
PRD 7.8 (medical records), 7.9 (patient history), and Domain rules 13–16, 18–19, 22. A doctor records the clinical
outcome of a **completed** consultation; the record is editable for 24 h, then append-only via amendments; the patient
reads their own history; consulted doctors read the timeline before a visit. Admins never see any of it.

## Actors
- **Doctor** (active, **not locally suspended**): `POST` the record for their own completed consultation; `PATCH` it
  (in place before the lock, amendment after); read records and the timeline of patients they hold a
  `booked | waiting | in_progress | completed` consultation with.
- **Patient** (active): read own records and own timeline; never write a clinical field. Books a follow-up carrying
  `followUpOfRecordId`.
- **Admin**: absent from every record route (`403 Forbidden`); admin DTOs omit clinical fields.
- **Service** (Phase-2 AI): none in this iteration; no `/internal/*` record endpoint.

## In scope (this iteration)
1. `medical_records` and `medical_record_amendments` migration (DDL per data-model.md), the `forbid_update_after_lock`
   trigger, grants (`SELECT, INSERT, UPDATE` on records; `SELECT, INSERT` only on amendments), and
   **`fk_consultations_follow_up_of_record_id`** (the FK deferred by the consultations migration).
2. `POST /api/consultations/{id}/record` — creation gate per clinical-records.md; no `Idempotency-Key` (R-D4).
3. `GET /api/records/{id}`.
4. `PATCH /api/records/{id}` — `200` in place before `locked_at`, `201` amendment after; `reason` required for an amendment.
5. `GET /api/patients/{patientUserId}/records` — keyset-paginated timeline, newest first, with the patient profile on
   every page (the route the `patients` unit deliberately did not mount).
6. `Consultation.hasRecord` becomes true (consultations C9) and `followUpOfRecordId` is accepted on
   `POST /api/consultations` (consultations C6): ownership check, link stored (R-D3).
7. Audit for every route (see Privacy & audit); `Cache-Control: no-store`; log redaction for the new clinical keys.

## Out of scope
- **Attachments** — the whole `record_attachments` surface (uploads, `complete`, `download-url`, `DELETE`) ships as the
  next module, **`record-attachments`** (R-D1). In this module `attachments` is always `[]` on the record DTO.
- Phase-2 AI drafts (complaint parse, summary, ICD-10 suggestions), draft storage and any `/internal/*` read endpoint.
- Doctor-initiated follow-up booking on a patient's behalf (a `/system-design` topic; MVP is patient-books-from-record).
- An ICD-10 catalog or validation of the code against real codes (R-D2).
- Record deletion endpoints (soft delete exists in the schema; no route, hard delete never exposed).
- Notifications about records (PRD 7.11 lists none).
- Clearing a field through an amendment (see Open questions).

## Key entities & relationships
- **MedicalRecord** — one live row per consultation (`uq_medical_records_consultation_id`, partial on `deleted_at IS NULL`);
  `patient_user_id` and `doctor_user_id` copied from the consultation, never from the body; `locked_at = created_at + 24 h`
  (CHECK + trigger).
- **MedicalRecordAmendment** — append-only (no `UPDATE`/`DELETE` grant), carries only the amended fields plus a required
  `reason`; at least one amended field (CHECK).
- **Consultation** — gains the FK `follow_up_of_record_id → medical_records(id) ON DELETE RESTRICT` and a true
  `hasRecord`.
- Reads reuse the `PatientRelationshipChecker` port that `consultations` already binds (`TOKENS.PatientRelationship`).

## Primary flows / endpoints (with roles + ownership)
| Route | Roles | Ownership | Result | Audit |
|---|---|---|---|---|
| `POST /consultations/{id}/record` | doctor | assigned doctor | `201` record | `record.created` (same tx) |
| `GET /records/{id}` | patient, doctor | own / author / consulted doctor; else `404`; admin `403` | `200` record + amendments | `record.read` (before response) |
| `PATCH /records/{id}` | doctor | author = assigned doctor | `200` in place **or** `201` amendment | `record.updated` / `record.amended` (same tx) |
| `GET /patients/{id}/records` | patient, doctor | self / consulted doctor; else `404` | `200` page: profile + records, newest first | `patient_records.listed` (before response) |
| `POST /consultations` + `followUpOfRecordId` | patient | own consultation | link stored | existing `consultation.booked` |

Creation gate and error codes: `403 Forbidden` (wrong role, inactive or suspended doctor), `404 NotFound`,
`403 NotAssignedDoctor`, `409 RecordRequiresCompleted`, `409 Conflict` (a live record exists).

## Business rules & state transitions
- Rule 13: record only for `completed`; one live record per consultation. Rule 14: only the assigned doctor writes.
- Rule 15: before `locked_at` update in place (each update audited); after it the same `PATCH` inserts an amendment, the
  original is never touched. The service decides by `locked_at`; the trigger rejects any later `UPDATE` as defence in depth.
  The lock boundary is evaluated inside the write transaction with database time.
- Rule 16: patients never write clinical fields. Rule 18/19: doctors read patients they consulted; admins never.
- `diagnosisCode` is **format-checked only** (`^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$`, ≤ 16); Care holds no catalog (R-D2).
- `followUpInDays` 1–365. The value is a client pre-fill hint only (R-D3).
- **Suspended doctors** (local `suspended_at`): `403` on every record write, `404` on record and timeline reads of other
  patients' data (R-D5). Their authored records stay readable by the patient and by other consulted doctors.
- Follow-up link: `followUpOfRecordId` must reference a live record whose `patient_user_id` is the caller and whose
  `doctor_user_id` is the chosen doctor; otherwise `404 NotFound` (not `400`, so record existence is not probed).
  No check on `followUpInDays` or timing.

## Cross-service touchpoints (case, direction, failure policy)
None new. Identity is not called by any record route; record DTOs carry user ids only (no names), so there is no
hydration and no Case 2 degrade. The only cross-module touch is `consultations` (relationship port, `hasRecord`,
follow-up link) inside Care. Phase-2 AI integration is deliberately not designed here.

## Privacy & audit
- Every record write is audited **in the same transaction**; every read (`record.read`, `patient_records.listed`) is
  audited **before** the response and **fails the read (500)** if the audit insert fails. A `404` writes no audit row.
- Audit `metadata` holds ids, statuses, changed field *names*, and the amendment id — never clinical text or codes.
- Logs never contain chief complaint, notes, diagnosis text or code, treatment plan, or amendment `reason`; add the new
  keys to `lib/logger/redact.ts` and cover them in a log-hygiene integration test (as `sessions` did).
- `Cache-Control: no-store` on every record response. Non-owners get `404`, never `403` (except admins: `403`).
- **No `Idempotency-Key` on any record route** (R-D4), so no record text enters the Redis replay store.
- Accepted-by-design (CLAUDE.md RBAC): any doctor holding a `booked | waiting | in_progress | completed` consultation with a
  patient reads that patient's **whole** timeline, including other doctors' records. Cancelled and no-show rows grant nothing.

## Constraints & guideline notes
- Raw SQL migration, Knex query builder, no ORM; one explicit transaction per write (ADR 0017); app role is `care_app`,
  members of `vcare_app`, with explicit grants (ADR 0018). New migration timestamps after `20261015120100`.
- Keyset pagination on `(created_at DESC, id DESC)` using `idx_medical_records_patient_user_id_created_at_id`; the amendments
  load is one `WHERE medical_record_id = ANY($1)` per page (no N+1). Performance budget per CLAUDE.md; add query-plan
  assertions like `sessions` did.
- Layering and build order per CLAUDE.md "Build order for a new module"; register service and controller in `container.ts`,
  mount in `src/routes.ts`. Use `rbac-ownership-guard` for the four policies.
- Rate limit the write routes (record create/patch) like the other doctor clinical writes; exact numbers are a spec decision.
- Slicing decision R-D1: **`records` now, `record-attachments` next**, each with its own brainstorm→spec→build cycle.

## Contract changes expected
In `contracts/openapi.yaml` (contract lands first, then re-sync to the hub):
1. `createMedicalRecord`: remove `IdempotencyKeyOptional` and the `422 IdempotencyConflict` response (R-D4).
2. `getMedicalRecord`: summary/description no longer say "signed attachment URLs" (ADR 0014: DTOs never embed URLs).
3. `MedicalRecord.attachments`: keep the field; items are `RecordAttachment`. The current `RecordAttachment` schema still has
   `downloadUrl`/`downloadUrlExpiresAt`; **leave the schema for `record-attachments`** but note the field is always `[]` here.
4. `listPatientRecords`: `PatientTimeline` is the `data`; the pagination `meta` already exists. Confirm the `404`/`403`
   split in the responses (admin `403`, non-owner `404`).
5. `POST /api/consultations`: `followUpOfRecordId` stops returning `400` (lifts consultations C6); `Consultation.hasRecord`
   is now truthful (lifts C9). Document the `404 NotFound` for a foreign or missing record.
6. Add the suspended-doctor reads rule (R-D5) to `x-account-state` on `getMedicalRecord` and `listPatientRecords`.
The attachment operations (`multipart` add, inline URLs) are **not** touched here; `record-attachments` rewrites them to
the intent → `complete` → `download-url` shape (file-handling.md §2).

## Open questions
1. **Amendment cannot clear a field.** The amendments CHECK needs at least one non-null amended field, so an amendment can
   change `treatmentPlan` but cannot null it out. Accept for MVP (the original is never erased anyway)? Default: yes, note it
   in the spec.
2. **`PATCH` before the lock with an empty effective change** (all values equal to current): no write and no audit row (as
   `patients` P-R8), or still `200`? Default: no-op, no audit.
3. **`PATCH` on a lock boundary race** — a request that straddles `locked_at`: decided by `NOW()` inside the transaction,
   and the trigger turns a missed race into a clean `409 RecordLocked`-style error or retry? Spec to decide the exact code.
4. **Rate limits** for record create/patch and the timeline read (the contract has `429`; numbers are unset).
5. **Timeline `data.patient` for a doctor viewer** reuses the patient profile DTO with clinical fields for consulted
   doctors (as `GET /patients/{id}` already does); confirm it also repeats on every page without an extra audit row.
6. **Platform changes needed (hub, not edited here):** none for the contract-only changes above; after build, re-sync the
   care card and contract. Phase-2 follow-ups stay in hub `TODO.md`.

## Success criteria
- A doctor writes a record for their own completed consultation; every other combination returns the documented code.
- Exactly one live record per consultation, including under concurrent creates (the second gets `409 Conflict`).
- Before 24 h `PATCH` updates in place and audits `record.updated`; after 24 h it inserts an amendment, leaves the original
  byte-for-byte unchanged, and audits `record.amended`; the DB trigger independently rejects a late `UPDATE`.
- Admins get `403` on all four record routes; a stranger gets `404`; a suspended doctor is refused as decided in R-D5.
- The timeline paginates newest first with amendments, one query for amendments per page, within the performance budget.
- A patient books a follow-up from a record (ownership only); a foreign record id returns `404`; `hasRecord` is true.
- No clinical text appears in logs, audit metadata or Redis; an audit-insert failure fails the read.
- Contract, tests (unit, integration, RBAC matrix, conformance), manual QA and docs are done before `record-attachments` starts.

## Decisions recorded 2026-10-17
| Id | Decision |
|---|---|
| R-D1 | Two modules: `records` (this brief) then `record-attachments`. |
| R-D2 | `diagnosisCode` is format-validated only; no catalog in Care (the Phase-2 AI service owns retrieval). |
| R-D3 | `followUpOfRecordId`: ownership (patient + doctor + live record) only; no timing or `followUpInDays` check. |
| R-D4 | No `Idempotency-Key` on any record route; the partial unique index makes a retry a `409 Conflict`. |
| R-D5 | A locally suspended doctor is blocked from all record writes and from reading other patients' records/timeline. |
