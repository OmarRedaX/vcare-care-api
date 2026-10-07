---
title: verification — Spec
owner: care-team
service: care-service
module: verification
status: implemented
version: 1.1.0
diataxis: reference
last_verified: 2026-10-08
tags: [spec, verification, documents, identity-client, storage, worker, case-1, case-2]
related: [verification-brainstorm, doctors-spec, file-handling, data-model, integration, resilience, adr-0004-cross-service-failure-policies, adr-0008-care-worker-component, adr-0013-verified-direct-upload-lifecycle, adr-0014-on-demand-download-urls, adr-0015-aws-sdk-storage-adapter, adr-0017-generic-helpers-and-transaction-scoping]
contracts: [contracts/openapi.yaml]
---

# verification — Spec

This module makes doctor credentialing live: verified direct uploads, submission, an admin review queue and decision, and durable synchronization of that decision to Identity. The approved [brief](./brainstorm.md) fixes scope and policy. §13 enumerated the contract edits applied at `/develop` step 0; they are in `contracts/openapi.yaml` (checked against the routes on 2026-10-08). The module is implemented; §16 records the as-built behavior, which wins over the design prose in §1–§15 where they differ.

Binding rules: CLAUDE.md → “Database rules”, “API conventions”, “Authentication and service-to-service auth”, “Authorization — RBAC and ownership”, “Security rules”, “Privacy and logging”, “Cross-service integration”, “Domain rules”, “Testing policy”, and “Build order for a new module”. Numeric ids are JSON numbers (hub ADR 0004). No application code is part of this spec step.

## 1. Overview and decisions

| Area | This iteration |
|---|---|
| Existing owner | `doctor_profiles` is the application; `id` is application id. `doctors` keeps profile fields and own read DTOs. |
| New data | `verification_documents`, `upload_intents`, `identity_sync_jobs`, queue index on `doctor_profiles`. |
| Routes | Live `POST /doctors/apply` submit branch; doctor document lifecycle; admin queue, detail, download, approve, reject, reopen. |
| Libraries | `lib/storage` object-storage port + S3 adapter; `lib/identity-client` status and batch-hydration client. |
| Background | Real `identity-sync` and `upload-intent-purge` loops in `care-worker`. |
| Dependencies | `doctors`, `specialties`, access/audit, Identity internal API, Postgres, Redis (Tier 2), private S3/MinIO. |

**D1.** `draft → submitted` is a local transaction with no Identity call. `rejected → submitted`, whether doctor resubmit or admin reopen, uses Case 1 to request Identity `pending`. A submitted application locks profile and document edits with `409 ApplicationNotEditable`; approved profile fields keep the doctors module's existing edit policy. The live submit branch replaces the doctors module's dormant `SubmitRequiresDocuments` path. A newly created profile with `submit=true` and no verified documents fails as `400 ValidationFailed` and leaves no profile.

**D2.** The application requires one live `license` and one live `id` document. Degree is optional. `reviewNote` from optional approve `note` remains nullable; reject and reopen require `reason` (3–2000 code points, no control characters). The reason is stored as `review_note` for the decision and sent as reason to Identity; it must not enter logs or audit metadata.

**D3.** Every Case-1 transition writes a pending sync job **in the decision transaction**, including the inline-success path. This closes the crash window between local commit and job creation in older integration prose. Inline success marks it succeeded; retryable failure leaves it pending; Identity `409 InvalidStatusTransition` marks it failed. One open job per doctor, with an older pending job superseded atomically on a newer legitimate transition.

**D4.** No search-cache implementation here. Availability must invalidate a doctor's search, slot and next-available derived caches on `verification.approved`, `verification.rejected`, `verification.reopened` (including doctor resubmit), and `identity_sync.synced` for any of those transitions. Invalidation must occur after commit; availability owns delivery and its tests. Until schedules exist, the active-consultation-type term keeps `isBookable=false`.

**D5.** Admin queue/detail hydrate doctor identity with Case 2. Doctor own application may use the same hydrator; an outage yields the existing contract-compatible null `doctor` fields. Hydration never governs review authorization or bookability.

**D6.** Admin routes use a 120/min per-admin-user limit; document intent creation uses 20/h per doctor; other doctor writes use the existing 20/min limiter and reads 120/min. `Idempotency-Key` is optional on `complete`, `DELETE` document and the three decisions, using the existing 24-hour Redis middleware; it is **not mounted** on `createIntent` and both `download-url` routes (review 2026-10-08: signed POST policies and URLs must never be stored in Redis, and each issued URL needs its own audit row). DB transitions and intent replay still guarantee correctness if Redis is lost.

## 2. Dependencies, configuration and local infrastructure

ADR 0015 permits exactly `@aws-sdk/client-s3`, `@aws-sdk/s3-presigned-post`, and `@aws-sdk/s3-request-presigner`, imported only by `lib/storage/s3.adapter.ts`, pinned without `^`. Pin all three to **3.1147.0** (the registry's latest, verified with `npm view @aws-sdk/<package> version` on 2026-10-07; all three packages publish in lockstep). No other runtime package and no new ADR.

Add all variables to `lib/config/env.ts` Zod schema and `lib/config/types.ts`; reject invalid ranges at startup. `IDENTITY_INTERNAL_URL` is a URL to Identity's isolated listener (local `http://localhost:3100`); `SERVICE_CLIENT_ID` and `SERVICE_CLIENT_SECRET` are nonempty, without defaults. `STORAGE_BUCKET`, `STORAGE_REGION`, `STORAGE_ENDPOINT` (optional only in AWS), `STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY` (required together in local/test, no defaults on credentials), and `STORAGE_FORCE_PATH_STYLE` (strict boolean, true for MinIO) configure the adapter. In AWS, use task-role credentials and no static storage keys. `UPLOAD_POLICY_TTL_SECONDS=300`, `UPLOAD_INTENT_TTL_SECONDS=900`, `DOWNLOAD_URL_TTL_SECONDS=60`, `IDENTITY_SYNC_POLL_SECONDS=10`, `IDENTITY_SYNC_RETRY_CAP_SECONDS=60`, `IDENTITY_SYNC_ALERT_AFTER_SECONDS=900`, and `UPLOAD_INTENT_PURGE_SECONDS=300` are validated integers; the security TTLs are fixed production values, overridable in tests only. Identity attempt timeout is 2000 ms; storage timeout is 2000 ms except 10000 ms copy.

`.env.example` and `.env.test` list the variables with synthetic local credentials; never use production credentials there. Add MinIO to both `docker-compose.yml` and `docker-compose.test.yml`, with isolated private buckets, health checks, loopback host port in test/dev, and a setup task creating the bucket and upload CORS. Dev `care-api` and `care-worker` get the Identity and storage env; test integration runner uses host MinIO endpoint. The bucket permits presigned `POST` from the configured web origin, enforces private access, server-side encryption and TLS in production, and expires `quarantine/*` after 24 h. Route-level integration tests inject an in-memory fake of the storage port; a separate adapter suite uses real MinIO. Local MinIO HTTP is an explicit local-only exception to production TLS.

## 3. Database schema and migrations

Generate separate raw-SQL `src/migrations/<timestamp>_<name>.ts` files after doctors migrations: (1) `create_upload_intents`, (2) `create_verification_documents`, (3) `create_identity_sync_jobs`, (4) `add_verification_queue_index`. Use `await knex.raw(...)`; each `down` reverses its own change, with `IF EXISTS` and no `CASCADE`. Run as owner, grant explicitly to `vcare_app`; verify migrate/rollback/migrate and `EXPLAIN` the named queries. No native enums, `SELECT *`, or cross-service FKs.

### 3.1 `upload_intents`

```sql
CREATE TABLE upload_intents (
 id BIGSERIAL PRIMARY KEY,
 kind VARCHAR(32) NOT NULL,
 target_id BIGINT NOT NULL,
 owner_user_id BIGINT NOT NULL, -- Identity user id; no FK
 document_type VARCHAR(16),
 description VARCHAR(500),
 quarantine_key VARCHAR(512) NOT NULL,
 max_bytes INT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 consumed_at TIMESTAMPTZ,
 result_id BIGINT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT uq_upload_intents_quarantine_key UNIQUE (quarantine_key),
 CONSTRAINT chk_upload_intents_kind CHECK (kind IN ('verification_document','record_attachment')),
 CONSTRAINT chk_upload_intents_document_type CHECK ((kind='verification_document' AND document_type IN ('license','id','degree') AND description IS NULL) OR (kind='record_attachment' AND document_type IS NULL)),
 CONSTRAINT chk_upload_intents_max_bytes CHECK (max_bytes BETWEEN 1 AND 10485760),
 CONSTRAINT chk_upload_intents_result CHECK (result_id IS NULL OR consumed_at IS NOT NULL)
);
-- Purge: open expired intents ORDER BY expires_at LIMIT 500.
CREATE INDEX idx_upload_intents_expires_at_open ON upload_intents (expires_at) WHERE consumed_at IS NULL;
-- Purge: rows older than seven days.
CREATE INDEX idx_upload_intents_created_at ON upload_intents (created_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON upload_intents TO vcare_app;
GRANT USAGE ON SEQUENCE upload_intents_id_seq TO vcare_app;
```

`target_id` is polymorphic by `kind`; complete re-loads the profile. Intent rows are operational and may be hard-purged after seven days. `down`: drop indexes if present, then `DROP TABLE IF EXISTS upload_intents` (the table drop also removes its indexes); no dependent table is dropped.

### 3.2 `verification_documents`

```sql
CREATE TABLE verification_documents (
 id BIGSERIAL PRIMARY KEY,
 doctor_profile_id BIGINT NOT NULL,
 type VARCHAR(16) NOT NULL,
 object_key VARCHAR(512) NOT NULL,
 file_type VARCHAR(32) NOT NULL,
 size_bytes INT NOT NULL,
 status VARCHAR(16) NOT NULL,
 reviewed_by BIGINT, -- Identity user id; no FK
 review_note TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 deleted_at TIMESTAMPTZ,
 CONSTRAINT fk_verification_documents_doctor_profile_id FOREIGN KEY (doctor_profile_id) REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
 CONSTRAINT uq_verification_documents_object_key UNIQUE (object_key),
 CONSTRAINT chk_verification_documents_type CHECK (type IN ('license','id','degree')),
 CONSTRAINT chk_verification_documents_file_type CHECK (file_type IN ('application/pdf','image/jpeg','image/png')),
 CONSTRAINT chk_verification_documents_size CHECK (size_bytes BETWEEN 1 AND 10485760),
 CONSTRAINT chk_verification_documents_status CHECK (status IN ('uploaded','accepted','rejected'))
);
-- Application detail, submission precondition, and document-owner lookup.
CREATE INDEX idx_verification_documents_doctor_profile_id_type ON verification_documents (doctor_profile_id, type) WHERE deleted_at IS NULL;
GRANT SELECT, INSERT, UPDATE ON verification_documents TO vcare_app;
GRANT USAGE ON SEQUENCE verification_documents_id_seq TO vcare_app;
```

No app `DELETE` or `TRUNCATE`; document removal sets `deleted_at`, retaining the final object under retention policy. `down`: `DROP TABLE IF EXISTS verification_documents` after dependent migrations are rolled back; no cascade.

### 3.3 `identity_sync_jobs` and queue index

```sql
CREATE TABLE identity_sync_jobs (
 id BIGSERIAL PRIMARY KEY,
 doctor_profile_id BIGINT NOT NULL,
 doctor_user_id BIGINT NOT NULL, -- Identity user id; no FK
 kind VARCHAR(16) NOT NULL,
 target_status VARCHAR(16) NOT NULL,
 reason TEXT,
 actor_user_id BIGINT NOT NULL, -- Identity user id; no FK
 request_id UUID,
 status VARCHAR(16) NOT NULL,
 attempts INT NOT NULL DEFAULT 0,
 consecutive_failures INT NOT NULL DEFAULT 0,
 last_error_code VARCHAR(32),
 next_attempt_at TIMESTAMPTZ NOT NULL,
 succeeded_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT fk_identity_sync_jobs_doctor_profile_id FOREIGN KEY (doctor_profile_id) REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
 CONSTRAINT chk_identity_sync_jobs_kind CHECK (kind IN ('verification','suspension','reinstatement')),
 CONSTRAINT chk_identity_sync_jobs_target_status CHECK ((kind='verification' AND target_status IN ('active','rejected','pending')) OR (kind='suspension' AND target_status='suspended') OR (kind='reinstatement' AND target_status='active')),
 CONSTRAINT chk_identity_sync_jobs_status CHECK (status IN ('pending','succeeded','failed','superseded')),
 CONSTRAINT chk_identity_sync_jobs_attempts CHECK (attempts >= 0 AND consecutive_failures >= 0)
);
-- Worker: due pending jobs ordered by next_attempt_at LIMIT 50 (plain read; see section 16).
CREATE INDEX idx_identity_sync_jobs_pending_next_attempt_at ON identity_sync_jobs (next_attempt_at) WHERE status='pending';
-- One open job per profile; also covers the profile FK and admin lookup.
CREATE UNIQUE INDEX uq_identity_sync_jobs_doctor_profile_id_open ON identity_sync_jobs (doctor_profile_id) WHERE status='pending';
-- Runbook: recent history for a profile.
CREATE INDEX idx_identity_sync_jobs_doctor_profile_id_created_at ON identity_sync_jobs (doctor_profile_id, created_at DESC);
-- Runbook: recent history by Identity user id.
CREATE INDEX idx_identity_sync_jobs_doctor_user_id_id ON identity_sync_jobs (doctor_user_id, id DESC);
GRANT SELECT, INSERT, UPDATE ON identity_sync_jobs TO vcare_app;
GRANT USAGE ON SEQUENCE identity_sync_jobs_id_seq TO vcare_app;
```

`reason` is necessary to retry the Identity request and is confidential; no response, log, or audit metadata includes it. `down`: drop table if present, no cascade. Fourth migration (and its `down DROP INDEX IF EXISTS idx_doctor_profiles_verification_status_submitted_at_id`):

```sql
-- GET /admin/applications?status=... ORDER BY submitted_at ASC, id ASC (keyset).
CREATE INDEX idx_doctor_profiles_verification_status_submitted_at_id
 ON doctor_profiles (verification_status, submitted_at, id) WHERE deleted_at IS NULL;
```

## 4. API contract, route policies and DTOs

Every row is mounted on the **public** listener under `/api`, starts with `userGuard()` then `authorize(policy)`, and ends in the controller. Doctor policies accept token status `pending|active|rejected`; admin policies require `admin` and `active`. `self` means `auth.userId` resolves the profile by `doctor_profiles.user_id`; intent/document ownership is resolved from DB, never from request body. Missing private resources return `404 NotFound`. All responses, including error and presign responses, echo `X-Request-Id` and set `Cache-Control: no-store`. `500 InternalError` is possible for an unknown dependency/DB failure on every row; no internal details leak.

| Route (all `/api`) | Guard; role; DB ownership | Key; limit | Success | Documented domain errors beyond common 400/401/403/404/429/500 | Audit |
|---|---|---|---|---|---|
| `POST /doctors/apply` with `submit=true` (existing route) | user; doctor; self profile by `user_id` | optional; 20/min | 200 existing, 201 draft create; rejected resubmit 200 synced or 202 pending/failed | 409 `ApplicationNotEditable`/`Conflict`; 422 `IdempotencyConflict` | `verification.submitted`, sync outcome; existing profile audit if changed |
| `GET /doctors/me/application` (existing route) | user; doctor; self | none; 120/min | 200 | 404 before profile | none |
| `POST /doctors/me/documents/uploads` | user; doctor; self, profile exists, editable | none; 20/h | 201 `UploadIntent` | 409 `ApplicationNotEditable`/`Conflict` | none |
| `POST /doctors/me/documents/uploads/{uploadId}/complete` | user; doctor; intent owner + profile from DB | optional; 20/min | 201 document; 200 replay | 409 `Conflict`/`ApplicationNotEditable`; 410 `UploadIntentExpired`; 422 `IdempotencyConflict` | `verification.document_uploaded` once |
| `POST /doctors/me/documents/{documentId}/download-url` | user; doctor; document belongs to own live profile | none; 120/min | 200 `DownloadUrl` | - | `verification.document_url_issued` each actual issue |
| `DELETE /doctors/me/documents/{documentId}` | user; doctor; document belongs to own live profile | optional; 20/min | 204 | 409 `ApplicationNotEditable`; 422 `IdempotencyConflict` | `verification.document_deleted` |
| `GET /admin/applications` | user; admin; none (DB queue filter) | none; 120/min | 200 array + keyset meta | 400 invalid cursor/filter | none |
| `GET /admin/applications/{id}` | user; admin; none, live profile by id | none; 120/min | 200 application | 404 unknown/deleted | admin detail access `verification.documents_viewed`, no URL issued |
| `POST /admin/applications/{id}/documents/{documentId}/download-url` | user; admin; document belongs to live application | none; 120/min | 200 `DownloadUrl` | - | `verification.document_url_issued` each actual issue |
| `PATCH /admin/applications/{id}/approve` | user; admin; none, live application | optional; 120/min | 200 synced; 202 pending/failed | 409 `ApplicationNotReviewable`, or `Conflict` + `Retry-After: 5` while `identity_sync_status='pending'`; 422 `IdempotencyConflict` | `verification.approved`, sync outcome |
| `PATCH /admin/applications/{id}/reject` | user; admin; none, live application | optional; 120/min | 200 synced; 202 pending/failed | 409 `ApplicationNotReviewable`, or `Conflict` + `Retry-After: 5` while `identity_sync_status='pending'`; 422 `IdempotencyConflict` | `verification.rejected`, sync outcome |
| `PATCH /admin/applications/{id}/reopen` | user; admin; none, live rejected application | optional; 120/min | 200 synced; 202 pending/failed | 409 `ApplicationNotReviewable`; 422 `IdempotencyConflict` | `verification.reopened`, sync outcome |

Common `400 ValidationFailed` applies to malformed UUID/id/body, unknown fields, bad mime/size, or incomplete documents; common `401 Unauthorized`/`TokenExpired`; `403 Forbidden` for wrong role, token state, or local suspension; `404 NotFound` for absent or foreign private ids; `429 RateLimited`; `500 InternalError`. An in-flight optional idempotency key yields `409 Conflict` and `Retry-After: 1`. Storage failures do **not** create a document. Decision Identity failure follows the explicit 202 path, never a generic 5xx. The contract edits in §13 add every new operation/status and the precise error references.

**Requests.** `DoctorApplyRequest` stays contract-exact; `submit` is required boolean and the other fields keep doctors-spec validators. `UploadVerificationIntentRequest {type}` is a class-validator DTO with `@IsEnum(license|id|degree)` and `forbidNonWhitelisted`; complete/download/delete have empty bodies (reject unknown fields) and positive numeric path ids via explicit `ToInt`. `ApplicationApprove {note?}` is `@IsOptional @IsString` 0–2000 code points with no control characters. `ApplicationReject {reason}` is required string 3–2000 code points, no controls, used for reject and reopen. Queue query DTO: `status?` one of `draft|submitted|approved|rejected` (default `submitted`), opaque `cursor?` bounded to 1024 characters, `limit?` explicit `ToInt`, 1–100 default 20. Unknown query keys are rejected. Cursor encodes `(submitted_at, id)` and status; mismatched/tampered cursor is 400. Null `submitted_at` for draft is ordered last using a stable null sentinel, then id. Fetch `limit+1`; `meta={nextCursor,hasMore,count}` where count is returned items, no total scan.

**Responses.** `VerificationDocument {id,type,status,fileType,sizeBytes,reviewNote?,uploadedAt}` (ISO UTC); no object key, URL or expiry. `UploadIntent {uploadId,url,fields,expiresAt,maxBytes}` is returned only by intent creation, never by reads. `DownloadUrl {url,expiresAt}` is issued on demand. `VerificationApplication {id,doctorUserId,doctor:{displayName,avatarUrl,profileHydrated},status,identitySyncStatus,submittedAt,decidedAt,reviewedBy,reviewNote,documents, specialties?,yearsExperience?,missingRequirements?}` follows the contract: `missingRequirements` only on doctor's own view, admin detail/queue include no clinical fields or signed URLs. `ApprovalPendingSync` is the contract's success envelope with `identitySync:"pending"|"failed"`; ordinary 200 response carries the application with current `identitySyncStatus`. `from(entity, viewer)` makes doctor/admin views explicit. All ids are numbers, not strings.

## 5. Module and library layout

`src/app/verification/{enums.ts,errors.ts,types.ts,policies.ts,routes.ts,controller/verification.controller.ts,service/verification.service.ts,repository/verification.repo.ts,entity/verification-document.entity.ts,dto/verification.request.dto.ts,dto/verification.response.dto.ts}`. Additional repository files by table are acceptable; each exports functions with `conn: Knex=db`, explicit column arrays, row mapper, and live-row filter. The service owns transaction callbacks and audit; controller performs validate → service → `sendSuccess`, with arrow methods. No inline interface/type in controller, service, repo, middleware or client. Use `Symbol.for()` DI tokens and `src/bootstrap.ts` registration. Extend doctors service by a verification collaboration port/service call, never import verification's repository into doctors. Existing `POST /doctors/apply` and `GET /doctors/me/application` keep their doctors router but delegate transition/read assembly to verification service; no duplicate routes.

`src/lib/storage/{types.ts,object-storage.ts,s3.adapter.ts}` exposes `ObjectStorage` with `createUploadPolicy(key,maxBytes,ttlSeconds): Promise<UploadPolicy>`, `headObject(key): Promise<ObjectHead|null>`, `readHead(key,byteCount): Promise<Uint8Array|null>`, `promote(fromKey,toKey): Promise<void>`, `delete(key): Promise<void>`, `presignDownload(key,contentType,ttlSeconds): Promise<DownloadUrl>`. `types.ts` holds all argument/result interfaces. Storage calls happen outside transaction callbacks. Use a bounded SDK retry count of two and the §2 timeouts. Copy uses an encoded `CopySource`, private target and the verified content type; delete quarantine only after successful copy. Do not inspect filename or declared content type.

`src/lib/identity-client/{types.ts,identity-client.ts,service-token-cache.ts,identity.dto.ts}` exposes `setUserStatus(userId,status,reason,actorUserId,requestId): Promise<StatusResult>` and `getUsersBatch(ids,requestId): Promise<Map<number,HydratedUser>>`. The latter encapsulates Redis read-through and returns nullable/degraded fields rather than throwing for Case 2. Response DTO classes validate Identity's token, user summary and status envelopes with class-validator/transformer; malformed JSON is a failure. Token cache refresh is single-flight at `exp−30 s`, `401` refreshes once; `undici` pool, 2-second attempt timeout, `X-Request-Id` on token and user calls. Generic retry/backoff belongs under `lib/async`, not copied into the module. No calls from a module directly to Identity.

## 6. Service algorithms and transaction boundaries

**Submit/resubmit.** Lock the live doctor profile row in a Knex handler transaction; ensure actor is owner, not suspended, current status `draft|rejected`, and at least one live license plus id. Revalidate this after profile update and before transition. If missing, throw `ValidationFailed` field `documents`; no partial write. For draft set `submitted_at`, `verification_status='submitted'`, audit `verification.submitted`, commit and return 200 (or existing create semantics). For rejected, atomically supersede a pending job, set `submitted`, `identity_sync_status='pending'`, clear stale decision fields as appropriate, insert new verification job target `pending`, audit `verification.submitted`, commit; then run Case 1. Locking serializes concurrent submit/approve. A submitted profile returns `ApplicationNotEditable` on edit; an approved submission returns `Conflict`.

**Intent creation.** Read and authorize live own profile in `draft|rejected`; choose `quarantine/<random UUID>` and a 10 MB maximum. Create presigned POST with exact-key, `content-length-range` and server-side encryption conditions (300 s), then insert intent with 900 s expiry (no transaction encloses signing). Return 201 only after both succeed; if DB insert fails, no document exists and the unused policy naturally expires. Never return `quarantine_key` separately.

**Complete (nine checks/actions).** Use a session-scoped PostgreSQL advisory lock keyed by intent id across this request and release in `finally`; a failed try-lock returns `409 Conflict` + `Retry-After: 1`. It serializes complete and purge without holding a database transaction during storage I/O. (1) Read intent by id, `kind='verification_document'`, owner and target; foreign/missing → 404. (2) If `result_id` exists, load the existing document and return 200 with no new audit. (3) Consumed without result → 409. (4) Expired → delete quarantine outside a transaction, mark consumed in a short transaction, return 410. (5) Re-read live profile and authorization; only `draft|rejected`, not locally suspended; otherwise 409/403. (6) `HEAD` object and enforce 1..`max_bytes` ≤ 10 MB. (7) Read `bytes=0-15`; recognize `%PDF-`, `FF D8 FF`, or PNG signature; ignore extension, POST `Content-Type` and S3 metadata. On missing/invalid size/type delete quarantine, close intent without result in a short transaction, emit `upload_verification_failed{reason}`, return 400 field `file`. (8) Copy to `verification-documents/<random UUID>`, then delete quarantine; a storage error leaves intent open for retry, and copied orphan is cleaned by operational reconciliation/lifecycle. (9) In **one** Knex transaction, lock intent/profile, re-check owner/open/expiry/editable state, insert document with detected type and HEAD size, write `verification.document_uploaded` audit, set intent `consumed_at` and `result_id`; commit then return 201. If step 9 rolls back, delete the copied final object best-effort outside the transaction and alert on cleanup failure. Replays return the same row; no duplicate audit. The advisory lock is held across steps but no transaction spans S3 calls. A session-scoped lock pins one pooled connection for the request (and for the worker's outbound Identity call); `/develop` must acquire it through a helper in `lib/knex` that reserves a connection and always unlocks, and the integration test must prove a 1-connection-spare pool is not exhausted by concurrent completes (API pool acquire timeout is 1 s).

**Download URL.** Resolve the live document and profile by DB ownership (admin route also checks `document.doctor_profile_id=id`); `authorize` must have succeeded. Write `verification.document_url_issued` audit **and wait for commit** before presigning; audit failure stops the request. Sign a 60-second GET with attachment disposition and the stored, sniffed `file_type`, return 200 no-store. Every issued URL has one audit row; no URL or key enters logs/audit. If signing fails after audit, record failure telemetry without confidential URL; the row records authorization to issue, and no URL was delivered.

**Delete.** Lock own live profile/document in one transaction; require `draft|rejected`, set `deleted_at`, update profile timestamp, audit `verification.document_deleted` with ids, commit. Return 204; do not delete the final object synchronously. A second deletion is 404. A submitted/approved application yields `ApplicationNotEditable` before mutation.

**Approve/reject/reopen.** In one transaction lock profile, enforce `submitted` for approve/reject or `rejected` for reopen, supersede any pending verification job, set `verification_status`, `reviewed_by`, `review_note`, `decided_at` (clear decision on reopen), `identity_sync_status='pending'`, insert a `verification` job with target `active|rejected|pending` and the initiating `request_id`, audit `verification.approved|rejected|reopened`, commit. On approval require live license and id at decision time. Outside the transaction acquire a **session-scoped per-doctor advisory lock** shared with the worker, re-check that this is the current pending job, then call `setUserStatus`; release the lock in `finally`. This serializes outbound status calls for one doctor without holding a DB transaction across HTTP. The client makes at most three attempts with 2 s timeout and 200 ms × 2^attempt ±20% jitter; refresh service token and retry once on 401. Identity 200: compare job id/current target in a transaction, set job succeeded and profile synced, audit `identity_sync.synced`, return 200. Transient failure: increment attempts, schedule job, audit `identity_sync.pending` once for this transition, return 202 pending. Identity `409 InvalidStatusTransition`: mark job/profile failed only if still current, audit `identity_sync.failed`, emit `IdentitySyncTransitionRejected` alert, return 202 failed. If a newer job replaced this one before the lock was acquired, return the current application state without sending the stale target. `404`/malformed response is handled as a retryable integration failure with bounded attempts and alert visibility; no 5xx to admin for Case 1. Approval is never bookable before `approved` **and** `synced` (plus active account, not suspended, accepting and an active consultation type). Two concurrent approvals serialize; one succeeds and the other receives 409. **Pending-sync guard (review 2026-10-08):** approve and reject are refused with `409 Conflict` + `Retry-After: 5` (no new error code) while the locked profile's `identity_sync_status='pending'`, i.e. a resubmit/reopen that moved Identity back to `pending` has not reached it yet. Superseding that unapplied job would send Identity `rejected -> active`, which it refuses, leaving the doctor approved but permanently `failed`. Reopen is not guarded (it supersedes a not-yet-applied rejection safely: Identity is still `pending`). The guard runs inside the decision transaction after the status check.

## 7. Worker loops and cross-service behavior

`identity-sync` runs only in `care-worker`, polling each 10 s. Select up to 50 due `pending` jobs ordered by `next_attempt_at` (as built: a plain read with no claim transaction and no `SKIP LOCKED`; see §16); never hold a row transaction over HTTP. Acquire the same **session-scoped per-doctor lock** as the inline path before outbound HTTP, then re-check job status/current target and release in `finally`; a second worker skips that doctor this tick. A superseded job is marked `superseded` without calling Identity; outbound calls for one doctor cannot overtake each other. Retry transient network/timeout/429/5xx/401-refresh failures with exponential 200 ms base capped at `IDENTITY_SYNC_RETRY_CAP_SECONDS=60`, ±20% jitter, no attempt limit. Case 1 alerts `IdentityApprovalSyncPending` after 15 min unsynced (once per pending episode); 409 sets failed and alerts `IdentitySyncTransitionRejected` immediately. Store only HTTP status/error class in `last_error_code`, never response body or reason. Successful retry updates profile/job and audits `identity_sync.synced` in one transaction. Preserve future `suspension` and `reinstatement` kinds; this module processes `verification` only until those modules add their policies.

`upload-intent-purge` runs every five minutes under an advisory singleton lock. Batch ≤500 expired open intents (oldest first), take the same per-intent advisory lock, delete quarantine through storage outside the DB transaction, then mark consumed; a storage error leaves it open for next tick. Purge rows older than seven days in bounded batches; avoid removing a just-completed intent needed for replay before seven days. Also reconcile copied final objects orphaned by a failed step 9 using a safe age threshold and object-prefix scan, or rely on a configured lifecycle cleanup verified by the MinIO adapter suite; never delete a referenced final key. S3 quarantine lifecycle at 24 h is the backstop. `upload_intent_expired` metric and `UploadVerificationFailureSpike` alert follow file-handling design.

Extend `WorkerLoopDeps` in `src/lib/worker/types.ts` with identity client and storage port, construct them in `src/worker.ts` with its own pool/Redis and close all clients on normal or `--once` shutdown. `src/worker-loops.ts` registers `identity-sync` and `upload-intent-purge` alongside `audit-partitions`; `node dist/worker.js --once identity-sync` and `--once upload-intent-purge` exercise one tick. Do not start loops in API bootstrap. Two workers may run: advisory locks guard singleton purge and per-profile/per-intent work (as built, no `SKIP LOCKED`; see §16). `WorkerHeartbeatStale` remains the worker liveness alert.

Case 2 uses Redis `MGET identity:user:<id>` (TTL 300 s), chunks only misses into ≤100 distinct ids for `GET /internal/users?ids=`, with at most one retry. `fullName → displayName`, `avatarUrl` unchanged. Cache `{fullName,avatarUrl,status}` only; omit unknown users. Redis unavailable → call Identity directly; Identity unavailable/malformed → use cached entries and null misses with `profileHydrated:false`, emit `identity_hydration_degraded`; queue/detail still return 200. Never authorize from hydrated status. Identity `status` is used only by later search to hide non-active doctors. Service-token exchange uses `POST /internal/auth/token` with scopes `users:read users:status:write`, audience `vcare-identity`; all calls forward request id. Identity's provider contract already covers `pending→active|rejected` and `rejected→pending`; no provider edit for verification.

## 8. Business rules and named unit tests

| # | Invariant | Enforcement | Named unit test |
|---|---|---|---|
| V1 | Only owner doctor in pending/active/rejected token state can change own application | guard + DB policy | `submitRejectsForeignPrincipal` |
| V2 | Submitted profile cannot be edited; document writes require draft/rejected | service transaction + policy | `submittedProfileAndDocumentsAreImmutable` |
| V3 | Submit requires live license and id | transaction query | `submitRequiresLicenseAndId` |
| V4 | Draft submit makes no Identity call; rejected resubmit requests pending | transition service | `resubmitSyncsPendingOnlyForRejected` |
| V5 | Only submitted applications can be approved/rejected, only rejected reopened | row lock + service | `reviewTransitionRequiresExpectedState` |
| V6 | One open job per doctor; new decision supersedes older | unique partial index + transaction | `newDecisionSupersedesOpenJob` |
| V7 | Approval stays unbookable until Identity sync | profile gate shared with doctors | `approvalPendingIsNotBookable` |
| V8 | Intent is owner-bound, single-use and expires in 15 min | DB row + service + advisory lock | `intentOwnerReplayAndExpiry` |
| V9 | Real document exists only after stored bytes pass size and magic checks | service + DB transaction | `completeRejectsFalsePdfAndWritesNoRow` |
| V10 | Audit insert and document/decision mutations commit together | transaction | `auditFailureRollsBackVerificationWrite` |
| V11 | Download URL follows authorization and committed audit | policy + service | `downloadFailsClosedOnAuditError` |
| V12 | Identity transient errors yield 202/job, 409 yields failed/alert | client + service | `identityFailurePolicyDistinguishes409` |
| V13 | Late result of superseded job cannot overwrite current profile | job id compare in transaction | `staleSyncResultCannotMarkNewDecisionSynced` |
| V14 | Case 2 hydrates in batches and degrades without 5xx | identity client | `hydrationDegradesWithoutPerRowCalls` |
| V15 | Admin never sees clinical data; read DTOs never include URL/key | response DTO | `applicationViewsOmitStorageSecrets` |
| V16 | Every owner/credential id comes from token or DB relation | guard + policy + repo | `documentIdCannotCrossApplication` |

## 9. Errors, security, performance

| Code | HTTP | When |
|---|---:|---|
| `ValidationFailed` | 400 | DTO, missing license/id (`documents`), invalid stored file (`file`) |
| `Unauthorized` / `TokenExpired` | 401 | user token missing/invalid/expired |
| `Forbidden` | 403 | wrong role, token state, locally suspended doctor |
| `NotFound` | 404 | missing or foreign private profile/intent/document |
| `ApplicationNotEditable` | 409 | profile/document mutation while submitted or approved |
| `ApplicationNotReviewable` | 409 | review transition precondition fails |
| `Conflict` | 409 | closed/in-flight intent, in-flight idempotency key, generic transition race |
| `UploadIntentExpired` | 410 | complete after `expires_at` |
| `IdempotencyConflict` | 422 | same key, different body |
| `RateLimited` | 429 | route's Redis sliding window trips |
| `InternalError` | 500 | DB/storage/unhandled failure, redacted envelope |

All routes use `authorize`; a missing policy fails boot. Ignore `X-User-Id`, `X-Role` and forwarded identity headers. Credentials and clinical data never enter Care logs. Specifically redact document/object keys, upload policies/fields, presigned URLs, `Authorization`, service secret/token, reviewer reason/note, Identity user names/avatars, and request bodies. Audit metadata contains ids, old/new statuses and safe reason codes, never the reviewer prose. `verification.documents_viewed` audits admin detail (metadata-only); issuance of each URL is a separate audit. Final objects remain in a private bucket. No public/permanent link or file bytes travel through Care. The normal API/error envelope and request-id middleware apply.

Queue uses the partial `(verification_status,submitted_at,id)` index; document load is one batched query per page using `doctor_profile_id=ANY($1)`, with the existing document FK-leading index. Identity hydration is one `MGET` plus ≤1 Identity call for up to 100 misses; no N+1. The queue returns `limit+1` SQL rows and a bounded document batch; no total count. File complete performs HEAD, 16-byte ranged GET, COPY and DELETE; target p95 <500 ms in-region (10 MB copy may dominate). Download issue targets p95 <100 ms excluding provider tail, and search/slot budgets are unaffected because bytes bypass Care and worker loops are isolated (ADR 0008). Measure `identity_hydration_degraded`, sync job age, upload verification failures, and URL issuance without sensitive labels.

## 10. Test and manual QA plan

Unit tests cover each V1–V16 by its named test, plus DTO unknown-property, code-point-length and explicit numeric transforms; service-token single-flight/expiry/401 refresh; backoff jitter bound; magic signatures and short files; late worker result; privacy redaction; and worker stop/`--once` behavior. Mock collaborators and storage at unit level.

Route-level integration runs the real app, Postgres, Redis, repositories, migrations, audit and idempotency, with only external Identity HTTP and object storage port faked. Test the RBAC matrix for every new route: no token 401; patient 403; doctor allowed only own endpoints; admin allowed only admin endpoints; doctor pending/active/rejected on onboarding; doctor suspended blocked for writes; foreign doctor/intent/document 404. Use real Care tokens in manual QA. Test two concurrent approvals (one 200/202, one 409), replayed complete (201 then 200, one row/audit), wrong magic bytes with `.pdf` name, missing/oversize object, expired/closed/foreign intent, storage failure retry, audit rollback, no URLs/keys in reads/logs, optional idempotency replay/conflict, rate limits, keyset pagination/tamper, and contract response/error conformance.

Integration with stub Identity: outage → 202 and durable job converges after recovery; Identity 409 → failed job/profile, 202 and alert; stale job superseded; malformed batch result, Redis outage and Identity outage all degrade the admin queue/detail without 5xx; one batch request for ≤100 misses. Verify explicit `vcare_app` grants and rollback/reapply of each migration; `EXPLAIN` queue, document and pending-job queries. Separate S3 adapter integration suite against **real MinIO** verifies exact POST policy, size constraints, detected bytes, `HEAD`, 16-byte range, copy, delete, 60-second signed GET, attachment disposition and private access. Manual QA uses dev MinIO and CURL/HTTP tokens: doctor creates license/id intent, browser-style POST, completes, submits; admin queue/detail/download/approve; Identity down pending then worker `--once` convergence; rejection/reopen, 410, 404 and wrong role. Use synthetic files and never record tokens/URLs in QA docs.

## 11. Out of scope

Suspension Case 3 and reinstatement Case 4 (though the job table is future-compatible), record attachments, antivirus/deep PDF scan, notifications/outbox, doctor search, slots/next-available cache and its invalidation code, clinical records, and any provider contract change. These belong to later modules; §1 D4 states the availability hand-off events.

## 12. Open questions

None. The approved brief and D1–D6 settle module behavior. Contract and platform changes below are decided work, not unanswered design questions.

## 13. Contract edits for `/develop` step 0

Apply these **before implementation** to `contracts/openapi.yaml`; update operation IDs, `x-roles`, `x-ownership`, `x-account-state`, `x-audit-actions`, response refs and `Cache-Control: no-store` on each operation. The existing contract is authoritative until that edit lands.

- **C1** `paths./api/doctors/apply.post`: describe submitted profile edit lock, draft local submit and rejected Case-1 resubmit; add `ApplicationNotEditable` 409 response and keep 200/201/202 with `ApprovalPendingSync` for resubmit. `paths./api/doctors/me.patch` adds the submitted edit lock and 409 `ApplicationNotEditable`; `GET /doctors/me/application` keeps its operation and returns populated documents.
- **C2** Delete `paths./api/doctors/me/documents.post` multipart operation and `components.schemas.VerificationDocumentUpload`. Add `POST /api/doctors/me/documents/uploads` (`createVerificationUploadIntent`, body `{type}`, 201 `UploadIntent`, 400/401/403/404/409/422/429/500), `POST /api/doctors/me/documents/uploads/{uploadId}/complete` (`completeVerificationUpload`, 201 `VerificationDocument`, 200 replay, 400/401/403/404/409/410/422/429/500), and `POST /api/doctors/me/documents/{documentId}/download-url` (`getMyVerificationDocumentDownloadUrl`, 200 `DownloadUrl`, 400/401/403/404/422/429/500). Doctor role, DB self ownership, statuses pending/active/rejected on all.
- **C3** Add `DELETE /api/doctors/me/documents/{documentId}` (`deleteMyVerificationDocument`, doctor/self, draft/rejected, 204, 400/401/403/404/409 `ApplicationNotEditable`/422/429/500, audit `verification.document_deleted`). Add `POST /api/admin/applications/{id}/documents/{documentId}/download-url` (`getApplicationDocumentDownloadUrl`, admin/none with DB document→application check, 200 `DownloadUrl`, 400/401/403/404/422/429/500, audit `verification.document_url_issued`).
- **C4** `components.schemas.VerificationDocument`: remove required/properties `downloadUrl`, `downloadUrlExpiresAt`; retain metadata and nullable `reviewNote`, no `objectKey`. Add `UploadIntent` required `{uploadId,url,fields,expiresAt,maxBytes}` and `DownloadUrl` required `{url,expiresAt}`; add their success response components and `Cache-Control: no-store` headers. Add error response `UploadIntentExpired` with HTTP 410. `VerificationApplication` keeps its required fields and embeds metadata-only documents; admin/doctor viewer descriptions clarify `missingRequirements` only for self.
- **C5** `paths./api/admin/applications/{id}.get`: replace “with signed document URLs” summary and description with metadata-only documents; keep `verification.documents_viewed` audit, no URL issue. `GET /admin/applications` documents likewise have no URL; define `(submittedAt,id)` cursor order, null handling, status filter and Case-2 degraded doctor block.
- **C6** `approve`, `reject`, `reopen` descriptions and 202 schema explicitly include a job created in the local decision transaction, stale-job supersede and Identity 409 failed response; `x-audit-actions` include `identity_sync.pending|failed|synced` where applicable. Add 409 `ApplicationNotEditable` component and attach it to the new write operations. Add `x-audit-actions` for complete, both download URL operations and delete, and optional `Idempotency-Key` parameter/422 response for new writes. Document all new no-store and rate-limit behavior.

No Identity contract change for this module: the hub's `/internal/auth/token`, `/internal/users`, and `/internal/users/{id}/status` already cover its scopes and transitions. The separate suspended→active provider gap belongs to reinstatement (ADR 0012), provider first.

## 14. Platform and service documentation deltas

At `/update-docs verification`, update this service's `architecture/data-model.md` built-so-far status and actual DDL/index/grants, `architecture/api.md`, `file-handling.md`, `integration.md` (job-at-commit correction to old diagram), `resilience.md`, `infrastructure.md` (env/MinIO), `deployment.md` (worker loops), `capacity.md` if measured cost changes, runbook alerts, quickstart, and `docs/service-card.md` (verification routes, storage and Identity dependency); sync the service card and contract with the hub script. `/update-docs verification` applies the platform deltas directly on a hub branch off `origin/main` (user instruction 2026-10-02: no parked hub deltas; synced `catalog/*.card.md` and `contracts/*` only via `../vcare-hub/scripts/sync-from-spoke.sh`): `architecture/landscape.md` Case-1 implementation status, `architecture/deployment.md`/`capacity.md` MinIO development footprint and worker-loop roll-up, and `glossary.md` terms “upload intent”, “verification application”, and “identity sync job”. Identity docs/provider code have no verification delta; record the reinstatement contract discrepancy in that future work only.

## 15. Ordered `/develop verification` tasks

| Step | Build order and output | Safe split |
|---|---|---|
| 0 `[docs]` | Apply C1–C6 to Care contract; contract validation and conformance fixtures. | One owner for contract. |
| 1 `[infra]` | Verify exact AWS pins with `npm view`; install, Zod env, `.env.example`/`.env.test`, MinIO dev/test compose and private bucket setup. | Storage infra can split from Identity env after variable names are fixed. |
| 2 `[schema]` | Four raw-SQL migrations (§3), explicit grants, rollback/EXPLAIN tests. | One schema owner, sequential migration order. |
| 3 `[lib]` | `lib/storage` port + S3 adapter, MinIO adapter suite; `lib/identity-client` token/status/batch cache and DTOs. | Storage and Identity library work are independent. |
| 4 `[module]` | Verification enums/errors/types/entities/DTOs/repos; policy and service algorithms; doctors submit/read collaboration and edit lock. | DTO/repo may split after shared types freeze; one owner for doctors/verification transition. |
| 5 `[runtime]` | Worker loops/deps/close path, DI bootstrap, routes and mounts; request id, rate limit/idempotency and audit wiring. | Worker can split after libs/schema signatures freeze. |
| 6 `[test]` | Unit, real-service route integration, concurrency, RBAC, contract and MinIO suites (§10); fix findings. | Unit/adapter suites can run in parallel; integration owns shared DB fixtures. |
| 7 `[qa/docs]` | CURL manual QA, tasks status, as-built notes, service architecture/card changes and hub delta hand-off. | QA/docs after behavior is verified. |

## 16. As-built notes

As built and verified 2026-10-08 on `feature/verification` (HEAD 85c9a4d): unit 1154, integration 489 green; CURL manual QA 274 pass / 0 fail ([manual-qa.md](./manual-qa.md)). Where this section differs from §1–§15, this section is the as-built behavior. `contracts/openapi.yaml` already matches the routes and was not changed by `/update-docs`.

**Build record**
- Migrations (owner role, raw SQL, explicit `vcare_app` grants): `20261007120000_create_upload_intents`, `20261007120100_create_verification_documents`, `20261007120200_create_identity_sync_jobs`, `20261007120300_add_verification_queue_index`.
- Packages: `@aws-sdk/client-s3`, `@aws-sdk/s3-presigned-post`, `@aws-sdk/s3-request-presigner`, all pinned `3.1147.0` without `^`, imported only by `lib/storage/s3.adapter.ts`. No new ADR for the SDK; ADR 0020 records the local MinIO image.
- Routes: the ten new routes plus the live `submit=true` branch of `POST /doctors/apply` and `GET /doctors/me/application` match the contract operations `createVerificationUploadIntent`, `completeVerificationUpload`, `getMyVerificationDocumentDownloadUrl`, `deleteMyVerificationDocument`, `listApplications`, `getApplication`, `getApplicationDocumentDownloadUrl`, `approveApplication`, `rejectApplication`, `reopenApplication`.
- Worker: `care-worker` loops `identity-sync` (poll `IDENTITY_SYNC_POLL_SECONDS`, batch 50) and `upload-intent-purge` (5 min, batch 500, 7-day row retention); `node dist/worker.js --once identity-sync|upload-intent-purge` runs one tick. The worker pool is 4 connections (`WORKER_POOL_MAX` in `src/worker.ts`) because session advisory locks pin connections.
- Audit actions: `verification.submitted|approved|rejected|reopened|document_uploaded|document_deleted|documents_viewed|document_url_issued` and `identity_sync.pending|synced|failed`; worker-driven sync audits use actor kind `system`.

**Other as-built facts**
- `complete` serializes on a session advisory lock per intent (`lib/knex/session-advisory-lock.ts`; namespaces: intent 1101, per-doctor sync 1102, purge singleton 1103). The helper never pins the last pool connection and treats a pool acquire timeout as "not acquired"; a refused lock answers `409 Conflict` + `Retry-After: 1`. Step 9 also locks the intent row with `FOR UPDATE` inside its short transaction.
- `upload_verification_failed` is emitted with the single label `reason=invalid_file` (missing object, size out of range, and unrecognized bytes are not distinguished). `upload_intent_expired` is emitted by the purge loop and `identity_sync_jobs_processed` by each identity-sync tick; `upload_intent_created` and `download_url_issued` are not emitted.
- `UPLOAD_INTENT_PURGE_SECONDS` sets the `upload-intent-purge` interval. Orphaned final objects (a rolled-back step 9 whose best-effort delete failed) are not reconciled by a prefix scan; the bucket lifecycle and the `verification_orphan_cleanup_failed` log line are the backstops.
- A locally suspended doctor can still save a draft with `POST /doctors/apply` and `submit=false` (200); `submit=true`, intent, complete and delete answer `403 Forbidden`. This follows the doctors spec (no suspension check on apply); the decision is open (see manual-qa.md).
- The queue cursor is HMAC-signed with `SERVICE_CLIENT_SECRET`; rotating that secret invalidates outstanding cursors (they answer `400 ValidationFailed`).

**Known environment dependency.** Real Identity (`feature/internal`) serves only `/internal/auth/*` and health. `GET /internal/users` and `PATCH /internal/users/{id}/status` arrive with Identity's internal-users module, so Case 1 cannot reach `synced` against real Identity yet: Care keeps the decision, answers `202 identitySync:"pending"`, and the worker keeps retrying on `404` until a compliant API answers. Case 2 hydration degrades to `profileHydrated:false`. Manual QA used a contract-compliant shim (manual-qa.md → Re-run). Care needs no code change when the module lands.

Deviations from review `review-20261008-1500` (fix-review pass, 2026-10-08):
- **Pending-sync guard** on approve/reject (see §6); documented in the contract as `ApplicationDecisionConflict` (409 `ApplicationNotReviewable` or `Conflict` + `Retry-After: 5`). `identity_sync_status='failed'` does not block a decision (an admin may need to retry after fixing Identity by hand).
- **Promote is bound to the verified object**: `ObjectHead` carries the S3 `etag`; `promote(from, to, { etag, contentType })` sends `CopySourceIfMatch` and the content type the service detected. The adapter no longer re-reads or re-sniffs; a re-POST to the quarantine key after the checks makes the copy fail (`StorageError`, 500, intent stays open for retry).
- **No idempotency middleware** on `createIntent` and both `download-url` routes (§1 D6, §4).
- **Worker claim (supersedes the `SKIP LOCKED` wording in §3.3 and §7)**: `claimDuePendingJobs` (a no-op lock transaction) became the plain read `listDuePendingJobs` (served by `idx_identity_sync_jobs_pending_next_attempt_at`); the worker path (`processDueSyncJob`) re-checks `next_attempt_at <= now` inside the per-doctor session lock so a second worker cannot retry before the first one's backoff. The worker makes one Identity attempt per job per tick; the inline decision path makes three.
- **Pending-sync guard scope**: it refuses approve/reject whenever the locked profile is `identity_sync_status='pending'`, including a doctor-resubmitted application whose `pending` status change has not yet reached Identity.
- **Queue keyset** is two index-friendly phases (timestamped rows with `(submitted_at, id) > (?, ?)`, then the `submitted_at IS NULL` tail by id). EXPLAIN on 60k rows, page near the middle: old predicate `Filter` + 41,759 rows removed, 1,015 buffers, 7.6 ms; new `Index Cond` row comparison, 45 buffers, 0.14 ms.
- Resubmit (`finishSubmit`) returns status only and makes no Identity hydration call, and worker retries build no view, so they make no `GET /internal/users` call (fix `fac9c08`); alert logs `IdentitySyncTransitionRejected` / `IdentityApprovalSyncPending` carry `jobId` and `profileId`.
- Layering: `doctor_profiles` writes live in verification repo functions (`markProfileSubmitted`, `applyProfileDecision`, `setProfileIdentitySync`); the profile column list and mapper are shared from `src/app/doctors/doctor-profile.mapper.ts`; the HMAC queue cursor moved to `src/lib/http/pagination/signed-cursor.ts`.
