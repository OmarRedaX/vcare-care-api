---
title: File Handling — Verification Documents and Record Attachments
owner: care-team
service: care-service
status: accepted
diataxis: explanation
last_verified: 2026-09-15
tags: [architecture, files, uploads, downloads, object-storage, s3, security, clinical, audit]
related: [clinical-records, data-model, api, rbac, infrastructure, deployment, resilience, runbook, adr-0013-verified-direct-upload-lifecycle, adr-0014-on-demand-download-urls, adr-0015-aws-sdk-storage-adapter, hub-adr-0011-object-storage-host]
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

## 2. Contract changes required (provider: care-service; land via `/construct-spec` + `/develop`)
The current `contracts/openapi.yaml` still has the multipart operations and inline `downloadUrl`; it changes as follows.

| Operation | Roles / ownership (`x-roles`, `x-ownership`) | Request | Responses | Audit |
|---|---|---|---|---|
| `POST /api/doctors/me/documents/uploads` | doctor (`pending`/`active`/`rejected`), self; application `draft` or `rejected` | `{ type: license\|id\|degree }` | `201 UploadIntent` · 400 · 403 · 404 (no application) · 409 `Conflict` (application not editable) · 429 | — |
| `POST /api/doctors/me/documents/uploads/{uploadId}/complete` | doctor, self (intent owner) | — | `201 VerificationDocument` · `200` replay · 400 `ValidationFailed` (`field: file`) · 404 · 409 `Conflict` (intent closed / application not editable) · 410 `UploadIntentExpired` | `verification.document_uploaded` |
| `POST /api/doctors/me/documents/{documentId}/download-url` | doctor, self | — | `200 DownloadUrl` · 404 | `verification.document_url_issued` |
| `POST /api/admin/applications/{id}/documents/{documentId}/download-url` | admin | — | `200 DownloadUrl` · 404 | `verification.document_url_issued` (admin-action) |
| `POST /api/records/{id}/attachments/uploads` | doctor (active, not suspended), assigned-doctor | `{ description? ≤ 500 }` | `201 UploadIntent` · 400 · 403 `NotAssignedDoctor` · 404 · 429 | — |
| `POST /api/records/{id}/attachments/uploads/{uploadId}/complete` | doctor, assigned-doctor (intent owner) | — | `201 RecordAttachment` · `200` replay · 400 · 403 · 404 · 409 · 410 | `attachment.added` (clinical-write) |
| `POST /api/records/{id}/attachments/{attachmentId}/download-url` | patient, doctor; owning patient, author, or consulting doctor (else 404); **admins never** | — | `200 DownloadUrl` · 403 (admin) · 404 | `attachment.url_issued` (clinical-read) |

- **Removed:** `POST /api/doctors/me/documents` and `POST /api/records/{id}/attachments` (multipart).
- **Schemas:** `UploadIntent { uploadId, url, fields (object of strings), expiresAt, maxBytes }` ·
  `DownloadUrl { url, expiresAt }` · `VerificationDocument` and `RecordAttachment` lose `downloadUrl` and
  `downloadUrlExpiresAt` · `VerificationDocumentUpload` and `RecordAttachmentUpload` removed.
- **New error code:** `UploadIntentExpired` (410).
- `DELETE /api/records/{id}/attachments/{attachmentId}` is unchanged (before the lock only, `409 RecordLocked`).
- All new responses carry `Cache-Control: no-store`; the rate limit (20/h per user) applies to intent creation.

## 3. Data
New table (full DDL in [data-model.md](./data-model.md)): `upload_intents` — `id`, `kind`
(`verification_document`/`record_attachment`), `target_id` (doctor profile id or medical record id), `owner_user_id`
(Identity user id), `document_type`, `description`, `quarantine_key` (unique), `max_bytes`, `expires_at`,
`consumed_at`, `result_id`, `created_at`. Operational, not a business table: never exposed, purged by `care-worker`.

`verification_documents` and `record_attachments` are unchanged in shape. `object_key` holds the final key
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
- `care-worker` loop **upload-intent purge** (every 5 min, advisory lock): intents with `consumed_at IS NULL AND
  expires_at < now()` → delete the quarantine object → set `consumed_at`; delete intent rows older than 7 days.
- Metrics: `upload_intent_created`, `upload_verification_failed{reason}`, `upload_intent_expired`,
  `download_url_issued{kind}`.
- Alert `UploadVerificationFailureSpike` — > 20 failures in 10 min (ticket): a broken client or probing
  ([runbook.md](../runbook.md)).
- Timeouts (ADR 0015): 2 s `HEAD`/ranged `GET`/`DELETE`, 10 s `COPY`.

## 7. Budgets and capacity
~5 k uploads/day ≈ 0.4 peak rps of `complete`; each costs 1 row lock, `HEAD` + 16-byte `GET` + `COPY` + `DELETE`
(p95 target < 500 ms, dominated by `COPY` of ≤ 10 MB within the region) and one transaction. Upload and download
bytes no longer traverse `care-api`. Download-url issuance is one authorization query + one audit insert
(p95 < 100 ms).
