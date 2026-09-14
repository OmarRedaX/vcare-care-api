---
title: Clinical Records
owner: care-team
service: care-service
status: draft
diataxis: explanation
last_verified: 2026-09-14
tags: [records, clinical, privacy, audit, attachments, amendments]
related: [consultation-lifecycle, rbac, data-model, future]
---

# Clinical Records

Medical records carry the strictest privacy rules on the platform. The rules below are Domain rules 13–16 and
19 plus CLAUDE.md → Privacy and logging.

## Creation gate
`POST /api/consultations/{id}/record` succeeds only when **all** hold, checked inside the write transaction:

| Check | Error |
|---|---|
| caller is a doctor with `status=active`, not locally suspended | 403 `Forbidden` |
| consultation visible to the caller | 404 `NotFound` |
| caller is the consultation's `doctor_user_id` | 403 `NotAssignedDoctor` |
| consultation `status='completed'` | 409 `RecordRequiresCompleted` |
| no live record for the consultation (`uq_medical_records_consultation_id`) | 409 `Conflict` |

Fields: chief complaint (required), examination notes, diagnosis text, ICD-10 diagnosis code, treatment plan,
follow-up interval in days. `patient_user_id` and `doctor_user_id` are copied from the consultation, never from
the body. Insert and `record.created` audit row are one transaction.

## 24-hour lock and amendments
- `locked_at = created_at + 24 h` (`NOT NULL`, `CHECK`-enforced).
- **Before the lock** `PATCH /api/records/{id}` updates in place → 200; each update writes `record.updated`.
- **After the lock** the same `PATCH` inserts a `medical_record_amendments` row (only the amended fields plus a
  required `reason`) → 201; the original row is untouched; `record.amended` is audited.
- Defence in depth: the service decides by `locked_at`, and the `trg_medical_records_forbid_update_after_lock`
  trigger rejects any `UPDATE` after the lock. The app role has no `UPDATE`/`DELETE` on amendments.
- Reads return the original plus amendments in chronological order; clients show the amended view with history.
  Nothing is ever silently overwritten.

## Attachments and signed URLs
- Upload: `multipart/form-data`, MIME allowlist `application/pdf`, `image/jpeg`, `image/png` verified by content
  sniffing, 10 MB cap, 20 uploads/hour per user, random object key (never the client filename), private bucket.
- Adding is allowed before and after the lock (it appends); **deleting** (soft) is allowed only before the lock,
  else `409 RecordLocked`.
- Download: `downloadUrl` is issued per read by `lib/signed-url` — HMAC-SHA256 over
  `(objectKey, viewerUserId, expiresAt)`, TTL ≤ 10 minutes (`SIGNED_URL_TTL_SECONDS=600`), bound to the viewer,
  only after the authorization check. **Issuing a URL is an audited clinical read** (`attachment.url_issued`).
- Object keys and signed URLs are never logged and never stored beyond the key.

## Who can read
| Viewer | Records | Patient profile clinical fields |
|---|---|---|
| Patient | own only | own only |
| Doctor | records of patients they have a `completed` or current consultation with (and records they authored) | same relationship |
| Admin | **never** — absent from every record route's roles | **never** — admin DTOs omit clinical fields |

Non-owners receive `404 NotFound` so existence cannot be probed. Patients never write record fields (Domain rule 16);
they maintain only their own demographics, allergies, chronic conditions, and timezone.

## Patient timeline
`GET /api/patients/{patientUserId}/records` returns, per page, the patient profile (allergies, chronic
conditions, blood type, date of birth) and records newest first with amendments and attachments. It is the
doctor's pre-consultation view (PRD 7.8) and the patient's own history (PRD 7.9). Every call is audited
(`patient_records.listed`) before the response is sent.

## Follow-up booking from a record
PRD 7.8 asks doctors to "book the follow-up directly from the record", while the permissions matrix allows only
patients to book. MVP resolves it without breaking RBAC:
1. The doctor sets `followUpInDays` on the record.
2. The patient's client shows a pre-filled booking (same doctor, a type, a slot window starting at
   `completedAt + followUpInDays`) from the record.
3. The patient books with `POST /api/consultations` including `followUpOfRecordId`; Care verifies the record
   belongs to this patient and this doctor and stores the link.
A doctor-initiated booking on the patient's behalf is a `/system-design` topic, not MVP.

## Audit
| Action | When | Transaction |
|---|---|---|
| `record.created`, `record.updated`, `record.amended` | writes | same transaction as the write |
| `attachment.added`, `attachment.removed` | attachment writes | same transaction |
| `record.read`, `attachment.url_issued`, `patient_records.listed`, `patient_profile.read`, `consultation.read` | reads | written before the response; **if the audit insert fails, the read fails (500)** |

Audit `metadata` holds ids, statuses, and reasons only — never clinical text, codes, or names. Logs never contain
record contents, complaint text, allergies, conditions, diagnosis text or code, object keys, or signed URLs.
Responses carry `Cache-Control: no-store`.

## Phase-2 AI boundary
Care guarantees the boundary the AI service must work within:
- AI-produced clinical artifacts (complaint parsing, pre-consultation summary, ICD-10 suggestions) are stored as
  **drafts** that the assigned doctor must confirm before they become part of a record.
- AI never diagnoses, prescribes, or decides treatment; red-flag symptoms escalate to a human immediately.
- The AI service authenticates with its own service client and scopes through Identity; it never reads Care's
  database and never uses a user token on `/internal/*`.
Draft storage and its endpoints are designed when Phase 2 starts ([future.md](./future.md)).
