---
title: Clinical Records
owner: care-team
service: care-service
status: draft
diataxis: explanation
last_verified: 2026-10-20
tags: [records, clinical, privacy, audit, attachments, amendments]
related: [consultation-lifecycle, rbac, data-model, future, file-handling, records-spec, record-attachments-spec]
---

# Clinical Records

Medical records carry the strictest privacy rules on the platform. The rules below are Domain rules 13–16 and
19 plus CLAUDE.md → Privacy and logging.

**Built (2026-10-18, `records` module, [spec](../records/spec.md)):** create, read, update-or-amend, the patient timeline,
`Consultation.hasRecord` and the follow-up link. **Built (2026-10-20, `record-attachments` module,
[spec](../record-attachments/spec.md)):** file attachments on a record (upload, audited download, soft delete before the
lock); `MedicalRecord.attachments` is the live metadata list.

## Creation gate
`POST /api/consultations/{id}/record` succeeds only when **all** hold. The order is fixed and the first failure wins; the
first three rows run before the transaction (`authorize` for rows 1–2, then the rate limiter, then the controller's body validation), the last two inside it:

| Check | Error |
|---|---|
| caller is a doctor with `status=active`, not locally suspended | 403 `Forbidden` |
| consultation exists and the caller is its `doctor_user_id` — **the resolver admits only the assigned doctor**; every other caller (a doctor with a relationship to the patient included, whatever the consultation status) gets the same body as an absent id | 404 `NotFound` |
| body validates (`chiefComplaint` 3..2000 required; optional text non-blank; `diagnosisCode` ICD-10 format only, no catalog; `followUpInDays` 1..365; unknown members and JSON `null` rejected) | 400 `ValidationFailed` |
| consultation `status='completed'` (read without a lock: `completed` is terminal) | 409 `RecordRequiresCompleted` |
| no live record for the consultation (`uq_medical_records_consultation_id`; the unique index is the guarantee under concurrency) | 409 `Conflict` |

`NotAssignedDoctor` is **never** returned by create: the timeline lists only consultations that already have a record, so a
`403` here would reveal which of a patient's consultations have none. It exists only on `PATCH` (below).

Fields: chief complaint (required), examination notes, diagnosis text, ICD-10 diagnosis code, treatment plan,
follow-up interval in days. `patient_user_id` and `doctor_user_id` are copied from the consultation, never from
the body. Insert and `record.created` audit row are one transaction. **No record route takes an `Idempotency-Key`**
(so no record text ever reaches the Redis replay store): a retried create after a lost response is `409 Conflict`, and the
doctor finds the record id in the patient timeline.

## 24-hour lock and amendments
- `locked_at = created_at + 24 h` (`NOT NULL`, `CHECK`-enforced), both set from the database's `NOW()` in the insert.
- The lock is decided with **database time under the row lock** (`FOR NO KEY UPDATE`, so a follow-up booking, whose foreign
  key takes `FOR KEY SHARE` on the record, never blocks a `PATCH`): `locked_at <= NOW()` means locked, the same clock the
  trigger uses. Node's clock never decides a lock.
- **Before the lock** `PATCH /api/records/{id}` updates only the fields whose value differs → 200; each update writes
  `record.updated` (changed field names). A request whose values all equal the stored ones is a **no-op**: 200 with the
  current record, no record write, and exactly one `record.read` audit row (the body discloses clinical text, so it is
  audited as a read). `reason` is validated (3..1000) but unused before the lock.
- **After the lock** the same `PATCH` inserts a `medical_record_amendments` row (only the amended fields plus a
  required `reason`) → 201, always (no diff against the effective value: an amendment is an explicit, reasoned act); the
  original row is untouched; `record.amended` is audited (ids, field names, `reasonLength`; never the text). A field
  cannot be cleared to null (`chk_medical_record_amendments_nonempty`; accepted MVP limitation).
- A `PATCH` needs at least one record field (`reason` alone is 400). Only the author may `PATCH`: a doctor who holds a
  relationship with the patient but did not write the record gets `403 NotAssignedDoctor`; an unrelated doctor gets 404.
- Defence in depth: the service decides by `locked_at`, and the `trg_medical_records_forbid_update_after_lock`
  trigger rejects any `UPDATE` after the lock (a soft delete included) with a `check_violation` that carries the trigger's
  name as the constraint; the service maps it to `409 RecordLocked`. The app role holds a **column-level** `UPDATE` on the
  six clinical columns and `updated_at` only (never `locked_at`, `created_at`, the ids or `deleted_at`), no `DELETE`/`TRUNCATE`
  on `medical_records`, and only `SELECT` plus a column-level `INSERT` on amendments (no `UPDATE`/`DELETE`).
- Reads return the original plus amendments **in append (id) order**; clients show the amended view with history.
  Nothing is ever silently overwritten.

## Attachments (built 2026-10-20 — the `record-attachments` module)
Full design: [file-handling.md](./file-handling.md) ([ADR 0013](../adr/0013-verified-direct-upload-lifecycle.md),
[ADR 0014](../adr/0014-on-demand-download-urls.md), [ADR 0022](../adr/0022-upload-intents-module.md)); rules and as-built
deviations: [record-attachments/spec.md](../record-attachments/spec.md) (section 14 wins).
- **Only the record's author** creates an intent, completes it and removes an attachment. Every other doctor (a consulting
  one included), an absent record and a non-numeric id are `404`; patients and admins are `403` at the role step; a locally
  suspended author is `403` (re-checked inside the `complete` transaction, after the storage round trip).
  `NotAssignedDoctor` is never returned on an attachment route.
- Upload: the author creates an intent (`POST /api/records/{id}/attachments/uploads`, 20/hour per user, optional clinical
  `description` of at most 500 code points), uploads directly to the private bucket with the presigned POST, then calls
  `…/uploads/{uploadId}/complete` (20/min per user, shared with delete). The `record_attachments` row and `attachment.added`
  are written **only after** Care verifies the stored object's size (1 B to 10 MB) and leading bytes (PDF, JPEG, PNG) — never
  the filename or a declared content type.
- **Cap:** a record holds at most 20 live attachments (`409 AttachmentLimitReached` on intent creation and `complete`); the
  guarantee is the count under the record row lock inside the `complete` transaction. A removed attachment frees a slot.
- Adding is allowed before **and after** the lock (it appends, with no reason; the audit row carries `afterLock`; it never
  updates `medical_records`). **Deleting** (soft; the stored object is kept) is allowed only before the lock, else
  `409 RecordLocked`, decided with database time under `FOR NO KEY UPDATE` and repeated by the trigger
  `trg_record_attachments_forbid_delete_after_lock`. A mistaken attachment added after the lock cannot be removed through the
  API; the remedy is an amendment that explains it.
- Download: record reads list attachment metadata only (`id, recordId, fileType, sizeBytes, description, createdAt`; one
  `= ANY` query per page, no extra audit row). Opening a file calls
  `POST /api/records/{id}/attachments/{attachmentId}/download-url` (120/min per user), which runs the record's read policy
  (admins never) and returns a presigned GET valid 60 s. **Issuing a URL is an audited clinical read**
  (`attachment.url_issued`, committed before the URL is signed); if the audit insert fails, no URL is issued.
- Object keys, descriptions and presigned URLs are never logged; no attachment route takes an `Idempotency-Key` (a response
  may hold a POST policy or URL, which must not sit in Redis).

## Who can read
| Viewer | Records | Patient profile clinical fields |
|---|---|---|
| Patient | own only | own only |
| Doctor | records of patients they have a `booked`, `waiting`, `in_progress` or `completed` consultation with (and records they authored) | same relationship |
| Admin | **never** — absent from every record route's roles | **never** — admin DTOs omit clinical fields |

Non-owners receive `404 NotFound` so existence cannot be probed (admins `403` at the role step, before any lookup; the one
non-admin `403` is `NotAssignedDoctor` on `PATCH`, toward a doctor who already sees that record id in the timeline). Patients
never write record fields (Domain rule 16); they maintain only their own demographics, allergies, chronic conditions, and
timezone.

**A locally suspended doctor** is blocked from every record write (`403 Forbidden`, the `doctor_not_suspended` check) and
gets `404` on `GET /records/{id}` and the timeline — including records they authored (the resolver folds the suspension into
ownership). The patient and the other consulted doctors still read those records. This deliberately differs from
`GET /patients/{id}`, which answers `403` to a suspended doctor.

## Patient timeline
`GET /api/patients/{patientUserId}/records` returns, per page, the patient profile (allergies, chronic
conditions, blood type, date of birth) and records newest first (`created_at DESC, id DESC` keyset) with their amendments;
each record carries its live `attachments` metadata (one extra `= ANY` query per page, none for an empty page). `data.patient` repeats on every page and is **`null`** when the patient
has no profile row yet (booking needs none). The amendments of a page are loaded by one `= ANY($1)` query. It is the
doctor's pre-consultation view (PRD 7.8) and the patient's own history (PRD 7.9). Every call writes exactly one
`patient_records.listed` audit row (entity type `patient_records`, entity id = the patient's Identity user id, also for an
empty page) before the response is sent; no extra `patient_profile.read` row.

## Follow-up booking from a record (built)
PRD 7.8 asks doctors to "book the follow-up directly from the record", while the permissions matrix allows only
patients to book. MVP resolves it without breaking RBAC:
1. The doctor sets `followUpInDays` on the record.
2. The patient's client shows a pre-filled booking (same doctor, a type, a slot window starting at
   `completedAt + followUpInDays`) from the record.
3. The patient books with `POST /api/consultations` including `followUpOfRecordId`; Care verifies, inside the booking
   transaction, that the record is live, belongs to the caller (from the token) and was written by the chosen doctor, and
   stores the link (`fk_consultations_follow_up_of_record_id`). A missing, foreign, other-doctor or deleted record is the same
   `404 NotFound`. Ownership only: no timing or `followUpInDays` check.
A doctor-initiated booking on the patient's behalf is a `/system-design` topic, not MVP.

`Consultation.hasRecord` is true when a live record exists for the consultation (a boolean, emitted to every viewer, no
content). It is resolved with one batched lookup per page over the `completed` rows only; write responses are `false` by
construction, except a booking replayed from the database idempotency key, which looks the row up when it is `completed`.

## Audit
| Action | When | Transaction |
|---|---|---|
| `record.created`, `record.updated`, `record.amended` | writes | same transaction as the write |
| `attachment.added`, `attachment.removed` | attachment writes (`complete`, `DELETE`) | same transaction |
| `record.read` (also written by a pre-lock no-op `PATCH`), `patient_records.listed`, `patient_profile.read`, `consultation.read`; `attachment.url_issued` | reads | written before the response; **if the audit insert fails, the read fails (500)** |

Audit `metadata` holds ids, statuses, and reasons only — never clinical text, codes, or names. Logs never contain
record contents, complaint text, allergies, conditions, diagnosis text or code, object keys, or presigned URLs.
Responses carry `Cache-Control: no-store`.

**Idempotency replay records (accepted retention).** The Redis idempotency middleware stores the full success response of a
write for 24 h so a retry replays it byte-for-byte. For `POST /consultations` (and reschedule/cancel) that response includes
`complaintText` (and `cancelReason`), so clinical text lives in Redis for up to 24 h beyond the clinical store. Accepted: the
record is TTL-bound, in the same trust zone as the database, never logged, and keyed per principal. The middleware is not
changed for this; do not add a new route that returns clinical text under `idempotency(...)` without recording the same
retention here. Pinned by a test in `tests/integration/consultations-rules.test.ts`. The record routes are deliberately **outside** this
retention: none sits behind `idempotency(...)`, and `records-privacy.test.ts` scans Redis for the record fixtures.

## Phase-2 AI boundary
Care guarantees the boundary the AI service must work within:
- AI-produced clinical artifacts (complaint parsing, pre-consultation summary, ICD-10 suggestions) are stored as
  **drafts** that the assigned doctor must confirm before they become part of a record.
- AI never diagnoses, prescribes, or decides treatment; red-flag symptoms escalate to a human immediately.
- The AI service authenticates with its own service client and scopes through Identity; it never reads Care's
  database and never uses a user token on `/internal/*`.
Draft storage and its endpoints are designed when Phase 2 starts ([future.md](./future.md)).
