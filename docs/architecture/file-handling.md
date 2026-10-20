---
title: File Handling — Verification Documents and Record Attachments
owner: care-team
service: care-service
status: accepted
diataxis: explanation
last_verified: 2026-10-20
tags: [architecture, files, uploads, downloads, object-storage, s3, security, clinical, audit]
related: [verification-spec, record-attachments-spec, clinical-records, data-model, api, rbac, infrastructure, deployment, resilience, runbook, adr-0013-verified-direct-upload-lifecycle, adr-0022-upload-intents-module, adr-0014-on-demand-download-urls, adr-0015-aws-sdk-storage-adapter, hub-adr-0011-object-storage-host]
---

# File Handling — Verification Documents and Record Attachments

Outcome of the 2026-09-15 `/system-design` on file storage. Decisions: [ADR 0013](../adr/0013-verified-direct-upload-lifecycle.md)
(D1 direct-to-S3, D2 verified complete, D4 intents in Postgres), [ADR 0014](../adr/0014-on-demand-download-urls.md)
(D3 on-demand download URLs), [ADR 0015](../adr/0015-aws-sdk-storage-adapter.md) (D6 S3 client). The browser → object
storage path is platform-scope: hub ADR 0011 and hub `architecture/deployment.md` (D5).

## 1. Shape
```
UPLOAD
 client ── POST …/uploads ───────────────▶ care-api  authorize, rate limit, INSERT upload_intents
        ◀─ 201 { uploadId, url, fields, expiresAt } (presigned POST → quarantine/<uuid>, 5 min)
 client ── POST form (file) ─────────────▶ S3 private bucket (policy: exact key, 1 B–10 MB, SSE)
 client ── POST …/uploads/{id}/complete ─▶ care-api
            lock intent → re-authorize → HEAD size → GET bytes 0-15 → magic number
            → COPY to final key, DELETE quarantine
            → BEGIN insert document|attachment (file_type = detected) + audit + consume intent; COMMIT
        ◀─ 201 VerificationDocument | RecordAttachment        (400 ValidationFailed on bad bytes)

DOWNLOAD
 client ── POST …/{fileId}/download-url ─▶ care-api  authorize → audit (fail closed)
        ◀─ 200 { url, expiresAt }   presigned GET, 60 s, attachment disposition, verified content type
 client ── navigate url ─────────────────▶ S3
```

## 2. Contract changes (all applied)
The verification-document rows below are in `contracts/openapi.yaml` (applied 2026-10-07, checked against the routes 2026-10-08); the multipart verification operation and its inline `downloadUrl` are gone. The record-attachment rows were applied by the `record-attachments` module (2026-10-18, checked against the routes 2026-10-20; [spec](../record-attachments/spec.md) C1-C6 and section 14). Unlike the first design, no record-attachment route answers `403 NotAssignedDoctor`: only the record's author writes, and every other doctor gets `404` (the existence-oracle reasoning of [records spec](../records/spec.md) 1.5.1). `MedicalRecord.attachments` is the live metadata list.

| Operation | Roles / ownership (`x-roles`, `x-ownership`) | Request | Responses | Audit |
|---|---|---|---|---|
| `POST /api/doctors/me/documents/uploads` | doctor (`pending`/`active`/`rejected`), self; application `draft` or `rejected` | `{ type: license\|id\|degree }` | `201 UploadIntent` · 400 · 403 · 404 (no application) · 409 `Conflict` (application not editable) · 429 | — |
| `POST /api/doctors/me/documents/uploads/{uploadId}/complete` | doctor, self (intent owner) | — | `201 VerificationDocument` · `200` replay · 400 `ValidationFailed` (`field: file`) · 404 · 409 `Conflict` (intent closed / application not editable) · 410 `UploadIntentExpired` | `verification.document_uploaded` |
| `POST /api/doctors/me/documents/{documentId}/download-url` | doctor, self | — | `200 DownloadUrl` · 404 | `verification.document_url_issued` |
| `POST /api/admin/applications/{id}/documents/{documentId}/download-url` | admin | — | `200 DownloadUrl` · 404 | `verification.document_url_issued` (admin-action) |
| `POST /api/records/{id}/attachments/uploads` | doctor (active, not suspended), **record author only** (resolver `record_attachment_writer`; others `404`; admin and patient `403`) | `{ description? ≤ 500 code points }` (optional body) | `201 UploadIntent` · 400 · 401 · 403 · 404 · 409 `AttachmentLimitReached` · 429 | — |
| `POST /api/records/{id}/attachments/uploads/{uploadId}/complete` | doctor, record author (intent owner, kind and record must match) | — | `201 RecordAttachment` · `200` replay · 400 (`field: file`, or a request body) · 403 · 404 · 409 `Conflict` / `AttachmentLimitReached` · 410 `UploadIntentExpired` · 429 | `attachment.added` (clinical-write, once; `afterLock` flag) |
| `POST /api/records/{id}/attachments/{attachmentId}/download-url` | patient, doctor; owning patient, author, or consulting doctor (else 404); **admins never** (`403` by role) | — | `200 DownloadUrl` · 400 (a request body) · 403 · 404 · 429 | `attachment.url_issued` (clinical-read, committed before presigning) |
| `DELETE /api/records/{id}/attachments/{attachmentId}` | doctor, record author | — | `204` (soft delete; the object is kept) · 400 · 403 · 404 · 409 `RecordLocked` (after the 24 h lock) · 429 | `attachment.removed` (clinical-write) |

- **Removed:** `POST /api/doctors/me/documents` and `POST /api/records/{id}/attachments` (multipart).
- **Schemas:** `UploadIntent { uploadId, url, fields (object of strings), expiresAt, maxBytes }` ·
  `DownloadUrl { url, expiresAt }` · `VerificationDocument` and `RecordAttachment` lose `downloadUrl` and
  `downloadUrlExpiresAt` · `VerificationDocumentUpload` and `RecordAttachmentUpload` removed · new `RecordAttachmentIntentCreate`.
- **New error codes:** `UploadIntentExpired` (410) and `AttachmentLimitReached` (409, the record already holds 20 live attachments).
- `DELETE /api/records/{id}/attachments/{attachmentId}` keeps its path; its ownership became the record author (`404` for others) and it gained the `400` for a request body.
- All new responses carry `Cache-Control: no-store`. Rate limits per user: attachment intent creation 20/h (its own bucket, separate from verification-document intents), `complete` + `DELETE` 20/min (one shared bucket), `download-url` 120/min. No attachment route takes an `Idempotency-Key`.

## 3. Data
New table (full DDL in [data-model.md](./data-model.md)): `upload_intents` — `id`, `kind`
(`verification_document`/`record_attachment`), `target_id` (doctor profile id or medical record id), `owner_user_id`
(Identity user id), `document_type`, `description`, `quarantine_key` (unique), `max_bytes`, `expires_at`,
`consumed_at`, `result_id`, `created_at`. Operational, not a business table: never exposed, purged by `care-worker`.

`verification_documents` and `record_attachments` are as designed (`record_attachments` is built; DDL, trigger and grants in [data-model.md](./data-model.md)). `object_key` holds the final key
(`verification-documents/<uuid>`, `record-attachments/<uuid>`); `file_type` is the **detected** type.

## 4. Verification at complete
| Step | Check | On failure |
|---|---|---|
| 1 | `SELECT … FROM upload_intents WHERE id = $1 FOR UPDATE`; `owner_user_id = auth.userId` | 404 `NotFound` |
| 2 | `result_id IS NOT NULL` → replay | `200` with the created row |
| 3 | `consumed_at IS NULL` | 409 `Conflict` |
| 4 | `expires_at > now()` | 410 `UploadIntentExpired` (object deleted) |
| 5 | re-authorize: application `draft`/`rejected` · assigned doctor, `status=active`, not suspended | 409 `Conflict` / 403 |
| 6 | `HEAD`: object exists, `1 ≤ size ≤ max_bytes` | 400 `ValidationFailed` (`field: file`) |
| 7 | `GET Range: bytes=0-15`: `25 50 44 46 2D` (`%PDF-`) → `application/pdf`; `FF D8 FF` → `image/jpeg`; `89 50 4E 47 0D 0A 1A 0A` → `image/png` | 400 `ValidationFailed` |
| 8 | `COPY` to the final random key, `DELETE` the quarantine key | storage error → intent stays open, `500`, retry allowed |
| 9 | one transaction: insert row (`file_type` = detected, `size_bytes` = HEAD size), audit row, `consumed_at = now()`, `result_id` | rollback; final object deleted by the purge of orphaned keys |

Steps 6–7 failing delete the quarantine object and close the intent (`consumed_at`, `result_id` null) and emit
`upload_verification_failed{reason=missing|size|type}`. The filename, the form's `Content-Type` field, and S3
object metadata are never read for the decision.

**Later deep scanning** (antivirus, PDF structure) runs in `care-worker` against final objects; a bad file is
soft-deleted and audited (`attachment.quarantined` / `verification.document_quarantined`) and alerts — the upload
lifecycle above does not change.

## 4a. As built for verification documents (2026-10-08)
> Since 2026-10-19 the lifecycle below (intent, per-intent lock, `complete`, purge) is implemented once in `src/app/upload-intents/` and shared by every module that takes direct uploads ([ADR 0022](../adr/0022-upload-intents-module.md)); each module supplies target authorization, the final key prefix and the row insert.
The steps above are the design; the shipped `complete` differs in these points ([verification spec](../verification/spec.md) §16):
- **Serialization** is a session-scoped PostgreSQL advisory lock per intent (replacing the `SELECT … FOR UPDATE` of step 1 for the storage phase); a refused lock answers `409 Conflict` + `Retry-After: 1`. Step 9 locks the intent row `FOR UPDATE` only inside its short transaction. The worker purge takes the same per-intent lock.
- **Step 8 is bound to the inspected object:** `HEAD` returns the S3 `ETag`; `promote` copies with `CopySourceIfMatch` and the detected content type, so a re-POST to the quarantine key after the checks makes the copy fail (`500`, intent stays open). The adapter does not re-read or re-sniff.
- **No idempotency middleware** on intent creation and both `download-url` routes; each issued URL writes one audit row first and fails closed on an audit error.
- **Metrics:** `upload_verification_failed` carries `reason=invalid_file` and, since the ADR 0022 extraction, the label `kind` (`verification_document` or `record_attachment`); `upload_intent_expired` is emitted by the purge; `upload_intent_created` and `download_url_issued` are not emitted yet.
- **Orphans:** no prefix-scan reconciliation; a rolled-back step 9 deletes its copied final object best-effort (`upload_orphan_cleanup_failed{kind}` log on failure; renamed from `verification_orphan_cleanup_failed` by ADR 0022) and the bucket lifecycle is the backstop. The expired `quarantine/*` lifecycle (24 h) is configured in local MinIO by `minio-setup`.
- **Local storage:** dev and test Compose run a digest-pinned MinIO ([ADR 0020](../adr/0020-local-s3-emulator-image.md)); route-level integration tests inject an in-memory storage port, and a separate adapter suite runs against real MinIO.

## 4b. As built for record attachments (2026-10-20)
The `record-attachments` module ([spec](../record-attachments/spec.md), section 14 wins) supplies the callbacks of the shared flow; the steps above hold with these specifics:
- **Authorization** is the record's author only: `authorizeTarget` requires `intent.target_id` = the path record and the record's `doctor_user_id` = the caller (else `404`); the route re-runs `authorize` (role, `status=active`, local suspension) before the flow. Adding is allowed after the 24 h lock and never updates `medical_records`.
- **Cap of 20 live attachments** per record: a courtesy count before any storage call (a full record answers `409 AttachmentLimitReached` with the quarantine object intact) and the guaranteeing count under `FOR NO KEY UPDATE` on the record row inside the short transaction.
- **Suspension is re-checked inside the short transaction** (after the record lock): a doctor suspended while the object was being verified gets `403 Forbidden`, no row and no audit row, the promoted object is deleted and the intent stays open.
- **Trade-off inherited from verification:** the quarantine object is deleted right after `promote`, before the short transaction. If that transaction fails for a reason other than the cap, the intent stays open but the quarantine bytes are gone; a retry answers `400 ValidationFailed` and the doctor uploads again (spec 14.2, K1; moving the delete after commit is a deliberate follow-up for both modules).
- **Download:** `attachment.url_issued` is committed in its own transaction before `presignDownload`; read DTOs and the record views carry metadata only. Deleting is a soft delete that keeps the stored object.
- **Purge:** the loop now closes expired open intents of every kind, so a `record_attachment` intent is purged like a document intent. The purge listing reads the intent row including the clinical `description` into worker memory only (spec 14.2, K6), and holds its singleton lock connection while it deletes serially (K5).
- **Dev-only QA caveat:** the record-attachments CURL run used an in-memory S3 stand-in, not MinIO; repeat it against MinIO before treating the module as verified end to end.

## 5. Security and privacy
- **Presigned POST** (5 min, `UPLOAD_POLICY_TTL_SECONDS`): conditions `key` exact, `content-length-range` 1–`max_bytes`,
  `x-amz-server-side-encryption`; no public ACL possible.
- **Intent** (15 min, `UPLOAD_INTENT_TTL_SECONDS`): single-use, owner-bound, re-authorized at complete.
- **Presigned GET** (60 s, `DOWNLOAD_URL_TTL_SECONDS`): `ResponseContentDisposition=attachment`,
  `ResponseContentType` = verified type; issued only after `authorize(policy)` and a successful audit insert.
- **Bucket:** private, Block Public Access on, TLS-only bucket policy, SSE; CORS `AllowedOrigins=[web origin]`,
  `AllowedMethods=[POST]`, no credentials, `MaxAge=600`; lifecycle `quarantine/*` → expire after 24 h;
  `record-attachments/*` → infrequent access after 90 days ([capacity.md](./capacity.md)).
- **IAM (task roles):** `care-api` — `s3:PutObject` (presign), `GetObject`, `CopyObject` source/target,
  `DeleteObject` on `quarantine/*`; `GetObject` on final prefixes. `care-worker` — `ListBucket`/`DeleteObject` on
  `quarantine/*` (and later `GetObject` for scanning).
- **Never logged or stored:** object keys, presigned URLs, POST fields. Audit metadata holds ids only.
- **Admins** never receive record attachment URLs (403 by role); they can open verification documents (audited).

## 6. Operations
- `care-worker` loop **upload-intent purge** (built; every 5 min as the constant `INTENT_PURGE_INTERVAL_MS`, singleton advisory lock; `node dist/worker.js --once upload-intent-purge` runs one tick): intents with `consumed_at IS NULL AND
  expires_at < now()` → delete the quarantine object → set `consumed_at`; delete intent rows older than 7 days.
- Metrics: `upload_intent_created` and `download_url_issued{kind}` are designed but not emitted yet;
  `upload_verification_failed{reason, kind}` and `upload_intent_expired` are emitted (see 4a).
- Alert `UploadVerificationFailureSpike` — > 20 failures in 10 min (ticket): a broken client or probing
  ([runbook.md](../runbook.md)).
- Timeouts (ADR 0015): 2 s `HEAD`/ranged `GET`/`DELETE`, 10 s `COPY`.

## 7. Budgets and capacity
~5 k uploads/day ≈ 0.4 peak rps of `complete`; each costs 1 row lock, `HEAD` + 16-byte `GET` + `COPY` + `DELETE`
(p95 target < 500 ms, dominated by `COPY` of ≤ 10 MB within the region) and one transaction. Upload and download
bytes no longer traverse `care-api`. Download-url issuance is one authorization query + one audit insert
(p95 < 100 ms).
