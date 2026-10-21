---
title: record-attachments — Brainstorm
owner: care-team
service: care-service
module: record-attachments
status: approved
diataxis: explanation
last_verified: 2026-10-18
tags: [brainstorm, record-attachments, records, attachments, uploads, object-storage, clinical-privacy]
related: [system-design, records-spec, records-brainstorm, file-handling, clinical-records, data-model, rbac, adr-0013-verified-direct-upload-lifecycle, adr-0014-on-demand-download-urls, adr-0015-aws-sdk-storage-adapter, verification-spec, adr-0021-identity-sync-engine-module]
---

# record-attachments — Brainstorm

Second half of the clinical record (decision R-D1 of the [records brainstorm](../records/brainstorm.md)): files a doctor attaches to a
medical record. The design is already decided at architecture level ([file-handling.md](../architecture/file-handling.md), ADRs 0013, 0014, 0015,
hub ADR 0011); `verification` built the same lifecycle for doctor documents. This brief decides what is **new**: how the machinery is shared,
who may touch the write surface, the lock rules, and the numbers. Binding sources: CLAUDE.md → "Security rules", "Privacy and logging",
"Database rules", "Domain rules" 13-16, 19; [records spec](../records/spec.md) 1.6 and section 13.

## Problem & purpose
A doctor needs to attach a lab scan, an image or a PDF report to the record they wrote (PRD 7.8). Files are clinical data of the strictest
class: they must never pass through `care-api` as bytes, never get a permanent or public link, never be trusted by name or declared type, and
every access must be audited. `MedicalRecord.attachments` is `[]` today, and the contract still describes the superseded multipart upload with
inline signed URLs.

## Actors
- **Doctor (author of the record):** adds and (before the lock) removes attachments; reads them.
- **Patient (record owner) and consulted doctors:** list attachment metadata with the record and open a file through `download-url`.
- **Admin:** nothing. `403` on every attachment route at the role step; no admin DTO form.
- **Object storage (private bucket) and `care-worker`:** the storage port already exists; the worker purge loop already exists but is
  verification-only today.

## In scope (this iteration)
- `record_attachments` migration (table, constraints, index, **column-level** grants per ADR 0018, a lock guard trigger on delete, section "Business rules").
- Upload lifecycle for record attachments: `POST …/attachments/uploads` (intent) → direct presigned POST to `quarantine/<uuid>` → `POST …/uploads/{uploadId}/complete`
  (`HEAD` size 1 B–10 MB, 16-byte magic-number check for PDF/JPEG/PNG, ETag-bound promote, row created only after the checks pass).
- `POST …/attachments/{attachmentId}/download-url`: authorize, audit **before** issuing, presigned GET 60 s, `attachment` disposition, verified content type.
- `DELETE …/attachments/{attachmentId}`: soft delete before the lock, `409 RecordLocked` after it.
- `MedicalRecord.attachments` becomes real: metadata only (no URL, no key), one batched query per page (record view and timeline).
- **Extraction of the shared `upload-intents` module** out of `verification` (decision RA-D1) with verification's behaviour unchanged.
- Rate limit 20 uploads/hour per user on intent creation; audit actions `attachment.added`, `attachment.removed`, `attachment.url_issued`.
- RBAC: author writes; patient owner and consulted doctors read; admins `403`.
- Contract rewrite of the old multipart/inline-URL operations; docs.

## Out of scope
- Phase-2 AI (drafts, extraction from files), antivirus / deep PDF scanning (`attachment.quarantined` is the designed later hook, file-handling §4), thumbnails or previews.
- Record deletion or erasure; erasure of a stored file (owner-run procedure, RA-D4).
- Patient-uploaded files; attachments on anything but a medical record; editing an attachment's description; attaching to an amendment.
- File types beyond PDF/JPEG/PNG; files over 10 MB; bulk or multipart-chunk upload.
- Anything in `records` beyond wiring attachments into its read DTOs and the `record.read` response; `verification` behaviour changes (only its internals move, RA-D1).
- A reconciliation scan for orphan final objects (same stance as verification: best-effort cleanup plus the bucket lifecycle).

## Key entities & relationships
- `record_attachments` (new): `id`, `medical_record_id` (FK, `ON DELETE RESTRICT`), `uploaded_by_user_id` (Identity user id, no FK; always the record's author),
  `object_key` (`record-attachments/<uuid>`, unique, never a URL, never logged), `file_type` (detected: `application/pdf|image/jpeg|image/png`),
  `size_bytes` (1..10485760, the `HEAD` size), `description` (≤ 500, nullable), `created_at`, `deleted_at`. DDL in [data-model.md](../architecture/data-model.md).
- `upload_intents` (exists, kind `record_attachment` already allowed): `target_id` = `medical_records.id`, `owner_user_id` = the author, `description` carried to the row, 15 min, single use.
- `medical_records` (exists): the lock (`locked_at`, database time) and the row lock the attachment writes serialise on.
- Audit: entity type `record_attachment`, entity id = attachment id (`attachment.url_issued` and `attachment.removed` also carry `recordId`).

## Primary flows / endpoints (with roles + ownership)
All under `userGuard()` → `authorize(policy)` → limiter → controller; `Cache-Control: no-store`; non-numeric ids `404`; no `Idempotency-Key` (RA-D8).

| Route | Roles | Ownership (resolver) | Account state | Success / errors | Audit |
|---|---|---|---|---|---|
| `POST /api/records/{id}/attachments/uploads` | doctor | `record_attachment_writer`: record live **and** caller is its author, else `404` (RA-D2) | active + not locally suspended (`403 Forbidden`) | `201 UploadIntent`; 400 (body), 404, 409 `AttachmentLimitReached`, 429 | none (no clinical row) |
| `POST /api/records/{id}/attachments/uploads/{uploadId}/complete` | doctor | same resolver; intent must be `kind=record_attachment`, owned by the caller, `target_id` = path record, else `404` | same | `201 RecordAttachment`; `200` replay; 400 `ValidationFailed` (`field: file`); 404; 409 `Conflict` / `AttachmentLimitReached`; 410 `UploadIntentExpired`; 429 | `attachment.added` (clinical-write), same transaction as the insert |
| `POST /api/records/{id}/attachments/{attachmentId}/download-url` | patient, doctor | reuses `record_reader` (patient owner, author, or consulted doctor not locally suspended); the attachment must be live and belong to the record, else `404` | active; suspended doctor `404` (R-D5) | `200 DownloadUrl {url, expiresAt}`; 404; 429; **audit failure → 500, no URL** | `attachment.url_issued` (clinical-read) |
| `DELETE /api/records/{id}/attachments/{attachmentId}` | doctor | `record_attachment_writer` | active + not suspended | `204`; 404 (also when already deleted); `409 RecordLocked` after the lock; 429 | `attachment.removed` (clinical-write) |

Read side: `GET /api/records/{id}` and `GET /api/patients/{id}/records` embed `attachments[]` (`id, recordId, fileType, sizeBytes, description, createdAt`, oldest first, live rows only).
They add **one** `= ANY` query per page and no new audit row (the attachment list is part of the record read already audited as `record.read` / `patient_records.listed`).

## Business rules & state transitions
1. **Only the record's author writes** (RA-D2). A related doctor who is not the author, a patient, an unrelated doctor and a nonexistent record are indistinguishable (`404`); `NotAssignedDoctor` is **not** used on any attachment route and stays on `PATCH /records/{id}` only.
2. **Upload is intent → quarantine → verified complete** (ADR 0013): the row exists only after `complete` read the stored object (`HEAD` 1 B–`max_bytes`, 16-byte sniff, ETag-bound `promote`). Filename and declared `Content-Type` are never read. A failed check deletes the quarantine object, closes the intent and answers `400 ValidationFailed`. A replayed `complete` returns the created row (`200`).
3. **Adding is allowed before and after the lock** and needs no extra reason (RA-D3). The `attachment.added` row carries `afterLock` (boolean, from database time). Adding never updates `medical_records` (the lock trigger would refuse any `UPDATE` after the lock).
4. **Deleting is allowed only before the lock** (domain rule 15). Under `FOR NO KEY UPDATE` on the record row the service reads `locked_at <= NOW()` (transaction database time, the records-module pattern) → `409 RecordLocked`; a `BEFORE UPDATE` trigger on `record_attachments` repeats the check against the parent's `locked_at` and a `check_violation` maps to `409 RecordLocked` (defence in depth, as records R-D8). Order: attachment absent/foreign/already deleted `404` before locked `409`.
5. **Soft delete keeps the object** (RA-D4): only `deleted_at` is set; the object stays under `record-attachments/<uuid>` and is unreachable through the API. Any real erasure is an owner-run procedure, like record erasure.
6. **Cap of 20 live attachments per record** (RA-D5). Checked at intent creation (courtesy) and again inside the `complete` transaction under the record row lock (the guarantee); over the cap → `409 AttachmentLimitReached`. A soft-deleted attachment frees a slot.
7. **Download is authorize → audit → issue.** The audit insert is in its own transaction before the URL is returned; a failed insert fails the request (`500`, no URL). One audit row per issued URL, never one per record read. A soft-deleted or foreign attachment is `404` and writes no audit row.
8. **Re-authorization at `complete`:** record live, caller still the author, not locally suspended (`403 Forbidden`), intent still open and unexpired. An intent created before the lock may complete after it (rule 3).
9. `uploaded_by_user_id` equals the record's `doctor_user_id` by construction (only the author writes); it is stored for audit, not exposed.

## Cross-service touchpoints (case, direction, failure policy)
None. No Identity call, no Case 1-4, no hydration: attachment DTOs carry ids only. External dependency is object storage through `lib/storage` (the existing port; no new method, no
new dependency, ADR 0015). Storage failures: intent creation and `download-url` presigning are local computation; `complete` follows the verification policy (storage error → `500`,
intent stays open and retryable, 2 s timeouts, 10 s copy). Storage outage never affects reading a record (the list is database-only).

## Privacy & audit
- Files are clinical data: object keys, presigned URLs and POST fields are never logged, audited or stored beyond the key; read DTOs never carry a URL (ADR 0014).
- `description` is treated as clinical free text (it can say "MRI left knee"): never in audit metadata, logs or Redis; spec adds it to the redaction defence (bare-key conflict with other modules to be checked, section "Open questions").
- Audit actions (same transaction as the write, or before the response for the read; failing audit fails the operation): `attachment.added` (`recordId, fileType, sizeBytes, afterLock`),
  `attachment.removed` (`recordId`), `attachment.url_issued` (`recordId, viewerRole, viewerIsAuthor`). Metadata holds ids, types, sizes, flags only; no 404/403/400/409 writes a row.
- Admins: `403` on all four routes; verification-style admin download does **not** exist for attachments.
- No Redis for any of this beyond rate-limit counters (no idempotency middleware: it would store responses holding POST policies or URLs).
- Logs on these routes carry ids, statuses and the route pattern; the metric `upload_verification_failed` gains a `kind` label.

## Constraints & guideline notes
- **RA-D1 shared intent module.** New `src/app/upload-intents/` (precedent: ADR 0021) owns intent insert/find/close/purge, the per-intent session advisory lock, and a **domain-free verify-and-promote** step (`HEAD`, range read, `detectFileType`, ETag-bound `promote`, quarantine delete, failure metric). `verification` and `record-attachments` supply only target authorization, final key prefix and the row insert. The purge loop covers both kinds. Done as a **behaviour-preserving refactor first** (verification unit, integration and manual-QA suites green before any attachment code), needs a short ADR (0022).
- Layering: `record-attachments` is a new module (`src/app/record-attachments/`) and does not extend `records` services; it reads the record only through a records service API (`RecordLinksService.findAccessRow`-style, extended if needed), never `medical-records.repo`. `records` gets attachments through a `RecordAttachmentsService` batch call in its read DTOs (no cycle: `record-attachments` depends on `records` only for the lock/author lookup, so the lookup lives in `RecordLinksService`, which has no dependency on either).
- Transactions: `complete` does storage work outside any transaction, then one short transaction (intent lock, record `FOR NO KEY UPDATE`, cap count, insert, audit, close intent); a rolled-back transaction deletes the promoted object best-effort (verification precedent).
- Grants (ADR 0018, column level): `record_attachments` `SELECT`; `INSERT (medical_record_id, uploaded_by_user_id, object_key, file_type, size_bytes, description)`; `UPDATE (deleted_at)` only; sequence `USAGE`; no `DELETE`, no `TRUNCATE`. Clinical table: no `ON DELETE CASCADE`.
- Rate limits (per user): intent creation **20/hour** (given); `complete` and `DELETE` 20/min write bucket; `download-url` 120/min read bucket (RA-D9, same numbers as the records and verification buckets).
- No new env variable (`UPLOAD_POLICY_TTL_SECONDS`, `UPLOAD_INTENT_TTL_SECONDS`, `DOWNLOAD_URL_TTL_SECONDS`, `UPLOAD_INTENT_PURGE_SECONDS` exist); no new runtime dependency; `/api/records` is already in `NO_STORE_PREFIXES`.
- Tests reuse `tests/helpers/fake-storage.ts` for route tests; the MinIO adapter suite is unchanged (no adapter change). The upload-bytes scenarios from CLAUDE.md → "Testing policy" apply to this module (non-PDF/JPEG/PNG bytes behind a `.pdf` name and `application/pdf` type rejected with no row; expired/closed/another user's intent; replayed `complete`; every `download-url` writes one audit row; admins `403`).

## Contract changes expected
Applied first in `contracts/openapi.yaml` (step 0), then mirrored to the hub copy by the sync:
- **C1** remove `addRecordAttachment` (multipart) and `RecordAttachmentUpload`; add `createRecordAttachmentUploadIntent`, `completeRecordAttachmentUpload`, `getRecordAttachmentDownloadUrl` (schemas `UploadIntent`, `DownloadUrl` and response `UploadIntentExpired` already exist from verification).
- **C2** `RecordAttachment`: drop `downloadUrl` / `downloadUrlExpiresAt` from properties and `required`.
- **C3** `MedicalRecord.attachments`: description "live attachments, metadata only, oldest first" (no longer "always `[]`"); `getMedicalRecord` and `listPatientRecords` descriptions mention the batched list.
- **C4** `deleteRecordAttachment`: `x-audit-actions`, `404` also for already deleted, `403` is plain `Forbidden` (role, suspension), `409 RecordLocked`, rate limit line; `x-ownership` text "record author".
- **C5** new error `AttachmentLimitReached` (409) response and CLAUDE.md → "Error codes owned by Care" row (owner edit).
- **C6** `x-roles`, `x-ownership`, `x-account-state`, `x-audit` on the new operations; `Cache-Control: no-store`; rate-limit prose lines (20 uploads/h, 20/min, 120/min); admin `403` stated.
- Docs to refresh at `/update-docs`: `architecture/file-handling.md` (§2 table, `NotAssignedDoctor` row removed), `clinical-records.md` (attachments section), `data-model.md`, `api.md`, `rbac.md`, `service-card.md`, `INDEX.md`, `records/spec.md` (attachments no longer `[]`); a new ADR 0022 for RA-D1.
- Hub: none expected (no cross-service call, no new owner, no runtime component). Capacity check (per-record storage bound = 20 × 10 MB) is a `/construct-spec` verification against `capacity.md`.

## Decisions (this brainstorm)
| ID | Decision | Source |
|---|---|---|
| RA-D1 | Extract the shared `upload-intents` module from `verification`; behaviour-preserving refactor lands first; ADR 0022 | owner, 2026-10-18 |
| RA-D2 | Attachment write routes are author-or-`404`; `NotAssignedDoctor` is never returned on attachment routes | owner, 2026-10-18 |
| RA-D3 | Adding after the lock is allowed as-is (no reason), audited with `afterLock` | owner, 2026-10-18 |
| RA-D4 | Soft delete keeps the stored object; erasure is an owner-run procedure | owner, 2026-10-18 |
| RA-D5 | Cap of 20 live attachments per record, `409 AttachmentLimitReached` (number proposed by the assistant; owner accepted) | owner, 2026-10-18 |
| RA-D6 | Delete-after-lock is also guarded by a database trigger reading the parent's `locked_at`; `check_violation` → `RecordLocked` | default (records R-D8 precedent), owner may override |
| RA-D7 | Record DTOs embed attachment metadata via one batched query per page; no extra audit row for the list | default (ADR 0014, N+1 rule) |
| RA-D8 | No `Idempotency-Key` on attachment routes; `complete` is naturally replayable via `result_id` | default (R-D4 extended; Redis must not hold POST policies) |
| RA-D9 | Limits: intents 20/h; `complete` + `DELETE` 20/min; `download-url` 120/min; all per user | default |
| RA-D10 | `description` is clinical free text (never in logs/audit/Redis); optional, same text rules as record fields (not blank, no NUL, ≤ 500 code points) | default |

## Open questions
**Status (2026-10-18): approved by the owner; the owner told the assistant to take its recommendation on every open question below. Resolutions are inline as "Resolved"; the spec folds them in.**

1. **Confirm the defaults RA-D6 to RA-D10.** *Resolved: accepted as written.*
2. **Redaction key for `description`:** a bare `description` key may collide with non-clinical modules (consultation types, help articles). The spec decides between a scoped key such as `attachmentDescription` in `redact.ts` or relying on "bodies and metadata are never logged" plus a test. Needs a grep of `REDACTED_KEYS` and current log call sites. *Resolved: do not add a bare `description` key; add the scoped key `attachmentDescription` to `redact.ts` (with a test row) and prove the rest with a privacy test (marker string in `description`; logs, audit metadata, Redis and error bodies must not contain it). The spec still greps `REDACTED_KEYS` and log call sites to confirm no logged object carries a bare attachment `description`.*
3. **Where the record lookup for the writer resolver lives** (`RecordLinksService.findAccessRow` returns ids only; the lock verdict needs `is_locked` from the row-locked read inside the transaction). Spec picks between extending `RecordLinksService` and a small `RecordsService` method; no repository import across modules either way. *Resolved: extend `RecordLinksService` (database only, no dependency on `records` or `record-attachments` services, so no constructor cycle): the resolver uses its existing `findAccessRow`; the in-transaction lock verdict uses one new method that takes the transaction and does the `FOR NO KEY UPDATE` read returning ids and `is_locked`.*
4. **CLAUDE.md edit:** the `AttachmentLimitReached` row in "Error codes owned by Care" (and a "Domain rules" line for the cap) is an owner edit, the same route `RecordLocked` took. *Resolved: the owner delegated it; the edit is made with contract step 0 at `/develop` (same commit as C5), not in the spec phase.*
5. **Capacity roll-up:** confirm 20 × 10 MB per record fits `capacity.md` storage assumptions; no hub edit expected. *Resolved: verified by the spec author against `capacity.md` and the local capacity shard; a hub edit only if the 200 MB-per-record bound breaks a stated assumption (then listed under Platform changes required).*
6. **Hub contract copy / hub PR #24:** *Resolved: hub PR #24 is merged (`main` 23a0471) and the hub contract copy equals care's current contract; this brief changes no hub doc. The hub re-sync happens when contract C1-C6 lands.*

## Success criteria
- A doctor uploads a PDF/JPEG/PNG up to 10 MB to their own record through intent → direct POST → `complete`; a `.pdf`-named file with other bytes, an oversize file, an expired/closed/foreign intent and a replayed `complete` behave as specified; the row exists only after verification.
- Patient owner and consulted doctors see attachment metadata in the record and timeline and open a file only through `download-url` (60 s, audited first); the same call as an admin, a stranger, a suspended doctor or for a deleted attachment is `403`/`404` with no URL and no audit row.
- Delete works before the lock and answers `409 RecordLocked` after it (service and trigger agree at the boundary); the 21st live attachment is `409 AttachmentLimitReached`; two concurrent completes at the cap produce exactly one success.
- Verification's full suite is unchanged and green after the extraction; the purge loop clears expired intents of both kinds.
- `MedicalRecord.attachments` is truthful with one extra query per page; the contract, specs and docs agree with the code; no log line, audit metadata or Redis value contains an object key, URL, POST field or description.
