---
title: record-attachments — Spec
owner: care-team
service: care-service
module: record-attachments
status: implemented
version: 0.2.0
diataxis: reference
last_verified: 2026-10-20
tags: [spec, record-attachments, records, clinical, attachments, uploads, upload-intents, object-storage, lock-trigger, audit, clinical-privacy]
related: [record-attachments-brainstorm, records-spec, verification-spec, sessions-spec, clinical-records, file-handling, data-model, rbac, capacity, adr-0013-verified-direct-upload-lifecycle, adr-0014-on-demand-download-urls, adr-0015-aws-sdk-storage-adapter, adr-0017-generic-helpers-and-transaction-scoping, adr-0018-db-role-split-explicit-grants-partition-function, adr-0021-identity-sync-engine-module]
contracts: [contracts/openapi.yaml]
---

# record-attachments — Spec

The second half of the clinical record (decision R-D1 of the [records brainstorm](../records/brainstorm.md)): the files a doctor attaches to the record they wrote. Four routes
(`POST …/attachments/uploads`, `POST …/uploads/{uploadId}/complete`, `POST …/attachments/{attachmentId}/download-url`, `DELETE …/attachments/{attachmentId}`), one table
(`record_attachments`), one DB trigger, the real `MedicalRecord.attachments` list, and the **extraction of the shared `upload-intents` module** out of `verification` (RA-D1), which
is **build slice 1** and lands before any attachment code. Scope follows [brainstorm.md](./brainstorm.md) (approved 2026-10-18; decisions RA-D1..RA-D10 are binding and its open
questions 2, 3 and 5 are resolved and folded in below).

> **Status (2026-10-20, v0.2.0): implemented.** Built, tested and manually QA'd on branch `feature/record-attachments`; the review is clean (its file is deleted). **Section 14 (As-built notes)
> wins over sections 1-13 where they differ** (the sections below keep the design text of v0.1.0, 2026-10-18, for history; inline "as built" tags point to section 14). Contract edits C1-C6 and the CLAUDE.md
> `AttachmentLimitReached` row/sentence landed at step 0.

Binding rules: CLAUDE.md → "Security rules" (documents and attachments, rate limits, headers), "Privacy and logging", "Database rules" (soft delete, clinical tables, medical records,
files, FK indexes, transactions), "API conventions", "Authentication and service-to-service auth", "Authorization — RBAC and ownership", "Domain rules" 13-16, 18, 19, 22, "Testing
policy", "Performance rules", "Build order for a new module". Precedents (read first; this spec reuses their names and test layout): [records/spec.md](../records/spec.md) (sections
1.6, 3 and 13), [verification/spec.md](../verification/spec.md) (sections 3.1, 6 and 16 as built), [sessions/spec.md](../sessions/spec.md); design background:
[architecture/file-handling.md](../architecture/file-handling.md), [architecture/clinical-records.md](../architecture/clinical-records.md), [architecture/data-model.md](../architecture/data-model.md).

---

## 1. Overview

### 1.1 What `record-attachments` owns
| Area | Delivers |
|---|---|
| Tables | `record_attachments` (new, migration 3.1). `upload_intents` is unchanged in shape (a column comment only, migration 3.2) |
| DB objects | function `forbid_attachment_delete_after_lock()` and trigger `trg_record_attachments_forbid_delete_after_lock` |
| Routes | `POST /api/records/{id}/attachments/uploads` · `POST /api/records/{id}/attachments/uploads/{uploadId}/complete` · `POST /api/records/{id}/attachments/{attachmentId}/download-url` · `DELETE /api/records/{id}/attachments/{attachmentId}` |
| Modules | `src/app/record-attachments/` (new; router mounted after the records router) · `src/app/upload-intents/` (new; **extracted** from `verification`, section 2) |
| Cross-module service API added | `records`: `RecordLinksService.lockForNoKeyUpdate` (4.8). `record-attachments`: `RecordAttachmentLinksService.listByRecordIds` (the batch read used by the record views, 4.6). `upload-intents`: `UploadIntentsService` (section 2) |
| Behaviour lifted elsewhere | `MedicalRecord.attachments` becomes real on `GET /records/{id}`, the patient timeline and the `PATCH /records/{id}` `200` (records RC-R23 is superseded; section 4.9); the purge loop clears expired intents of **both** kinds |
| Lib additions | `lib/logger/redact.ts`: one key `attachmentDescription`; `lib/error/types.ts`: `AttachmentLimitReached`. **No** `lib/storage` change (no adapter change; the MinIO adapter suite is untouched) |
| Env / dependencies | none / none (`UPLOAD_POLICY_TTL_SECONDS`, `UPLOAD_INTENT_TTL_SECONDS`, `DOWNLOAD_URL_TTL_SECONDS`, `UPLOAD_INTENT_PURGE_SECONDS` exist; the AWS SDK packages are already pinned) |

### 1.2 Principles
- **Bytes never pass through `care-api`; the row exists only after `complete` verified the stored object** (ADR 0013): `HEAD` size 1 B-10 MB, 16 leading bytes are PDF, JPEG or PNG, ETag-bound `promote`. The filename and any declared `Content-Type` are never read.
- **Only the record's author writes** (RA-D2). Everyone else, related doctor included, is `404`; admins and patients are `403` at the role step. `NotAssignedDoctor` is never returned here.
- **The database is the last word on the lock and the cap; the service gives the precise error.** The delete-after-lock verdict is read with database time under `FOR NO KEY UPDATE` and repeated by a trigger; the cap of 20 is counted under the same row lock (the guarantee), after a courtesy check.
- **Adding appends, removing is pre-lock only** (Domain rule 15, RA-D3): adding after the lock is allowed and audited with `afterLock`; adding never `UPDATE`s `medical_records` (its lock trigger would refuse).
- **Download is authorize → audit (own committed transaction) → presign.** A failed audit insert fails the request: no URL (ADR 0014). Read DTOs never carry a URL or key.
- **Metadata only in reads; `description` is clinical free text** (RA-D10): never in logs, audit metadata, Redis or error details.
- **Soft delete keeps the object** (RA-D4): `deleted_at` is set, the stored object stays under `record-attachments/<uuid>` and is unreachable through the API; erasure is an owner-run procedure.
- **Admins never touch an attachment**: absent from every role list, no DTO has an admin form.

### 1.3 Dependencies
- **Other modules (services only):** `records` (`RecordLinksService.findAccessRow`, new `lockForNoKeyUpdate`; the exported `recordReaderRule` resolver factory), `doctors` (`DoctorsService.isLocallySuspended` through `doctorNotSuspendedCheck`), `patients` (the `PatientRelationshipChecker` port, bound to `ConsultationsService`), `upload-intents` (`UploadIntentsService`), `audit` (`AuditRecorder`).
- **Reverse consumers:** `records` (`RecordQueriesService`, `RecordsService`) calls `RecordAttachmentLinksService` for the metadata list. `RecordAttachmentLinksService` depends only on the database, so there is no constructor cycle (same shape as `RecordLinksService`, records 1.3).
- **External:** object storage through the existing `lib/storage` port (no new method, ADR 0015). Storage failures: intent creation and `download-url` presigning are local computation; `complete` follows the verification policy (section 6).
- **Other service:** none. No Identity call, no Case 1-4, no hydration (attachment DTOs carry ids only).

### 1.4 Contract drift check (against `contracts/openapi.yaml`, 2026-10-18; every numbered edit below is a contract change listed in section 12)
Operations `addRecordAttachment`, `deleteRecordAttachment`, `getMedicalRecord`, `listPatientRecords`, `updateMedicalRecord`, `createMedicalRecord`; schemas `RecordAttachment`, `RecordAttachmentUpload`, `MedicalRecord`, `UploadIntent`, `DownloadUrl`; responses `UploadIntentCreated`, `DownloadUrlOk`, `UploadIntentExpired`, `RecordLocked`, `RecordWriteForbidden`, `MedicalRecordOk`; the `ErrorCode` enum. The contract still describes the superseded multipart upload with inline signed URLs.

| # | Finding | Contract today | This spec |
|---|---|---|---|
| C1 | Upload lifecycle | `POST /api/records/{id}/attachments` (`addRecordAttachment`, `multipart/form-data`, schema `RecordAttachmentUpload`) | removed with `RecordAttachmentUpload`; three operations added (4.1) with a new request schema `RecordAttachmentIntentCreate`; success response `RecordAttachmentOk` |
| C2 | Read DTO embeds URLs | `RecordAttachment.required` lists `downloadUrl`, `downloadUrlExpiresAt` | both removed from `properties` and `required` (ADR 0014) |
| C3 | `MedicalRecord.attachments` | "Always `[]` until the `record-attachments` module ships" | live attachment metadata, oldest first, one batched query per page; `getMedicalRecord`, `listPatientRecords`, `updateMedicalRecord`, `createMedicalRecord` descriptions state it |
| C4 | `deleteRecordAttachment` | `403` is `RecordWriteForbidden` (`NotAssignedDoctor`), `x-ownership: assigned-doctor`, no check order, no rate limit, no `400` | `403` is plain `Forbidden`; `x-ownership: record-author`; `404` also for an absent, foreign or already deleted attachment; check order and rate limit stated; `'400'` added |
| C5 | Attachment cap | no code | new error `AttachmentLimitReached` (409): contract enum value, two responses; CLAUDE.md row and Domain-rules sentence (owner edit, section 12) |
| C6 | Extensions, headers, prose | `x-roles`/`x-ownership`/`x-account-state`/`x-audit` only on the old operations | the same extensions on the new operations, `Cache-Control: no-store` on every new response, rate-limit prose (20 uploads/h, 20/min, 120/min), admin `403` stated; `UploadIntentCreated` says "per user" |

### 1.5 Decisions folded in (RA-D1..RA-D10 verbatim from the brainstorm; spec-level decisions SD1..SD11 follow from sources; the owner may override)
- **RA-D1** extract the shared `upload-intents` module (behaviour-preserving refactor first, ADR 0022, section 2). **RA-D2** author-or-`404` on intent, complete and `DELETE` (resolver `record_attachment_writer`; `NotAssignedDoctor` never returned; suspended doctor `403`; admins `403`). **RA-D3** adding after the lock is allowed, no reason, audited with `afterLock` (database time), never `UPDATE`s `medical_records`. **RA-D4** soft delete keeps the stored object. **RA-D5** cap of 20 live attachments per record, `409 AttachmentLimitReached`. **RA-D6** a `BEFORE UPDATE` trigger on `record_attachments` reads the parent's `locked_at`; `check_violation` with `CONSTRAINT = trigger name` maps to `RecordLocked`; `404` before `409`. **RA-D7** record DTOs embed the attachment metadata through ONE `= ANY` query per page, no extra audit row. **RA-D8** no `Idempotency-Key` on any attachment route; `complete` is replayable through the intent's `result_id`. **RA-D9** per-user limits: intents 20/hour, `complete` + `DELETE` 20/min, `download-url` 120/min. **RA-D10** `description` is clinical free text (optional, not blank, no NUL, ≤ 500 code points).
- **Resolved open question 2:** no bare `description` redaction key (it collides with `specialties.description`, which is non-clinical and is listed by `specialties` code paths); the scoped key `attachmentDescription` is added to `REDACTED_KEYS` with a test row, and the rest is proved by a privacy test with a marker string. **Checked 2026-10-18:** `REDACTED_KEYS` holds no `description`; `src/` has no logger call that carries a `description` member (the only `description` properties are in `specialties` and `upload_intents` rows, and no log call passes a row, entity or request body); `description` is not an audit metadata key anywhere.
- **Resolved open question 3:** `RecordLinksService` is extended (database only, no cycle): the resolver uses the existing `findAccessRow`; one new method `lockForNoKeyUpdate(recordId, trx)` does the `FOR NO KEY UPDATE` read returning ids and `is_locked`. No cross-module repository import.
- **Resolved open question 5 (capacity):** holds, no platform change (section 9.4).

Spec-level decisions:
1. **SD1 - two services, not one.** The batch read that `records` needs is `RecordAttachmentLinksService` (database only, like `RecordLinksService`); the commands are `RecordAttachmentsService` (database, storage, audit, `UploadIntentsService`, env). `records` therefore never depends on storage or audit through this module, and registration order stays acyclic (4.11).
2. **SD2 - the scoped redaction key is the property name.** In `record-attachments` entities, types and service inputs the property is named `attachmentDescription` (column `description`, wire member `description`), so a stray `logger.info("x", { attachment })` redacts it by key. This is defence in depth only; the guarantee is that no call site logs it (privacy test, section 10). The shared `upload-intents` row keeps the column name `description` (a row is never logged; the same privacy test covers it).
3. **SD3 - cap check before storage, guarantee inside the transaction.** `complete` repeats the count before the `HEAD` (courtesy: a full record answers `409` with the quarantine object intact, so the doctor can delete one attachment and retry the same `complete`). The count inside the transaction is the guarantee. If it loses a race after `promote`, the transaction rolls back, the promoted object is deleted best-effort and the intent stays open with its quarantine object gone (the verification precedent for a late `Conflict`); a retry answers `400 ValidationFailed` (`file`) and closes it, and the purge closes it otherwise.
4. **SD4 - `lockForNoKeyUpdate` reads no clinical text.** It selects `id, patient_user_id, doctor_user_id` and `(locked_at <= NOW()) AS is_locked` only (not `findByIdForNoKeyUpdate`, which reads every clinical column).
5. **SD5 - `PATCH /records/{id}` `200` carries the attachments.** A record can hold attachments before its lock, so the in-place and no-op `200` bodies must list them; one extra statement in the existing transaction (4.9). The `201` amendment response and the create `201` are unchanged (a new record has none).
6. **SD6 - non-numeric ids are `404`.** `{id}` through the resolver; `{uploadId}` and `{attachmentId}` through the controller's `parsePositiveId` (`NotFound`), consistent with records ("private resources are `404`").
7. **SD7 - `viewerIsAuthor` from `uploaded_by_user_id`.** `uploaded_by_user_id` always equals the record's `doctor_user_id` (only the author writes), so the download audit needs no extra record read.
8. **SD8 - suspension is checked at the policy, not in the transaction** (records 1.5.3): a suspension committing between `authorize` and the write lets that one in-flight write through. The `complete` route re-runs `authorize` (role, state, suspension, author), which is the re-authorization at `complete`. **As built (section 14.1): superseded for `complete`.** The local suspension is re-checked inside the `complete` transaction, so only the statement-level race remains there; for `remove` SD8 stands unchanged (a one-statement window).
9. **SD9 - `record.read` audit metadata is unchanged.** The attachment list is part of the same read already audited as `record.read` / `patient_records.listed`; no `attachmentCount` key is added (existing audit assertions stay valid).
10. **SD10 - observable changes inside the extraction** (each covered by a test, section 2): the orphan-cleanup log event is `upload_orphan_cleanup_failed` with a `kind` field (was `verification_orphan_cleanup_failed`); `upload_verification_failed` gains the label `kind` next to `reason="invalid_file"`; the purge now lists and closes expired intents of every kind (it was verification-only, a latent gap: a `record_attachment` intent would never have been purged); on the rare "intent no longer open" conflict inside the short transaction the target row is no longer read before the throw (one statement fewer on a failure path only). These are the four differences section 2 lists.
11. **SD11 - separate rate-limit buckets.** Attachment intent creation (20/h) does not share a bucket with verification-document intents (`verification-intent`); a doctor has two independent hourly budgets.

### 1.6 Consequences worth stating once
- A mistaken attachment added **after** the lock can never be removed through the API (`409 RecordLocked`; Domain rule 15 + RA-D3). The doctor's remedy is an amendment that explains it; any real removal is an owner-run procedure.
- A soft-deleted attachment frees a cap slot and disappears from every read, but its object remains in the bucket (capacity.md §6: soft-deleted objects are not purged in MVP).
- A replayed `complete` of an intent whose attachment was since soft-deleted answers `409 Conflict` (the created row is no longer live).

---

## 2. The `upload-intents` extraction (RA-D1) — build slice 1, behaviour-preserving

**Why:** `verification` owns a private upload-intent lifecycle (intent insert/find/close, the per-intent advisory lock, the verify-and-promote step, the purge). `record-attachments` needs the identical lifecycle; copying it duplicates the riskiest storage code, and importing `VerificationService` or its repository would invert the dependency (CLAUDE.md → Folder structure and layering; precedent: ADR 0021, which extracted the Identity-sync engine). The extraction also fixes a latent gap: the purge is verification-kind only, so a `record_attachment` intent would never be purged.

**Module `src/app/upload-intents/`** (no routes, no controller, no policies; it knows no Care target):
- `constants.ts`: `UPLOAD_INTENT_LOCK_NAMESPACE = 1101` (was `VERIFICATION_INTENT_LOCK_NAMESPACE`, same value), `INTENT_PURGE_LOCK_NAMESPACE = 1103`, `INTENT_PURGE_LOOP_NAME = "upload-intent-purge"`, `INTENT_PURGE_BATCH = 500`, `INTENT_RETENTION_MS` (7 days), `MAX_UPLOAD_BYTES = 10_485_760` (was file-local in `verification.service.ts`), `QUARANTINE_KEY_PREFIX = "quarantine/"`. The identity-sync lock `1102` stays in `identity-sync/constants.ts`. `verification/constants.ts` keeps only `VERIFICATION_DOCUMENT_KEY_PREFIX = "verification-documents/"`.
- `enums.ts`: `UploadIntentKind` (moved from `verification/enums.ts`). `errors.ts`: `UploadIntentExpired` (moved from `verification/errors.ts`; `ApplicationNotEditable` and `ApplicationNotReviewable` stay).
- `types.ts`: `UploadIntentRow` (moved; `document_type` becomes `string | null` so the shared module imports nothing from `verification`; `VerificationService` narrows it with a guard and answers `Conflict` for an unknown value, as it did for a missing one), `UploadIntentResult`, `ExpiredIntentRef` (moved), and new `NewIntent`, `DetectedFileType`, `CompleteRequest<TRow, TTarget>`, `InsertedUpload<TRow>`, `CompletedUpload<TRow>`.
- `repository/upload-intents.repo.ts`: `INTENT_COLUMNS`, `insertIntent`, `findIntent`, `findIntentForUpdate`, `closeIntent(id, resultId = null, conn)` (only `WHERE consumed_at IS NULL`), `listExpiredOpenIntents(limit, conn)` (**the `kind = 'verification_document'` predicate is dropped**), `deleteIntentsOlderThan(cutoff, limit, conn)` (consumed rows only) — moved verbatim except the one predicate.
- `service/upload-intents.service.ts` — `UploadIntentsService` (`@injectable()`; deps `Db`, `STORAGE`, `Env`), public API:
  - `create(input: NewIntent): Promise<UploadIntentResult>` — key `quarantine/<randomUUID>`, `storage.createUploadPolicy(key, MAX_UPLOAD_BYTES, UPLOAD_POLICY_TTL_SECONDS)`, `expires_at = now + UPLOAD_INTENT_TTL_SECONDS`, `insertIntent`, return `{ uploadId, url, fields, expiresAt (ISO), maxBytes }`. Authorization is the caller's.
  - `complete<TRow, TTarget>(request: CompleteRequest<TRow, TTarget>): Promise<CompletedUpload<TRow>>` — the flow below. `CompleteRequest` carries `uploadId, kind, ownerUserId, finalKeyPrefix` and four callbacks: `authorizeTarget(intent, conn): Promise<TTarget>`, `findResult(resultId, conn): Promise<TRow | undefined>`, `precheck(target, conn): Promise<void>`, `insertResult({ intent, finalKey, fileType, sizeBytes }, trx): Promise<{ row: TRow; id: number }>`. `CompletedUpload` is `{ row: TRow; replay: boolean }`.
  - `findIntent(id, conn?)`, `withIntentLock(id, work)` (the per-intent session advisory lock, namespace 1101; `undefined` when refused), `listExpiredIntents(limit = 500): Promise<ExpiredIntentRef[]>`, `purgeExpiredIntent(id, quarantineKey)` (storage `delete` outside any transaction, then a short transaction: `findIntentForUpdate`, and `closeIntent(id, null)` only if still open and expired — **for any kind**), `deleteIntentsOlderThan(cutoff, limit = 500)`.
- `worker/upload-intent-purge.loop.ts`: `buildUploadIntentPurgeLoop({ service: UploadIntentsService, db, logger, intervalSeconds, now? })`, moved unchanged apart from the service type; tick under the singleton advisory lock (1103, id 0), per intent `withIntentLock` then `purgeExpiredIntent`, then `deleteIntentsOlderThan`; metric `upload_intent_expired` (the purged count, unchanged), log `upload_intent_purge_done`; loop name `upload-intent-purge`.

**The shared `complete` flow** (it is verification's flow with the domain calls turned into callbacks; statement and storage order are unchanged):
1. `withSessionAdvisoryLock(db, 1101, uploadId, …)`; a refused lock → `Conflict.withExtra({ retryAfter: 1 })`.
2. `findIntent`; absent, `kind !== request.kind` or `owner_user_id !== request.ownerUserId` → `NotFound`.
3. `target = await request.authorizeTarget(intent, db)` (throws `NotFound`/`Forbidden`).
4. `intent.result_id !== null` → `request.findResult`; `undefined` → `Conflict`; else `{ row, replay: true }` (no audit).
5. `intent.consumed_at !== null` → `Conflict`.
6. Expired → `storage.delete(quarantine_key)`, short transaction `closeIntent(id, null)`, `UploadIntentExpired`.
7. `await request.precheck(target, db)`.
8. `head = storage.headObject`; `bytes = storage.readHead(key, 16)` only when `1 ≤ head.sizeBytes ≤ max_bytes`; `fileType = detectFileType(bytes)`. Invalid → `storage.delete`, `closeIntent(id, null)`, metric `upload_verification_failed{reason: "invalid_file", kind}`, `ValidationFailed.withDetails([{ field: "file", issue: "stored file is invalid" }])`.
9. `finalKey = finalKeyPrefix + randomUUID()`; `storage.promote(quarantineKey, finalKey, { etag: head.etag, contentType: fileType })`; `storage.delete(quarantineKey)`.
10. One transaction: `findIntentForUpdate`; absent, owner changed, consumed or expired → `Conflict`; `inserted = await request.insertResult({ intent: locked, finalKey, fileType, sizeBytes: head.sizeBytes }, trx)`; `closeIntent(intent.id, inserted.id, trx)`. On any failure: best-effort `storage.delete(finalKey)`, `logger.error("upload_orphan_cleanup_failed", { kind })` if that fails, rethrow.
11. Return `{ row: inserted.row, replay: false }`.

**`verification` after the extraction.** `VerificationService` gains the last constructor argument `@inject(TOKENS.UploadIntentsService) intents: UploadIntentsService` and loses `listExpiredIntents`, `listExpiredOpenIntents`, `purgeExpiredIntent`, `closeExpiredIntent`, `withIntentLock`, `deleteIntentsOlderThan`, `VERIFICATION_INTENT_LOCK_NAMESPACE` and `MAX_UPLOAD_BYTES`. Its `createIntent` keeps `findProfileByUserId` + `assertEditable` and then calls `intents.create({ kind: VerificationDocument, targetId: profile.id, ownerUserId, documentType: type, description: null })`. Its `complete` becomes a call to `intents.complete` with: `finalKeyPrefix = "verification-documents/"`; `authorizeTarget` = `findProfileById(intent.target_id)` and owner check (`NotFound`), returning the profile; `findResult` = `findDocument`; `precheck` = `assertEditable(profile)`; `insertResult` = re-lock the profile (`findProfileById(id, trx, true)`, absent → `Conflict`), `assertEditable`, narrow `document_type` (else `Conflict`), `insertDocument`, audit `verification.document_uploaded`. `repository/verification.repo.ts` loses the intent functions and `INTENT_COLUMNS`. `policies.ts`: `buildVerificationPolicies(intents: Pick<UploadIntentsService, "findIntent">)` (a policy never imports another module's repository); `routes.ts` passes the container's `UploadIntentsService`. `UploadIntentKind`, `UploadIntentExpired` and the intent types are imported from `upload-intents`.

**Wiring.** `TOKENS.UploadIntentsService`; `bootstrap.ts` registers `UploadIntentsService` **immediately before** `VerificationService` (it needs only `Db`, `STORAGE`, `Env`, all registered earlier). `worker-loops.ts` builds `new UploadIntentsService(deps.db, deps.storage, deps.env)`, passes it as the last argument of `new VerificationService(...)` and as `service` of the purge loop; the loop stays third in the list (audit partitions, identity sync, **upload-intent purge**, outbox, reminders, outbox purge), `node dist/worker.js --once upload-intent-purge` is unchanged.

**Intentional, observable differences (all covered by tests; SD10):** (1) log event `upload_orphan_cleanup_failed` with field `kind` replaces `verification_orphan_cleanup_failed` (no test or alert referenced the old name; docs are updated); (2) the metric `upload_verification_failed` carries `kind` in addition to `reason`; (3) the purge covers every kind; (4) on the rare "intent no longer open" conflict inside step 10 the profile row is no longer read before the throw (one statement fewer on a failure path; the happy path is statement-for-statement identical).

**Behaviour-preservation strategy** (verification's tests are the oracle; no assertion is weakened, relaxed or deleted):
1. **Baseline first.** Before any move: run `npm test` and `npm run test:integration` and record the counts; run `scripts/curl-test-verification.sh` and record its pass count (274 / 0 at the verification build).
2. **Golden statement test, written on the pre-extraction code.** Add to `tests/integration/verification.test.ts` one test (committed **before** the move, passing on the old code) that captures the ordered SQL shapes and the `InMemoryObjectStorage` call list of: `createIntent`, a happy-path `complete`, a replayed `complete`, an expired `complete`, a false-bytes `complete`, and one purge tick over an expired intent. After the move it must pass **unchanged**.
3. **Mechanical test edits only** (the complete list): `tests/unit/app/verification/verification-service.test.ts` (spy targets `findIntent`, `findIntentForUpdate`, `closeIntent` repoint from `verification.repo` to `upload-intents.repo`; the constructor gets `new UploadIntentsService(db, storage, getEnv())` as the last argument; `buildVerificationPolicies({ findIntent })`); `tests/unit/app/verification/verification-worker.test.ts` moves to `tests/unit/app/upload-intents/upload-intents-worker.test.ts` (type of the mocked service, import paths); `tests/integration/verification.test.ts` (token list / `UploadIntentsService` re-registration after `STORAGE` is rebound, `new UploadIntentsService(pool, storage, getEnv())` in the `describe.each([2, 4])` pool tests so the advisory-lock pin counter sees the same pool, the loop is built from `container.resolve(UploadIntentsService)`); `tests/integration/admin-doctors.test.ts` (token list + re-registration, same reason). `tests/integration/worker-partitions.test.ts` and `tests/unit/contract/verification-contract.test.ts` are unchanged. Review gate: `git diff -U0 tests/` over these files shows no changed `expect(...)` line.
4. **New tests at the new boundary** (section 10): the same cases the verification tests cover, transplanted to `UploadIntentsService` and run for `kind = record_attachment` too; namespace and loop-name constants pinned (`1101`, `1102`, `1103`, `upload-intent-purge`); the purge closes expired intents of **both** kinds.
5. **Commit boundary.** The extraction lands in its own commits (E0-E1, section 13) with verification's unit, integration and manual-QA suites green **before** any attachment migration, route or contract edit.

**ADR 0022 (`docs/adr/0022-upload-intents-module.md`, written in step E0)** records: the extraction and its reasons; "the shared module knows no preconditions: each module supplies target authorization, the final key prefix and the row insert" (the ADR 0021 shape); the namespace table (1101 intent, 1102 identity sync, 1103 purge singleton, unchanged); SD10's four differences; alternatives rejected — keep it in `verification` and import it (cross-module private coupling, inverted dependency), copy it per module (two copies of the riskiest storage code), place the verify-and-promote step in `lib/storage` (it also closes intents and emits the failure metric, i.e. it is intent lifecycle, not storage).

---

## 3. Database schema

Two migrations (`npm run migrate:make`), raw SQL via `knex.raw` (one statement per call), owner role (`MIGRATION_DATABASE_URL`), explicit grants (ADR 0018). Both sort after `20261017120200_add_consultations_follow_up_fk`. The header comment of each file cites this section. DDL follows [data-model.md](../architecture/data-model.md) with the **documented deviations** marked below (`/update-docs` refreshes data-model.md).

### 3.1 `20261018120000_create_record_attachments`
```sql
CREATE TABLE record_attachments (
    id                   BIGSERIAL PRIMARY KEY,
    medical_record_id    BIGINT NOT NULL,
    uploaded_by_user_id  BIGINT NOT NULL,                 -- Identity user id (always the record's author)
    object_key           VARCHAR(512) NOT NULL,           -- record-attachments/<uuid>; never a URL; never logged
    file_type            VARCHAR(32) NOT NULL,            -- the DETECTED type
    size_bytes           INT NOT NULL,                    -- the HEAD size
    description          VARCHAR(500),                    -- clinical free text; never logged
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at           TIMESTAMPTZ,
    CONSTRAINT fk_record_attachments_medical_record_id FOREIGN KEY (medical_record_id) REFERENCES medical_records(id) ON DELETE RESTRICT,
    CONSTRAINT uq_record_attachments_object_key UNIQUE (object_key),
    CONSTRAINT chk_record_attachments_file_type CHECK (file_type IN ('application/pdf', 'image/jpeg', 'image/png')),
    CONSTRAINT chk_record_attachments_size CHECK (size_bytes BETWEEN 1 AND 10485760),
    CONSTRAINT chk_record_attachments_description CHECK (description IS NULL OR btrim(description) <> '')
);

-- Record view, timeline page and PATCH 200: the live attachments of a page of records in ONE query
--   SELECT <summary columns> FROM record_attachments WHERE medical_record_id = ANY($1) AND deleted_at IS NULL ORDER BY id
-- the cap count   SELECT count(*) FROM record_attachments WHERE medical_record_id = $1 AND deleted_at IS NULL
-- and the leading-column index of fk_record_attachments_medical_record_id.
CREATE INDEX idx_record_attachments_medical_record_id ON record_attachments (medical_record_id, id) WHERE deleted_at IS NULL;

-- The 24 h lock for removal, in the database: a soft delete (deleted_at going NULL -> NOT NULL) is refused once the PARENT record is locked.
-- Same clock as the service (the transaction's NOW()); CONSTRAINT lets the service recognize the refusal by error.constraint.
CREATE OR REPLACE FUNCTION forbid_attachment_delete_after_lock() RETURNS trigger AS $$
DECLARE
    parent_locked_at TIMESTAMPTZ;
BEGIN
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
        SELECT locked_at INTO parent_locked_at FROM medical_records WHERE id = OLD.medical_record_id;
        IF parent_locked_at <= NOW() THEN
            RAISE EXCEPTION 'record % is locked; attachment % cannot be removed', OLD.medical_record_id, OLD.id
                USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_record_attachments_forbid_delete_after_lock';
        END IF;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_record_attachments_forbid_delete_after_lock
    BEFORE UPDATE ON record_attachments FOR EACH ROW EXECUTE FUNCTION forbid_attachment_delete_after_lock();

-- ADR 0018, column level: the app role can read, append six columns, and set deleted_at. No DELETE, no TRUNCATE, no other UPDATE.
GRANT SELECT ON record_attachments TO vcare_app;
GRANT INSERT (medical_record_id, uploaded_by_user_id, object_key, file_type, size_bytes, description) ON record_attachments TO vcare_app;
GRANT UPDATE (deleted_at) ON record_attachments TO vcare_app;
GRANT USAGE ON SEQUENCE record_attachments_id_seq TO vcare_app;
```
- **Deviations from data-model.md:** (a) `chk_record_attachments_description` is new (mirror of the DTO's not-blank rule; NUL cannot be stored in Postgres text); (b) the trigger and function are new (RA-D6); (c) the grants are column level (the design file lists none); (d) the `COMMENT ON` lines below.
- **Trigger scope:** it fires only on the `deleted_at` NULL → NOT NULL transition, exactly as RA-D6 words it. The app role cannot update any other column (grant), and no route sets `deleted_at` back to `NULL`; a future restore feature would need its own guard. The trigger reads the parent with a plain `SELECT` (invoker rights: `care_app` holds `SELECT` on `medical_records`); the service already holds `FOR NO KEY UPDATE` on the parent when it deletes, so the two verdicts cannot diverge inside the service path. The trigger is a backstop for any other writer.
- **FK index.** `fk_record_attachments_medical_record_id` is covered by `idx_record_attachments_medical_record_id`, a **partial** index (`WHERE deleted_at IS NULL`), as designed in data-model.md. A `DELETE` of a parent `medical_records` row (owner role only; the app holds no `DELETE`) would have to check soft-deleted children without the index; erasure is an owner-run procedure that deletes children first. Accepted.
- **No defaults on critical columns:** `file_type`, `size_bytes` and `object_key` come from the verified upload; `created_at` takes `DEFAULT NOW()` like the other clinical tables; neither it nor `id` is grantable for insert.
- Comments (`COMMENT ON`): table "File attached to a medical record by its author; soft delete only, refused once the record is locked; the object is kept"; `uploaded_by_user_id` "Identity user id (always the record's author)"; `object_key` "Storage key; never a URL; never logged"; `description` "Clinical free text; never logged".
- **Clinical table:** no `ON DELETE CASCADE`.
- `down`: `DROP TABLE IF EXISTS record_attachments;` (drops its indexes and trigger) then `DROP FUNCTION IF EXISTS forbid_attachment_delete_after_lock();`.

### 3.2 `20261018120100_comment_upload_intents_description`
```sql
COMMENT ON COLUMN upload_intents.description IS 'Clinical free text (record attachment description); never logged; purged with the row after 7 days';
```
`down`: `COMMENT ON COLUMN upload_intents.description IS NULL;`. No other change to `upload_intents`: `kind = 'record_attachment'` and a non-null `description` are already allowed by `chk_upload_intents_kind` and `chk_upload_intents_document_type`, `idx_upload_intents_expires_at_open` and `idx_upload_intents_created_at` already serve the purge.

### 3.3 Indexes used (no other new index)
| Index | Serves |
|---|---|
| `idx_record_attachments_medical_record_id (medical_record_id, id) WHERE deleted_at IS NULL` | the batch list (record view, timeline page, `PATCH` 200), the cap count (intent creation, `complete` pre-check, `complete` transaction), the FK |
| `idx_record_attachments_medical_record_id` (as built: the planner picks it for `findLive(id, recordId)` because both columns are equality predicates, still a one-row index access with no Seq Scan) · PK `record_attachments_pkey` | `findLive(id, recordId)` (download-url, delete) · `findLiveById` (replay) by PK |
| PK `medical_records_pkey` | resolver access row, `lockForNoKeyUpdate` |
| `idx_upload_intents_expires_at_open` | purge listing (now without the `kind` predicate) |
| `idx_upload_intents_created_at` | purge of consumed rows older than 7 days |
| `idx_consultations_doctor_user_id_patient_user_id` (existing) | the relationship `EXISTS` of `record_reader` |

### 3.4 Migration tests
`tests/integration/migrations.test.ts` (additions): round trip of both migrations (`down` then `up`; named constraints, the index and the trigger exist; the records migrations are stepped down **after** these two and up before them); `chk_record_attachments_file_type`, `_size` (0 and 10 485 761), `_description` (blank) reject; `uq_record_attachments_object_key` rejects a duplicate with `23505` and the constraint name; a dangling `medical_record_id` is `23503`; a `DELETE` of a referenced `medical_records` row (owner role) is `23001` (`restrict_violation`) with the constraint name; **the trigger boundary in ONE transaction** (insert a record with `created_at = NOW() - interval '24 hours' + interval '1 microsecond'` so `locked_at = NOW() + 1 µs`, insert an attachment, set `deleted_at` → allowed; a second record with `created_at = NOW() - interval '24 hours'` (`locked_at = NOW()`) → the same update raises `check_violation` with `constraint = 'trg_record_attachments_forbid_delete_after_lock'`; the identical update of an already-deleted row is not re-checked); an owner-role update of a column other than `deleted_at` after the lock is not blocked by the trigger (the guarantee for those columns is the grant); grants asserted with `has_table_privilege` / `has_column_privilege` for `care_app`: `record_attachments` select yes; insert on exactly the six columns yes and on `id`, `created_at`, `deleted_at` no; table-level update no; column update on `deleted_at` yes and on `medical_record_id`, `uploaded_by_user_id`, `object_key`, `file_type`, `size_bytes`, `description`, `created_at`, `id` no; delete and truncate no; sequence usage yes. `tests/integration/db-roles.test.ts` gets the same grant rows. PostgreSQL 18 note: constraint-name queries exclude `contype = 'n'` (as the records tests do).

---

## 4. API contract and file-level design

### 4.1 Endpoints (the contract wins on disagreement; edits C1-C6 first)
Common: `userGuard()` → `authorize(policy)` → limiter → controller (the order of `src/app/records/routes.ts`). **No `Idempotency-Key`** on any of the four: it is not declared in the contract, the header is ignored when sent, and no route is behind the idempotency middleware, because the middleware would store responses that hold POST policies or URLs in Redis (RA-D8). `Cache-Control: no-store` on every response (`/api/records` is already in `NO_STORE_PREFIXES`, including a malformed-JSON `400`). Identity headers are ignored. A well-formed body on a route that takes none is `400 ValidationFailed` (`assertEmptyBody`).

| | `POST /records/{id}/attachments/uploads` | `POST /records/{id}/attachments/uploads/{uploadId}/complete` |
|---|---|---|
| Guard | user | user |
| Roles | doctor (admin, patient `403`) | doctor (admin, patient `403`) |
| Ownership | resolver `record_attachment_writer` (4.10): the record is live **and** `doctor_user_id = auth.userId`; else `404` | same resolver; the service then requires the intent: kind `record_attachment`, `owner_user_id` = caller, `target_id` = the path record, else `404` |
| Account state | `status=active` + `doctor_not_suspended` check (`403 Forbidden`); a pending or rejected doctor `403` | same |
| Audit | none (an intent is not a clinical row) | `attachment.added` (policy class `clinical-write`), same transaction as the insert; none on replay |
| Rate limit | `record-attachments-intent-user` 20/hour per user | `record-attachments-write-user` 20/min per user (shared with `DELETE`) |
| Body | `RecordAttachmentIntentCreate` `{ description? }`; absent body = `{}` | none |
| Success | `201` `UploadIntent` `{ uploadId, url, fields, expiresAt, maxBytes }` | `201` `RecordAttachment` (new row) or `200` (replay of a completed intent) |
| Errors | 400 `ValidationFailed`, 401, 403 `Forbidden`, 404, 409 `AttachmentLimitReached`, 429, 500 | 400 `ValidationFailed` (`details[].field = file`, stored file invalid), 401, 403, 404, 409 (`Conflict`, `AttachmentLimitReached`; `Conflict` with `Retry-After: 1` when another request holds the intent lock), 410 `UploadIntentExpired`, 429, 500 |

| | `POST /records/{id}/attachments/{attachmentId}/download-url` | `DELETE /records/{id}/attachments/{attachmentId}` |
|---|---|---|
| Guard | user | user |
| Roles | patient, doctor (**admin `403`**) | doctor (admin, patient `403`) |
| Ownership | resolver `record_reader` (**reused**, exported from `records/policies.ts`): the record's patient; the author; or a consulted doctor (`booked`/`waiting`/`in_progress`/`completed`), not locally suspended; else `404`. The service then requires the attachment to be live **and** to belong to the path record, else `404` | resolver `record_attachment_writer`; the service then requires the attachment to be live and to belong to the path record |
| Account state | `status=active`; a locally suspended doctor receives `404` through the resolver (records R-D5); a pending or rejected doctor `403` | `status=active` + `doctor_not_suspended` (`403`) |
| Audit | `attachment.url_issued` (policy class `clinical-read`), in its own committed transaction **before** presigning; a failed insert → `500`, no URL; `404`/`403`/`429` write no row | `attachment.removed` (policy class `clinical-write`), same transaction as the update |
| Rate limit | `record-attachments-read-user` 120/min per user | `record-attachments-write-user` 20/min per user |
| Body | none | none |
| Success | `200` `DownloadUrl` `{ url, expiresAt }` (presigned GET, 60 s, `attachment` disposition, the stored verified content type) | `204` |
| Errors | 400 (non-empty body), 401, 403, 404, 429, 500 | 400 (non-empty body), 401, 403, 404, 409 `RecordLocked`, 429, 500 |

**Check order** (the first failure wins; part of the contract descriptions):
- **intent:** token `401` → role / status / suspension `403` → resolver `404` (absent record, not the author, non-numeric id) → limiter `429` → body `400` → service: record re-read `404` → live count ≥ 20 `409 AttachmentLimitReached` → presign and insert.
- **complete:** `401` → `403` → resolver `404` → `429` → `{uploadId}` non-numeric `404`, body `400` → service under the per-intent lock: intent foreign / wrong kind / wrong record `404` → replay `200` → consumed without result `409 Conflict` → expired `410` → live count ≥ 20 `409 AttachmentLimitReached` → stored object invalid `400` → promote → transaction.
- **download-url:** `401` → `403` → resolver `404` → `429` → `{attachmentId}` non-numeric `404`, body `400` → service transaction: attachment live and in this record `404` → audit row → commit → presign.
- **delete:** `401` → `403` → resolver `404` → `429` → `{attachmentId}` non-numeric `404`, body `400` → service transaction: record lock `404` → attachment live and in this record **`404`** → locked **`409 RecordLocked`** → update → audit.

**Request rules (class-validator, `forbidNonWhitelisted`, implicit conversion off):**
- `RecordAttachmentIntentDto`: `description` optional (`@ValidateIf((_o, v) => v !== undefined)`) `@IsString() @NotBlank() @CodePointLength(1, 500) @NoControlCharacters("nul")`; JSON `null` is rejected (a value is set or absent); unknown members rejected; `toInput()` → `{ attachmentDescription: string | null }`. The controller validates `req.body ?? {}`.
- `complete`, `download-url`, `DELETE`: `assertEmptyBody(req.body)`; path ids via `parsePositiveId`, `undefined` → `NotFound`.

**Response shapes** (plain DTO classes with `static from(...)`, viewer-aware; none contains a URL, key, bucket or POST field outside the one intent response):
- `RecordAttachment` (`RecordAttachmentResponseDto.from(source, viewer)`): `{ id, recordId, fileType, sizeBytes, description (null when absent), createdAt (UTC ISO) }`. A viewer with role `admin` is a programming error (`Error("record_attachment_viewer_not_permitted")`, `500` if ever reached); patients and doctors get the same shape. `uploadedByUserId`, `objectKey`, `deletedAt` are never emitted.
- `UploadIntent`: the `UploadIntentResult` of `UploadIntentsService.create` (no DTO class, as `verification`): `{ uploadId, url, fields, expiresAt (ISO), maxBytes }`; `maxBytes` is 10 485 760. `fields` carries the POST policy (including the exact quarantine key) and is **never logged or stored** (`fields` and `url` are redacted keys).
- `DownloadUrl`: `{ url, expiresAt }` from `storage.presignDownload`.
- `MedicalRecord.attachments`: `RecordAttachment[]` oldest first (`id` order), live rows only; see 4.9.

### 4.2 Route composition (`src/app/record-attachments/routes.ts`)
```ts
router.post  ("/records/:id/attachments/uploads",                         userGuard(), authorize(p.createIntent), intentLimit(), c.createIntent);
router.post  ("/records/:id/attachments/uploads/:uploadId/complete",      userGuard(), authorize(p.complete),     writeLimit(),  c.complete);
router.post  ("/records/:id/attachments/:attachmentId/download-url",      userGuard(), authorize(p.downloadUrl),  readLimit(),   c.downloadUrl);
router.delete("/records/:id/attachments/:attachmentId",                   userGuard(), authorize(p.remove),       writeLimit(),  c.remove);
return sealRouter(router);
```
`src/routes.ts`: `router.use(buildRecordAttachmentsRouter())` is registered **after** `buildRecordsRouter()`. No path collides: the new paths have more segments than `/records/:id`; `…/attachments/uploads` (POST) is a different path from `…/attachments/:attachmentId/download-url`; a `DELETE …/attachments/uploads` reaches the delete route with `attachmentId = "uploads"`, which `parsePositiveId` answers `404`. The boot assertion (`assertRoutesAuthorized`) covers the router. No `noStore()` middleware is mounted in this router (the prefix list already applies it before body parsing). Limiters are built from the module's `constants.ts` by `rate-limits.ts` (4.12), never copied from another module.

### 4.3 File list
```
src/app/record-attachments/
  constants.ts   enums.ts   errors.ts   types.ts   policies.ts   routes.ts   rate-limits.ts
  entity/record-attachment.entity.ts
  dto/record-attachments.request.dto.ts   dto/record-attachments.response.dto.ts
  repository/record-attachments.repo.ts
  service/record-attachments.service.ts        createIntent / complete / downloadUrl / remove
  service/record-attachment-links.service.ts   listByRecordIds (database only)
  controller/record-attachments.controller.ts
src/app/upload-intents/                         (extracted; section 2)
  constants.ts   enums.ts   errors.ts   types.ts
  repository/upload-intents.repo.ts
  service/upload-intents.service.ts
  worker/upload-intent-purge.loop.ts
src/migrations/20261018120000_create_record_attachments.ts
src/migrations/20261018120100_comment_upload_intents_description.ts
```
Edited (section 2 for the extraction, 4.9 for records): `verification` (service, repo, policies, controller wiring, enums, errors, types, constants), `src/worker-loops.ts`, `src/bootstrap.ts`, `src/lib/di/tokens.ts`, `src/routes.ts`, `src/lib/logger/redact.ts`, `src/lib/error/types.ts`, `records` (`policies.ts`, `types.ts`, `repository/medical-records.repo.ts`, `service/record-links.service.ts`, `service/record-queries.service.ts`, `service/records.service.ts`, `controller/records.controller.ts`, `dto/records.response.dto.ts`).

### 4.4 Entity and types
- `RecordAttachment` plain class (`constructor(data: Partial<RecordAttachment>)`): `id, recordId, uploadedByUserId, objectKey, fileType, sizeBytes, attachmentDescription, createdAt, deletedAt` (SD2).
- `types.ts` (no inline types elsewhere): `RecordAttachmentRow` (snake_case, all columns), `RecordAttachmentSummaryRow` (`id, medical_record_id, file_type, size_bytes, description, created_at`), `RecordAttachmentSummary` (`id, recordId, fileType, sizeBytes, attachmentDescription, createdAt`; the batch list returns it and `RecordAttachment` satisfies it), `NewRecordAttachment` (`recordId, uploadedByUserId, objectKey, fileType, sizeBytes, attachmentDescription`), `AttachmentViewer` (`userId, role`), `CompletedAttachment` (`attachment: RecordAttachment; replay: boolean`), `RecordAttachmentsRoute` (`"createIntent" | "complete" | "downloadUrl" | "remove"`), `RecordAttachmentsPolicies`.
- `enums.ts`: `RecordAttachmentAuditAction { Added = "attachment.added", Removed = "attachment.removed", UrlIssued = "attachment.url_issued" }`.
- `errors.ts`: `AttachmentLimitReached = new AppError("AttachmentLimitReached", 409, "A record can hold at most 20 attachments")`. `RecordLocked`, `NotFound`, `Forbidden`, `Conflict`, `ValidationFailed` are the existing singletons (`RecordLocked` is imported from `records/errors`, the one definition of the code).
- `constants.ts`: `RECORD_ATTACHMENT_ENTITY_TYPE = "record_attachment"`; `RECORD_ATTACHMENT_MAX_PER_RECORD = 20`; `ATTACHMENT_DESCRIPTION_MAX_LENGTH = 500`; `RECORD_ATTACHMENT_KEY_PREFIX = "record-attachments/"`; `TRG_RECORD_ATTACHMENTS_FORBID_DELETE_AFTER_LOCK = "trg_record_attachments_forbid_delete_after_lock"`; the rate-limit constants (4.12).

### 4.5 Repository (`record-attachments.repo.ts`; functions, `conn: Knex = db`, explicit columns, `deleted_at IS NULL` on every read)
`RECORD_ATTACHMENT_COLUMNS` (all nine) and `RECORD_ATTACHMENT_SUMMARY_COLUMNS` (six; **no `object_key`, no `uploaded_by_user_id`**, so the list path cannot leak a key even by mistake).
- `insertAttachment(input, trx)` — `INSERT (medical_record_id, uploaded_by_user_id, object_key, file_type, size_bytes, description) VALUES (...) RETURNING <all columns>`. `23505` on `uq_record_attachments_object_key` is unreachable (random UUID) and is a programming error (`500`).
- `findLive(id, recordId, conn)` — `WHERE id = $1 AND medical_record_id = $2 AND deleted_at IS NULL` (planned on `idx_record_attachments_medical_record_id`, see 3.3); absent, foreign or deleted → `undefined`.
- `findLiveById(id, conn)` — replay lookup (`WHERE id = $1 AND deleted_at IS NULL`).
- `countLiveByRecord(recordId, conn)` — `SELECT count(*)::int ... WHERE medical_record_id = $1 AND deleted_at IS NULL`.
- `softDelete(id, trx)` — `UPDATE record_attachments SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL` returning the affected count; the trigger is the guard.
- `listByRecordIdsQuery(recordIds, conn)` (exported for EXPLAIN) / `listByRecordIds(recordIds, conn)` — `SELECT <summary columns> ... WHERE medical_record_id = ANY(?::bigint[]) AND deleted_at IS NULL ORDER BY id`, grouped in memory by `recordId` into `Map<number, RecordAttachmentSummary[]>`; an empty input issues no query and returns an empty map. Never one query per record.

`records` adds `findLockRowForNoKeyUpdate(id, trx)` to `medical-records.repo.ts`: `SELECT id, patient_user_id, doctor_user_id, (locked_at <= NOW()) AS is_locked FROM medical_records WHERE id = $1 AND deleted_at IS NULL FOR NO KEY UPDATE` (the lock and the verdict come from one statement; no clinical column).

### 4.6 Services

**`RecordAttachmentsService`** (`@injectable()`; deps `Db`, `AuditRecorder`, `RecordLinksService`, `UploadIntentsService`, **`DoctorsService` (`Pick<…, "isLocallySuspended">`, as built, 14.1), `STORAGE` (`ObjectStorage`, for `presignDownload`)**, `Env`). Transactions in Knex's handler form, repositories take the `trx`, storage calls happen outside every transaction.

**`createIntent(actor, recordId, input)`** (no transaction, no audit):
1. `access = links.findAccessRow(recordId)`; absent, or `doctorUserId !== actor.userId` → `NotFound` (defence in depth: the resolver already guaranteed it).
2. `countLiveByRecord(recordId) >= 20` → `AttachmentLimitReached` (courtesy; the guarantee is in `complete`).
3. `intents.create({ kind: RecordAttachment, targetId: recordId, ownerUserId: actor.userId, documentType: null, description: input.attachmentDescription })` → key `quarantine/<uuid>`, `storage.createUploadPolicy(key, 10 485 760, UPLOAD_POLICY_TTL_SECONDS)` (local signing, no network), `insertIntent` with `expires_at = now + UPLOAD_INTENT_TTL_SECONDS` (15 min). Returns `UploadIntentResult`.

**`complete(actor, recordId, uploadId)`** delegates to `UploadIntentsService.complete` (section 2) with these callbacks, so the order of the shared flow is the order of verification's `complete`:
- `kind = record_attachment`, `ownerUserId = actor.userId`, `finalKeyPrefix = "record-attachments/"`.
- `authorizeTarget(intent, conn)`: `intent.target_id !== recordId` → `NotFound`; `access = links.findAccessRow(recordId, conn)`; absent or `doctorUserId !== actor.userId` → `NotFound`; returns `access`.
- `findResult(resultId, conn)`: `findLiveById` (a since-deleted attachment is `undefined` → the shared flow answers `Conflict`).
- `precheck(access, conn)`: `countLiveByRecord(recordId, conn) >= 20` → `AttachmentLimitReached` (SD3). **Not** a lock check: adding after the lock is allowed.
- `insertResult({ intent, finalKey, fileType, sizeBytes }, trx)`, inside the shared short transaction **after** the intent row is locked and re-validated (open, owner, unexpired):
  1. `lock = links.lockForNoKeyUpdate(recordId, trx)`; absent, or `lock.doctorUserId !== actor.userId` → `NotFound`.
  1a. **(as built, 14.1)** `DoctorsService.isLocallySuspended(actor.userId, trx)` (read on the open transaction); suspended → `Forbidden`: rollback, the shared flow deletes the promoted object, the intent stays open.
  2. `countLiveByRecord(recordId, trx) >= 20` → `AttachmentLimitReached` (**the guarantee**: the count runs under the record row lock, so two concurrent completes cannot both pass at 19).
  3. `insertAttachment({ recordId, uploadedByUserId: actor.userId, objectKey: finalKey, fileType, sizeBytes, attachmentDescription: intent.description })`.
  4. `audit.record` `attachment.added` (entity type `record_attachment`, entity id = the new row) with `{ recordId, fileType, sizeBytes, afterLock: lock.isLocked }`.
  5. Return the row; the shared flow then closes the intent with `result_id` = the row id, in the same transaction.

  Lock order: advisory lock (per intent) → intent row (`FOR UPDATE`) → record row (`FOR NO KEY UPDATE`). No other path takes an intent row after a record row (`PATCH`, `DELETE` and the purge take one of the two only), so there is no cycle; a follow-up booking's `FOR KEY SHARE` on the record does not conflict with `FOR NO KEY UPDATE`.

  | Step / failure | Outcome |
  |---|---|
  | lock refused (another request, pool nearly pinned, acquire timeout) | `409 Conflict` + `Retry-After: 1` |
  | `HEAD` / range read / `promote` / quarantine `delete` throws `StorageError` | `500 InternalError`; the intent stays open and retryable; no row; no audit row |
  | object missing, size outside 1..`max_bytes`, or leading bytes not PDF/JPEG/PNG | quarantine object deleted, intent closed without result, metric `upload_verification_failed{reason="invalid_file", kind="record_attachment"}`, `400 ValidationFailed` (`details[0] = { field: "file", issue: "stored file is invalid" }`), no row |
  | a re-POST to the quarantine key after the checks | the ETag-bound `promote` fails → `500`, intent open, no row |
  | the short transaction fails (`AttachmentLimitReached`, audit insert error, `Conflict`) | rolled back; the promoted object is deleted best-effort (`upload_orphan_cleanup_failed{kind}` logged on failure); intent stays open (SD3) |

**`downloadUrl(actor, recordId, attachmentId)`**:
1. `actor.role === "admin"` → `Forbidden` (defence in depth; admins never reach it).
2. One transaction: `attachment = findLive(attachmentId, recordId, trx)`; absent → `NotFound` (nothing was written); `audit.record` `attachment.url_issued` (entity type `record_attachment`, entity id = attachment id) with `{ recordId, viewerRole: actor.role, viewerIsAuthor: attachment.uploadedByUserId === actor.userId }`. The transaction **commits** before step 3.
3. `storage.presignDownload(attachment.objectKey, attachment.fileType, DOWNLOAD_URL_TTL_SECONDS)` (60 s, `attachment` disposition, the stored verified content type). Return `{ url, expiresAt }`.
- An audit failure → `500`, no URL. A presign failure after the commit → `500`; the row records authorization to issue and no URL was delivered. One audit row per issued URL, never one per record read.

**`remove(actor, recordId, attachmentId)`**, one transaction:
1. `lock = links.lockForNoKeyUpdate(recordId, trx)`; absent, or `lock.doctorUserId !== actor.userId` → `NotFound`.
2. `attachment = findLive(attachmentId, recordId, trx)`; absent, foreign or already deleted → `NotFound` (**before** the lock verdict, RA-D6).
3. `lock.isLocked` → `RecordLocked`.
4. `softDelete(attachment.id, trx)`; zero rows affected → `NotFound` (unreachable under the record lock).
5. `audit.record` `attachment.removed` with `{ recordId }`.
- Any `check_violation` whose constraint is `trg_record_attachments_forbid_delete_after_lock` (`checkViolationConstraint`) → `RecordLocked` (defence in depth: the service and the trigger read the same `NOW()`; it fires only if the lock verdict and the row were separated by something outside the service). Other `23514` violations are programming errors (`500`).
- The stored object is **not** touched (RA-D4); there is no storage call.

**`RecordAttachmentLinksService`** (`@injectable()`; deps `Db`; thin, no rules): `listByRecordIds(recordIds, conn = db): Promise<Map<number, RecordAttachmentSummary[]>>`.

### 4.7 No file bytes outside the bucket
No attachment response, log line, audit row or Redis value contains bytes of the file. The service reads at most 16 bytes of a quarantine object (inside the shared verify step) and only to detect the type.

### 4.8 `records` cross-module API added
`RecordLinksService.lockForNoKeyUpdate(recordId, trx: Knex.Transaction): Promise<RecordLockRow | undefined>` (`RecordLockRow { id; patientUserId; doctorUserId; isLocked }` in `records/types.ts`; calls `findLockRowForNoKeyUpdate`). `findAccessRow` is unchanged. The class stays database-only (no new constructor dependency).

### 4.9 Changes in `records` (RA-D7; exact plug-in points)
- `policies.ts`: `recordReaderRule` is **exported** (no other change; the record policies and their tests are untouched).
- `types.ts`: `RecordLockRow`; `RecordWithAmendments` gains `attachments: RecordAttachmentSummary[]` (type import from `record-attachments/types`; the type name is kept to limit churn); `RecordUpdateResult`'s `updated` / `unchanged` variants gain `attachments: RecordAttachmentSummary[]`.
- `dto/records.response.dto.ts`: `MedicalRecordResponseDto.attachments!: RecordAttachmentResponseDto[]` (was `never[]`); `from(entity, amendments, attachments, viewer)`; `PatientTimelineResponseDto.from` passes each item's attachments. The create `201` passes `[]`.
- `service/record-queries.service.ts`: constructor gains `@inject(TOKENS.RecordAttachmentLinksService)`. **`get`**: after `amendments`, `const attachments = (await this.attachmentLinks.listByRecordIds([record.id], trx)).get(record.id) ?? []`; then the unchanged audit row; return `{ record, amendments, attachments }`. Statements in the one transaction: record, amendments, **attachments**, audit (was 3, now 4). **`timeline`**: after the amendments query, `this.attachmentLinks.listByRecordIds(page ids, trx)` (skipped by the helper for an empty page); items carry `attachments`. Statements: page, amendments, **attachments**, profile, audit (was 4, now 5); empty page: page, profile, audit (3, unchanged; no attachments query).
- `service/records.service.ts`: constructor gains the same dependency. In `update`'s **not-locked** branch only: after `updateRecordFields` (or, for the no-op, right after the diff finds nothing) and **before** the audit insert, `attachments = (await listByRecordIds([record.id], trx)).get(record.id) ?? []`; returned in the `updated` / `unchanged` result. Statements: in place — lock read, update, **attachments**, audit (4, was 3); no-op — lock read, **attachments**, audit (3, was 2); amendment — unchanged (3). `create` is unchanged (a new record has no attachments).
- `controller/records.controller.ts`: `create` passes `[]`; `update` passes `result.attachments` for `updated`/`unchanged`; `get`/`timeline` pass the service results through.
- `record.read` and `patient_records.listed` audit metadata are **unchanged** (SD9); the attachment list is not a separate disclosure.

### 4.10 Policies (`policies.ts`, `buildRecordAttachmentsPolicies(doctors, links, relationship)`)
`doctors: Pick<DoctorsService, "isLocallySuspended">`, `links: Pick<RecordLinksService, "findAccessRow">`, `relationship: PatientRelationshipChecker` (`TOKENS.PatientRelationship`).

| Route | Policy |
|---|---|
| `createIntent` | roles `[doctor]`, owner `record_attachment_writer`, `checks: [doctorNotSuspendedCheck(doctors)]` (no `audit` class: no clinical row) |
| `complete` | roles `[doctor]`, owner `record_attachment_writer`, `checks: [doctorNotSuspendedCheck(doctors)]`, `audit: "clinical-write"` |
| `remove` | roles `[doctor]`, owner `record_attachment_writer`, `checks: [doctorNotSuspendedCheck(doctors)]`, `audit: "clinical-write"` |
| `downloadUrl` | roles `[patient, doctor]`, owner `recordReaderRule(doctors, links, relationship)` (resolver name `record_reader`), `audit: "clinical-read"` (no check: suspension is inside the resolver) |

`record_attachment_writer` (`x-ownership: record-author`): `id = parsePositiveId(params.id)`, `undefined` → `deny-not-found`; `row = links.findAccessRow(id)`; absent → `deny-not-found`; `row.doctorUserId === auth.userId` → `allow`, else `deny-not-found`. It sees only `auth` and the path params. `authorize` order: principal `401` → role `403` → account status `403` → policy checks (suspension `403`) → ownership `404`, so a related or stranger doctor never learns whether the id exists, and a suspended author is `403` before any lookup. **Admins** are absent from every role list: `403 Forbidden` at the role step on all four routes, before any lookup (an admin learns nothing about ids).

### 4.11 Controller, DI, mount
- `RecordAttachmentsController` (arrow methods: validate → service → render → `sendSuccess`/`sendNoContent`; `requireAuth`; path ids through `parsePositiveId`, `undefined` → `NotFound`; no business logic; never reads `description` except to pass the validated DTO on). `createIntent` → `201`; `complete` → `201`/`200` by `replay`; `downloadUrl` → `200`; `remove` → `204`.
- Tokens: `UploadIntentsService`, `RecordAttachmentLinksService`, `RecordAttachmentsService`, `RecordAttachmentsController`. `bootstrap.ts` order: `UploadIntentsService` (before `VerificationService`, section 2) … `RecordLinksService`, **`RecordAttachmentLinksService`**, `RecordAttachmentsService`, `RecordsService`, `RecordQueriesService`, `RecordsController`, `RecordAttachmentsController`, then the unchanged `ConsultationsService` … (the attachments services must precede the records services that inject them; neither depends on a records service, so there is no constructor cycle).

### 4.12 Rate limits (`constants.ts`, `rate-limits.ts`; `429` + `Retry-After`; Redis sliding window; all per user; the limiter runs after `authorize`, so a `403` or the resolver's `404` for `{id}` consumes no budget; **as built (14.1) the limiter runs before the controller, so the controller's `404` for a non-numeric `{uploadId}`/`{attachmentId}` and the `400` for a request body (or an invalid intent body) do consume budget**)
```ts
export const RECORD_ATTACHMENTS_INTENT_WINDOW_MS = 3_600_000;
export const RECORD_ATTACHMENTS_INTENT_USER_LIMIT = 20;   export const RECORD_ATTACHMENTS_INTENT_RATE_NAME = "record-attachments-intent-user";
export const RECORD_ATTACHMENTS_RATE_WINDOW_MS = 60_000;
export const RECORD_ATTACHMENTS_WRITE_USER_LIMIT = 20;    export const RECORD_ATTACHMENTS_WRITE_RATE_NAME = "record-attachments-write-user";  // complete + DELETE share one bucket
export const RECORD_ATTACHMENTS_READ_USER_LIMIT = 120;    export const RECORD_ATTACHMENTS_READ_RATE_NAME = "record-attachments-read-user";    // download-url
```
`rate-limits.ts` exports `intentLimit()`, `writeLimit()`, `readLimit()` (each `rateLimit({ name, limit, windowMs, subject: byUser })`). Admin calls never reach a limiter.

---

## 5. Business rules

| # | Rule | Enforced by |
|---|---|---|
| RA-R1 | Only the record's author creates intents, completes and removes attachments. Related doctor, stranger doctor, absent record and non-numeric id are indistinguishable (`404`); patients and admins `403` (role); pending/rejected doctors `403`; a locally suspended author `403 Forbidden` (Domain rules 14, 19; RA-D2) | role step, `doctor_not_suspended` check, resolver `record_attachment_writer`, service re-check |
| RA-R2 | `NotAssignedDoctor` is never returned on an attachment route | resolver + service (no code path throws it) |
| RA-R3 | A row exists only after `complete` read the stored object: `HEAD` size `1..max_bytes`, the first bytes are PDF / JPEG / PNG; `file_type` is the detected type and `size_bytes` the `HEAD` size; the filename and any declared `Content-Type` are never read; a failed check deletes the quarantine object, closes the intent and answers `400` (`file`) with no row (ADR 0013) | `UploadIntentsService.complete`; `chk_record_attachments_file_type`, `_size` as backstop |
| RA-R4 | An intent lasts 15 minutes, is single use, owner-bound and bound to its record and kind; foreign / other-record / other-kind → `404`; consumed without a result → `409 Conflict`; expired → `410` (object deleted, intent closed); a replayed `complete` returns the same row with `200` and writes no second audit row | `upload_intents` row + shared flow under the per-intent advisory lock |
| RA-R5 | `promote` is bound to the inspected object (ETag + detected content type); a re-POST after the checks fails the copy (`500`, intent open, no row) | `storage.promote` expectation |
| RA-R6 | Adding is allowed before and after the lock with no reason; the `attachment.added` row carries `afterLock` from database time; adding never updates `medical_records` | service (no lock check on add); `lockForNoKeyUpdate` verdict |
| RA-R7 | Removing is allowed only before the lock: the verdict is `locked_at <= NOW()` read under `FOR NO KEY UPDATE`; an absent / foreign / already deleted attachment is `404` **before** the locked `409 RecordLocked`; the trigger repeats the verdict and its `check_violation` maps to `RecordLocked` | service (record lock, order) + `trg_record_attachments_forbid_delete_after_lock` |
| RA-R8 | A record holds at most 20 live attachments: courtesy checks at intent creation and before the storage phase of `complete`; the guarantee is the count under the record row lock inside the `complete` transaction; two concurrent completes at 19 → exactly one `201` and one `409 AttachmentLimitReached`; a removed attachment frees a slot | service; record row lock |
| RA-R9 | Removal is a soft delete (`deleted_at`); the stored object is kept and no storage call is made; deleted rows vanish from every read and from `download-url` | repository filters; `softDelete` |
| RA-R10 | `download-url` = authorize → audit (own committed transaction) → presigned GET (60 s, `attachment` disposition, the stored verified type); a failed audit → `500` and no URL; one audit row per issued URL; `404`/`403`/`429` write none; admins `403` | policy + `downloadUrl` order |
| RA-R11 | Reads carry attachment metadata only (`id, recordId, fileType, sizeBytes, description, createdAt`), live rows, oldest first, loaded with one `= ANY` query per page, no extra audit row, never a URL, key or `uploadedByUserId` | `RecordAttachmentLinksService`, response DTO |
| RA-R12 | `description` is optional clinical free text: not blank, no NUL, ≤ 500 code points; carried from the intent to the row; shown with the record to the patient and consulted doctors; never in logs, audit metadata, Redis or error details | request DTO; `chk_record_attachments_description`; redaction key; privacy test |
| RA-R13 | Every write audits in its own transaction (`attachment.added`, `attachment.removed`); `attachment.url_issued` is committed before the URL; a failing audit fails the operation; metadata holds ids, types, sizes and flags only | `AuditRecorder` in the transaction |
| RA-R14 | Rate limits per user: intents 20/hour; `complete` + `DELETE` 20/min (one bucket); `download-url` 120/min → `429 RateLimited` | `rateLimit` |
| RA-R15 | No attachment route reads an `Idempotency-Key` or sits behind the idempotency middleware; no POST policy, URL or description is ever held in Redis | route composition; Redis scan test |
| RA-R16 | The app role can read, append six columns and set `deleted_at`; no `DELETE`, no `TRUNCATE`, no other `UPDATE`; no `ON DELETE CASCADE` | grants (3.1) |
| RA-R17 | Storage failures never create a row: a storage error in `complete` is `500` with the intent open and retryable; intent creation and `download-url` presigning are local computation; reading a record never touches storage | shared flow ordering |
| RA-R18 | A `complete` transaction that rolls back deletes the promoted final object best-effort; the bucket lifecycle is the backstop (no reconciliation scan, same stance as verification) | shared flow step 10 |
| RA-R19 | The purge closes expired open intents of every kind and deletes consumed rows older than 7 days | `listExpiredOpenIntents` without a kind predicate |
| RA-R20 | Lock order is advisory lock → intent row → record row; no other path takes them in another order; `PATCH`, `DELETE` and `complete` serialize on the record row | 4.6 |
| RA-R21 | A locally suspended doctor: `403` on intent, complete and delete; `404` on `download-url` (records R-D5), including for attachments they authored; the patient and other consulted doctors still open them | check (writes), resolver (reads) |
| RA-R22 | Every attachment response carries `Cache-Control: no-store` | `NO_STORE_PREFIXES` (`/api/records`) |
| RA-R23 | `status=active` is required for all four routes (pending / rejected doctors `403`) | `authorize` account-state step |
| RA-R24 | Extraction invariant: `verification` behaves exactly as before (same statements, same storage calls, same errors, same lock namespaces) | section 2 strategy |

---

## 6. Cross-service behavior
**None.** No call to Identity (no Case 1, 2, 3 or 4): attachment DTOs carry ids only, so there is nothing to hydrate and no degrade path; no attachment route is a must-not-degrade path. The only external dependency is object storage through the existing `lib/storage` port. **Failure policy (same as verification):** `createIntent` and `downloadUrl` presign locally and cannot fail on storage reachability; `complete` surfaces a `StorageError` as `500 InternalError` with the intent left open (2 s timeouts for `HEAD`/range read/`delete`, 10 s for the copy; retries bounded by the adapter), creating no row; storage is never touched by reading a record, so a storage outage cannot fail `GET /records/{id}` or the timeline. Platform changes: see section 12.

## 7. Error codes
| Code | HTTP | When |
|---|---|---|
| `ValidationFailed` | 400 | intent body (blank / > 500 / NUL / `null` / unknown member); a body on a route that takes none; `complete` found the stored object invalid (`details[].field = file`) |
| `Unauthorized` / `TokenExpired` | 401 | token problems |
| `Forbidden` | 403 | admin or patient on a write route; admin on `download-url`; non-`active` account; locally suspended doctor on intent / complete / delete |
| `NotFound` | 404 | absent or invisible record; not the author (writes) or no access (`download-url`); foreign / wrong-record / deleted attachment; foreign, other-record or other-kind intent; suspended doctor on `download-url`; any non-numeric id |
| `AttachmentLimitReached` | 409 | the record already holds 20 live attachments (intent creation or `complete`) — **new** (C5) |
| `Conflict` | 409 | intent consumed without a result; replay row no longer live; the short transaction found the intent no longer open; `Retry-After: 1` when another request holds the per-intent lock |
| `RecordLocked` | 409 | `DELETE` after the record's lock (service verdict or trigger) |
| `UploadIntentExpired` | 410 | `complete` after `expires_at` |
| `RateLimited` | 429 | intents 20/h, write 20/min or read 120/min exceeded |
| `InternalError` | 500 | unhandled; a storage error in `complete`; an audit insert that fails (including the `download-url` audit, which means no URL) |

`NotAssignedDoctor` is not used here. New code: `AttachmentLimitReached` only (no existing code fits a per-record cap).

## 8. Security & privacy
- **RBAC summary:** intent / complete / delete = the record's author (active, not suspended); `download-url` = the record's patient, the author, or a consulted doctor (not suspended); **admin denied on all four** (`403` at the role step); `404` for everyone else. Deny-by-default `authorize` on every route; the boot assertion covers the router.
- **Audit** (entity type `record_attachment`, entity id = the attachment id; metadata is flat scalars, ≤ 20 keys, no redacted key name — `AuditRecorder` enforces both):

  | Action | Written | Metadata |
  |---|---|---|
  | `attachment.added` | `complete` transaction (same as the insert and the intent close) | `recordId, fileType, sizeBytes, afterLock` |
  | `attachment.removed` | `DELETE` transaction | `recordId` |
  | `attachment.url_issued` | its own transaction, committed before presigning | `recordId, viewerRole, viewerIsAuthor` |

  Never in metadata: the description, object key, quarantine key, URL, file name. No row for a `404` / `403` / `400` / `409` / `410` / `429`, for a replayed `complete`, or for the record read that lists the metadata. The key names above were checked against `REDACTED_KEYS` (none is redacted).
- **Never logged** (defence in depth in `lib/logger/redact.ts`): the existing `objectKey`, `quarantineKey`, `url`, `fields`, `downloadUrl`, `uploadUrl`, `body`, `requestBody` plus the **new** `attachmentDescription` (test row in `tests/unit/lib/logger/redact.test.ts`, whose expected-key list is updated). A bare `description` is **not** added (SD2 and section 1.5). Log lines on these routes carry ids, statuses and the route pattern; validation `details` carry field names and constraint text, never values; storage failures log the operation name only (`StorageError(operation)`), never a key.
- **Files** (CLAUDE.md → Security rules): the upload is intent → presigned POST to `quarantine/<uuid>` (5 min, exact key, 1 B-10 MB, SSE) → `complete`; the intent is 15 min, single use, owner- and record-bound, re-authorized at `complete` (the route re-runs `authorize`; the service re-checks record and author); the row is created only after the stored bytes pass; download URLs are issued on demand after `authorize` and a committed audit row, valid 60 s, `attachment` disposition, verified content type; read DTOs never embed a URL; random object keys, never the client filename; private bucket.
- **No clinical text or file bytes in Redis:** only rate-limit counters; no idempotency middleware (RA-R15).
- **No-store** on every response, including `400`/`404`/`429` and a malformed-JSON body.
- **Rate limits:** 4.12. Admin denied calls consume nothing.
- **Accepted by design:** any doctor holding a `booked`/`waiting`/`in_progress`/`completed` consultation with a patient can open **all** attachments of that patient's records (CLAUDE.md → Authorization — RBAC and ownership; records section 7), each issuance audited.

## 9. Performance
No CLAUDE.md budget covers attachments; targets (p95): intent creation < 100 ms, `download-url` < 100 ms (file-handling §7), `DELETE` < 150 ms, `complete` < 500 ms (dominated by the in-region copy of ≤ 10 MB), `GET /records/{id}` < 150 ms and a timeline page of 20 records < 200 ms (the records budgets are unchanged by the extra statement).

### 9.1 Statements per route (database statements; storage calls listed separately)
| Route | Statements |
|---|---|
| intent | resolver 1 (+ suspension check 1) · service: access row 1, count 1, intent insert 1 · storage: 0 network calls (local signing) |
| complete (happy) | resolver 1 (+ check 1) · advisory lock/unlock 2 · intent 1 · access row 1 · count 1 · transaction: intent `FOR UPDATE` 1, record `FOR NO KEY UPDATE` 1, count 1, attachment insert 1, audit 1, intent close 1 · storage: `HEAD`, 16-byte range read, copy, delete |
| download-url | resolver 1 (+ suspension 1 + relationship ≤ 1 for a doctor) · transaction: attachment 1, audit 1 · presign (local) |
| delete | resolver 1 (+ check 1) · transaction: record lock 1, attachment 1, update 1, audit 1 |
| `GET /records/{id}` | 4 in the transaction (record, amendments, **attachments**, audit) |
| timeline | 5 (page, amendments, **attachments**, profile, audit); 3 on an empty page |
| `PATCH` in place / no-op / amendment | 4 / 3 / 3 |

### 9.2 Index coverage
Every query is a primary-key access or uses `idx_record_attachments_medical_record_id` (3.3). The purge's query loses its `kind` predicate and keeps `idx_upload_intents_expires_at_open`. `tests/integration/records-explain.test.ts` is extended (section 10) with an attachments seed and plans for the batch, the count and the by-id reads on tables large enough that the planner has a real choice (ANALYZEd synthetic rows).

### 9.3 No N+1
One attachments query per page (record view, timeline, `PATCH` 200); one count per cap check; no per-record query anywhere. The list query selects the six summary columns, never `object_key`.

### 9.4 Capacity check (hub `capacity.md` and `docs/architecture/capacity.md`, read 2026-10-18)
The stated assumptions are **averages**: 1 attachment per 2 records at 1.5 MB (≈ 3.4 k attachments/day, ≈ 5.6 GB/day, ≈ 2 TB/year of object storage; rows < 1 GB; uploads 5 k/day ≈ 0.4 rps of `complete`, verification documents included; download-url issuance is inside the ≈ 100 k audit rows/day). The cap of **20 × 10 MB = 200 MB per record** is a per-record abuse ceiling, not an assumption, so it **holds**: no stated number changes, and the 10× verdict ("holds, cost not architecture") is unaffected. The only worst-case bound is behavioural: one doctor can create at most 20 intents/hour (20 × 10 MB = 200 MB/hour/doctor at the policy ceiling) and each record at most 200 MB; soft-deleted objects are kept (capacity.md §6). If measured average attachment size or count per record exceeds the assumption for a week, the existing storage revisit trigger applies. **No platform change is required by this unit** beyond the wording note in section 12.

## 10. Test plan outline
Unit via `npm test`; integration via `npm run test:integration` (isolated PostgreSQL 18 on :5499 with `btree_gist`, real Redis db 14); route tests inject `tests/helpers/fake-storage.ts` (`InMemoryObjectStorage`: `seed`, `has`, `setHeadSize`, `replaceAfterNextHead`, `failNextCopy`, `clear`, `calls`); the MinIO adapter suite is unchanged. Names: `should <do something> when <condition>`; synthetic markers `SYNTHETIC-ATTACH-DESC-0001` style. New helpers: `tests/helpers/record-attachments-fixtures.ts` (intent via the route, quarantine seeding, `PDF` bytes constant, `complete`, `attachmentRows`, `intentRows`, audits).

### 10.1 Unit (`tests/unit/app/...`, mocked collaborators, fake clock where used)
- `upload-intents/upload-intents.service.test.ts` — **the transplanted verification cases at the new boundary, each run for both kinds** (`V8 intentOwnerReplayAndExpiry`, `V9 completeRejectsFalsePdfAndWritesNoRow` shapes): create inserts the right row and returns the policy; foreign / wrong-kind intent `NotFound` before any storage call; replay `replay: true` with no `insertResult` call; replay whose row is gone `Conflict`; consumed without result `Conflict`; expired deletes the quarantine object, closes with `null`, `UploadIntentExpired`; missing object, size 0, size > `max_bytes` and false bytes behind a `.pdf` name each delete, close, emit `upload_verification_failed{reason, kind}` and throw `ValidationFailed` field `file` without calling `insertResult`; `readHead` is called with 16 only when the size is in range; `promote` receives the inspected ETag and the detected type; `insertResult` failure deletes the final key best-effort and logs `upload_orphan_cleanup_failed{kind}` when that delete fails; refused lock → `Conflict` with `retryAfter: 1`; storage error leaves the intent open; constants pinned (`1101`, `1103`, loop name).
- `upload-intents/upload-intents-worker.test.ts` — the moved purge-loop test (assertions unchanged) plus: the loop lists and purges a `record_attachment` intent; failure marks the tick `incomplete`.
- `verification/*` — the existing suites with the mechanical edits of section 2 only.
- `record-attachments/record-attachments.service.test.ts` — `createIntent`: record absent / not author `NotFound` before any count; count 20 `AttachmentLimitReached` and 19 allowed; row carries the description. `complete` callbacks: other record id `NotFound`; non-author `NotFound`; precheck at 20 `AttachmentLimitReached` before any storage call; `insertResult` order (lock → count → insert → audit) and metadata `{ recordId, fileType, sizeBytes, afterLock }` with `afterLock` true/false from `isLocked`; description copied from the intent; count 20 inside the transaction → `AttachmentLimitReached` and no insert / audit; audit failure propagates (nothing committed). `downloadUrl`: audit committed before `presignDownload`; audit failure → no presign (`V11 downloadFailsClosedOnAuditError` shape); absent / foreign / deleted → `NotFound` with no audit and no presign; admin → `Forbidden`; metadata `{ recordId, viewerRole, viewerIsAuthor }`; TTL = `DOWNLOAD_URL_TTL_SECONDS`. `remove`: absent attachment `NotFound` **before** the locked verdict (both orders asserted); locked → `RecordLocked` with no update; unlocked → soft delete + audit; `checkViolationConstraint === trg_…` → `RecordLocked`, another `23514` rethrown; no storage call.
- `record-attachments/record-attachments.policies.test.ts` — roles per route (admin, patient, wrong role `403`), `record_attachment_writer` decision table (non-numeric, absent, author, related doctor, stranger → `deny-not-found`), the suspension check, `downloadUrl` uses the `record_reader` rule, `NotAssignedDoctor` appears nowhere.
- `record-attachments/record-attachment-links.service.test.ts` — empty input → no query; grouping and order by id; the selected columns exclude `object_key` and `uploaded_by_user_id`.
- `record-attachments/record-attachments.dto.test.ts` — intent body: absent / `{}` / `description` 1, 500, 501 code points, blank, whitespace-only, NUL, newline allowed, `null`, non-string, unknown member; response DTO viewer matrix (admin throws; patient / doctor shape; `description: null`; no `objectKey` / `downloadUrl` / `uploadedByUserId` key anywhere).
- `records/*` (edited): `records.response.dto.test.ts` (attachments rendered, oldest first, key set), `records.controller.test.ts`, `records.service.test.ts` (in-place and no-op results carry attachments; the amendment and create paths do not read them), `record-queries.service.test.ts` (one attachments call per page; none for an empty page; failure propagates), `record-links.service.test.ts` (`lockForNoKeyUpdate` delegates, takes the transaction), `records.policies.test.ts` (unchanged assertions; `recordReaderRule` export).
- `lib/logger/redact.test.ts` (row for `attachmentDescription`, expected-key list updated; the bare `description` is still logged); `lib/error` (`AttachmentLimitReached` in `ERROR_CODES` and in the contract enum).
- Contract: `tests/unit/contract/record-attachments-contract.test.ts` (new) — paths, methods, `operationId`s, roles, `x-ownership`, status codes (including `409` on intent and complete, `410` on complete, `409 RecordLocked` and no `422` / idempotency parameter on any of the four), `RecordAttachment` without `downloadUrl`, the `AttachmentLimitReached` enum value, `RecordAttachmentIntentCreate`, no `RecordAttachmentUpload`; `records-contract.test.ts` (the "always `[]`" expectation becomes the C3 wording).

### 10.2 Integration (`tests/integration/`; real wiring, real Postgres and Redis; storage = `InMemoryObjectStorage`; Identity fake only where the booking fixtures need it)
- `record-attachments.test.ts` — happy path intent → seed quarantine object → `complete` `201` → `GET /records/{id}` lists it (metadata only) → `download-url` `200` → `DELETE` `204` → no longer listed; intent response shape (`uploadId, url, fields, expiresAt, maxBytes`); `fileType` is the detected type; `size_bytes` the `HEAD` size; description round trip; contract conformance of every status and error code of the four operations.
- `record-attachments-rbac.test.ts` — **admin denied on every route** (`403`, id existing or not, with no audit row); matrix of actors (patient owner, other patient, author doctor, related doctor, stranger doctor, suspended author, pending doctor, rejected doctor, admin, cancelled-only relationship) × the four routes, asserting the table in 4.1 (writes: author allowed, related and stranger `404`, suspended `403`, patient `403`; `download-url`: owner patient, author, related doctor `200`; other patient, stranger, cancelled-only `404`; suspended author `404`; pending doctor `403`); non-numeric `{id}`, `{uploadId}`, `{attachmentId}` `404`; no route ever returns `NotAssignedDoctor`; the patient and a related doctor still open a suspended author's attachment.
- `record-attachments-rules.test.ts` — **upload scenarios (CLAUDE.md → Testing policy):** false bytes behind a `.pdf` name and `application/pdf` type rejected at `complete` with `400` (`file`), no row, quarantine object deleted, intent closed, no audit row; oversize (`setHeadSize`) and missing object likewise; expired intent `410`, object gone, intent closed; another doctor's intent, another record's intent, a `verification_document` intent and a closed intent cannot be completed; replayed `complete` `200`, same row id, one row and one `attachment.added` row; `failNextCopy` → `500`, no row, intent open and a retry succeeds; `replaceAfterNextHead` (a re-POST after the checks) → `500`, no row, intent open; audit failure on `complete` rolls back (no row, final object deleted, intent open); **cap:** the 20th attachment succeeds, the 21st `complete` and the 21st intent `409 AttachmentLimitReached`, a delete frees a slot; **two concurrent completes at 19 → exactly one `201` and one `409`**, one row; **lock boundary:** add with `locked_at` 2 s ahead (`afterLock:false`) and with the record aged past 24 h (`afterLock:true`, `medical_records` row byte-for-byte unchanged); delete before the lock `204`, after it `409 RecordLocked` (aged record) and the trigger agrees (a direct `UPDATE … SET deleted_at` as `care_app` after the lock raises `check_violation`); the **same-instant** race of a delete against the lock moment; delete order (`404` for an absent / deleted / foreign-record attachment even on a locked record); a record that gets an attachment concurrently with a `PATCH` completes without deadlock (no `40P01`); a follow-up booking racing a `complete` completes without deadlock; a mid-flight lock-refused `complete` → `409` + `Retry-After: 1`.
- `record-attachments-audit.test.ts` (or inside rules) — `attachment.added` / `removed` / `url_issued` rows with the documented entity type / id and clinical-free metadata; **every `download-url` writes exactly one audit row** (also repeated calls: one row each); a failing audit insert → `500`, no URL, no presign call, no row; `404` / `403` / `429` write none; `GET /audit-logs` as admin shows the rows without clinical content.
- `record-attachments-privacy.test.ts` (as `records-privacy.test.ts`) — with marker strings in `description`: captured logs, every `audit_logs.metadata`, all Redis keys and values, and the error responses of rejected requests (`400`, `404`, `409`, `410`) contain none of the markers, nor any object key, `quarantine/…`, `record-attachments/…`, presigned URL or POST field; no `Idempotency-Key` effect (a request carrying one behaves as without; no `idem:*` key); `Cache-Control: no-store` on every response including `400`/`404`/`429`; the record read, timeline and `PATCH` bodies contain `description` but no key / URL field; `GET /records/{id}` makes **zero** storage calls.
- `record-attachments-links.test.ts` (or in `records.test.ts`) — `attachments` on `GET /records/{id}`, the timeline (several records, oldest first per record, deleted rows hidden, other patients' attachments absent) and the `PATCH` in-place / no-op `200`; `[]` on create and amendment-free records; **statement counts with `captureQueries`**: timeline = 1 attachments statement per page and 0 on an empty page, get-one = 1, PATCH in place and no-op = 1; the existing counts for `medical_record_amendments`, `medical_records`, `patient_profiles`, `audit_logs` stay 1 each; page 2 of the timeline on the default sort (cursor round trip) still returns each record's own attachments. Not applicable to this module: Case 1-4, Identity hydration, booking concurrency, the slot budget and pagination of a new list (no list endpoint is added; the timeline's own pagination tests are re-run with attachments present).
- `upload-intents.test.ts` — the purge loop with the real service closes expired intents of **both** kinds and deletes their quarantine objects, leaves unexpired and consumed ones, `removed` counts consumed rows older than 7 days; `describe.each([2, 4])` pool test for `record_attachment` completes (no pool exhaustion, no leaked advisory lock — the `verification.test.ts` pattern).
- `records-explain.test.ts` (extended) — seed `record_attachments` (e.g. one live row per even record plus soft-deleted rows, ANALYZE); plans: the batch uses `idx_record_attachments_medical_record_id` with no `Seq Scan`; the cap count uses it; `findLive` and the lock read use the primary keys; the purge listing still uses `idx_upload_intents_expires_at_open`; the statement-order test becomes page, amendments, **attachments**, profile, audit; the timeline (200 ms) and get-one (150 ms) budgets are re-asserted with attachments present.
- `migrations.test.ts`, `db-roles.test.ts`, `no-store.test.ts` — section 3.4; a malformed-JSON `POST /api/records/1/attachments/uploads` → `400` + `Cache-Control: no-store`.
- Existing integration tests changed because behaviour or signatures change (no assertion weakened): `verification.test.ts`, `admin-doctors.test.ts` (section 2), `records-rules.test.ts` and `records-explain.test.ts` (statement counts / order, section 4.9); `records.test.ts`, `records-contract.test.ts` keep their `attachments: []` assertions (still true for records without attachments).

### 10.3 Manual QA
`scripts/curl-test-record-attachments.sh` against dev MinIO and a local Identity (or its fake): CURL with doctor / patient / admin tokens and `X-Request-Id`; the browser-style presigned `POST` done with `curl -F`; intent → upload → complete → list → download (follow the 60 s URL) → delete; cap, lock (age the record as owner), `410`, false bytes, RBAC matrix, 429; never record tokens, URLs or fixture text in `manual-qa.md`. The **verification** script is re-run first (extraction gate, section 2).

## 11. Out of scope
Phase-2 AI (drafts, extraction from files); antivirus or deep PDF scanning (`attachment.quarantined` is the designed later hook, file-handling §4); thumbnails or previews; record deletion or erasure and erasure of a stored file (owner-run procedure, RA-D4); patient-uploaded files; attachments on anything other than a medical record or on an amendment; editing an attachment's description; file types beyond PDF / JPEG / PNG, files over 10 MB, multipart-chunk or bulk upload; a reconciliation scan for orphan final objects; the metrics `upload_intent_created` and `download_url_issued` (still not emitted, as for verification); a restore of a soft-deleted attachment; per-IP rate limits; anything in `records` beyond wiring attachments into its read DTOs and the `PATCH` `200`; behaviour changes in `verification` (only its internals move, plus SD10).

## 12. Open questions

**No undecided design question remains.** RA-D1..RA-D10 and the brainstorm's open questions are resolved (section 1.5); SD1..SD11 follow from CLAUDE.md, the contract and the sources. Everything below is decided work that must happen, not an unanswered question (precedent: records and sessions section 11). `status: ready` reflects that; if the owner reads "Open questions is empty" to exclude these lists, flip it to `draft`.

**Contract changes required (`contracts/openapi.yaml`, `/develop` step 0, before any code; then the hub copy is re-synced by `../vcare-hub/scripts/sync-from-spoke.sh`, never hand-edited):**
- **C1** Remove path `/api/records/{id}/attachments` (`addRecordAttachment`) and schema `RecordAttachmentUpload`. Add (tags `[records]`, `security: bearerUser`, parameters `RequestId` + `IdPath` + the inline `uploadId` / `attachmentId` integer path parameters as in the existing verification operations, **no** `Idempotency-Key` parameter, each description ending "`Idempotency-Key` is not honoured."):
  - `POST /api/records/{id}/attachments/uploads` `createRecordAttachmentUploadIntent` — summary "Create a presigned attachment upload intent (authoring doctor)"; optional request body (`required: false`) `RecordAttachmentIntentCreate`; responses `201` `UploadIntentCreated`, `400` `ValidationFailed`, `401`, `403` `Forbidden`, `404` `NotFound`, `409` `AttachmentLimitReached`, `429`, `500`.
  - `POST /api/records/{id}/attachments/uploads/{uploadId}/complete` `completeRecordAttachmentUpload` — summary "Verify the uploaded object and add the attachment (authoring doctor)"; no request body; responses `201` and `200` (replay) `RecordAttachmentOk`, `400`, `401`, `403` `Forbidden`, `404`, `409` `RecordAttachmentCompleteConflict`, `410` `UploadIntentExpired`, `429`, `500`.
  - `POST /api/records/{id}/attachments/{attachmentId}/download-url` `getRecordAttachmentDownloadUrl` — summary "Issue a 60-second private attachment download URL"; no request body; responses `200` `DownloadUrlOk`, `400`, `401`, `403` `Forbidden`, `404`, `429`, `500`.
  - New schema `RecordAttachmentIntentCreate` (`type: object`, `additionalProperties: false`, optional `description`: `type: string`, `minLength: 1`, `maxLength: 500`, "clinical free text: not blank, no NUL; shown with the record; never logged"). New responses `RecordAttachmentOk` (`data: RecordAttachment`, headers `X-Request-Id` + `Cache-Control: no-store`; description "Attachment metadata only"), `AttachmentLimitReached` (C5), `RecordAttachmentCompleteConflict` (`409`: `AttachmentLimitReached`, or `Conflict` — intent consumed without a result, replay row no longer live, or `Retry-After: 1` while another request holds the intent lock; headers incl. `Retry-After`).
- **C2** `components.schemas.RecordAttachment`: remove `downloadUrl` and `downloadUrlExpiresAt` from `properties` and from `required` (`required: [id, recordId, fileType, sizeBytes, description, createdAt]`); add the schema description "Metadata only. Open a file with `getRecordAttachmentDownloadUrl`; no response carries a URL or an object key."
- **C3** `MedicalRecord.attachments` description: "Live attachments of the record, metadata only (no URL, no object key), oldest first (`id` order), `[]` when none; loaded with one batched query per page." `getMedicalRecord`, `listPatientRecords` and `updateMedicalRecord` descriptions add one sentence that `attachments` lists the live attachment metadata (for the timeline, loaded for the whole page with one query; for `PATCH`, on the `200` only), and `createMedicalRecord` that `attachments` is `[]` on the `201`; `MedicalRecordOk` description becomes "The medical record with its amendments and attachment metadata."
- **C4** `deleteRecordAttachment`: `x-ownership: record-author`; description "Soft delete (the stored object is kept). Check order: wrong role, inactive or locally suspended doctor → `403 Forbidden`; record missing or the caller is not its author → `404`; then in the write transaction: attachment absent, belonging to another record or already deleted → `404`; then the record is locked (`locked_at <= now`, database time) → `409 RecordLocked`. Rate limit 20 attachment writes/min per user (shared with `completeRecordAttachmentUpload`). `Idempotency-Key` is not honoured."; responses: add `'400'` `ValidationFailed` (a body is not accepted), `'403'` becomes `Forbidden` (was `RecordWriteForbidden`), keep `'204'`, `'401'`, `'404'`, `'409'` `RecordLocked`, `'429'`, `'500'`; `x-audit-actions: [attachment.removed]` unchanged.
- **C5** `components.schemas.ErrorCode`: add `AttachmentLimitReached` (after `RecordLocked`); new response `AttachmentLimitReached` (description "`AttachmentLimitReached` — the record already holds 20 live attachments"; `Cache-Control: no-store`, `X-Request-Id`; `ErrorEnvelope` example with `code: AttachmentLimitReached`, message "A record can hold at most 20 attachments"). **CLAUDE.md owner edit (delegated; made in the same commit as C5 at `/develop` step 0, not in this spec phase):** add the row `| AttachmentLimitReached | 409 | a record already holds 20 live attachments (intent creation or complete) |` to "Error codes owned by Care", and, under "Domain rules" → Clinical and **without renumbering the numbered rules**, the sentence "A record holds at most 20 live attachments (`AttachmentLimitReached`); adding is allowed before and after the 24 h lock, removing only before it." (The bounded-context list in "Mission of this service" is already stale for several built modules; adding `record-attachments` and `upload-intents` there is optional housekeeping.) In code `src/lib/error/types.ts` gains the value in both `ErrorCode` and `ERROR_CODES` (the existing parity test against the contract enum guards it).
- **C6** On the three new operations: `x-roles` (`[doctor]`, `[doctor]`, `[patient, doctor]`), `x-ownership` (`record-author`, `record-author`, `consulted-patient-or-self`), `x-account-state` (`'status active; not locally suspended'` ×2; `'status active; a locally suspended doctor receives 404'`), `x-audit` (none; `clinical-write`; `clinical-read`) and `x-audit-actions` (`[]`; `[attachment.added]`; `[attachment.url_issued]`); descriptions state the check order of 4.1, "Admins are not in `x-roles`: `403 Forbidden` at the role step", and the rate-limit lines "20 attachment uploads/hour per user", "20 attachment writes/min per user (shared with delete)", "120 attachment reads/min per user"; every new response carries `Cache-Control: no-store`; `UploadIntentCreated` description says "per user" instead of "per doctor".

**Platform changes required (/system-design):** none for the design. One wording note for the hub's existing open item "care-service file handling … IaC for the bucket" in `../vcare-hub/TODO.md`: the bucket and IAM work should also name the `record-attachments/*` prefix (care-api `GetObject`/`CopyObject` target on it, the 90-day infrequent-access lifecycle already in file-handling.md §5); no new platform component, owner or cross-service call. Capacity: verified, holds (9.4). The hub contract copy is re-synced after C1-C6 land.

**Docs to refresh at `/update-docs`:** `docs/service-card.md` (**affected**: four new endpoints under `/api/records/{id}/attachments…`, `record_attachments` built, the object-storage dependency row now built for record attachments, the `upload-intents` module); `architecture/file-handling.md` (§2 table rewritten to the as-built rows, the `NotAssignedDoctor` row removed, §4a metrics / orphan log event / purge-all-kinds note), `clinical-records.md` (attachments section built), `data-model.md` (`record_attachments` actual DDL, trigger, grants; `upload_intents` comment), `api.md`, `rbac.md`, `overview.md` (modules), `infrastructure.md` (redaction key), `capacity.md` (one line), `runbook.md` (`RecordLocked` on attachment delete, `AttachmentLimitReached`, the renamed orphan log event, the purge now covering both kinds), `records/spec.md` (RC-R23 superseded: attachments are real), `verification/spec.md` §16 (pointer to the extraction and SD10), a new `docs/adr/0022-upload-intents-module.md` (written in step E0), `docs/INDEX.md`, `docs/record-attachments/tasks.md`; `CLAUDE.md` per C5 (owner).

## 13. Task ordering (CLAUDE.md → Build order for a new module; extraction first)
E0 `[docs]` Write ADR 0022. Record the baseline counts (unit, integration, `scripts/curl-test-verification.sh`). Add and commit the **golden statement test** on the unchanged code (section 2 step 2).
E1 `[module]` Extract `upload-intents` and rewire `verification`: constants, enums, errors, types, repository (moved), `UploadIntentsService`, the purge loop (moved), `TOKENS.UploadIntentsService`, `bootstrap.ts`, `worker-loops.ts`, `verification` service / policies / routes / types cleanup, the mechanical test edits of section 2, the new unit and integration tests for the shared module (kind `verification_document` only at this point). Gate: unit and integration green with counts ≥ baseline, the golden test unchanged, the verification manual-QA script green. **Commit boundary: nothing below starts before this is merged-quality.**
0 `[docs]` Contract edits C1-C6 (+ the CLAUDE.md owner edit of C5).
1 `[lib]` Generic additions with unit tests: `attachmentDescription` redaction key + test row; `AttachmentLimitReached` in `lib/error/types.ts`; the no-store row.
2 `[schema]` Migrations 3.1 and 3.2 + migration and `db-roles` tests.
3 `[module]` `record-attachments` `enums.ts`, `errors.ts`, `types.ts`, `constants.ts`; `records` `RecordLockRow` and the `RecordWithAmendments` / `RecordUpdateResult` type additions.
4 `[module]` Entity; request DTO; response DTO (viewer-aware).
5 `[module]` Repository functions (`record-attachments.repo.ts`, `findLockRowForNoKeyUpdate`).
6 `[module]` `RecordLinksService.lockForNoKeyUpdate`, `RecordAttachmentLinksService`, `RecordAttachmentsService`; DI tokens and `bootstrap.ts` (links services before the records services); the `records` plug-ins of 4.9 (queries, update, DTO, controller) and their test updates.
7 `[module]` `policies.ts` (+ export `recordReaderRule`), controller, `rate-limits.ts`, `routes.ts`, mount after the records router.
8 `[test]` Tests (section 10: unit, integration, RBAC, contract, concurrency, lock boundary, privacy, EXPLAIN, migrations).
9 `[qa/docs]` Manual QA (`scripts/curl-test-record-attachments.sh`, re-run the verification script), docs (section 12 list), as-built notes (section 14).

## 14. As-built notes
_Written 2026-10-20 by `/update-docs` against the code on `feature/record-attachments` (HEAD `72c4495`, review clean), `contracts/openapi.yaml`, the two migrations and the test suites. Where this section differs from sections 1-13, it wins._

No route, status code, error code, role, ownership resolver, rate-limit number, audit action or migration differs from sections 3-8 except the items below. The contract was final after the review fixes and needed no edit in this pass.

### 14.1 Deviations from the design text
1. **SD8 is superseded for `complete` (review finding K3, resolved).** `RecordAttachmentsService.insertResult` calls `DoctorsService.isLocallySuspended(actor.userId, trx)` right after `lockForNoKeyUpdate` and throws `403 Forbidden` when the author is locally suspended. The throw rolls the short transaction back (no attachment row, no `attachment.added` audit row); the shared flow then deletes the promoted final object best-effort and the intent **stays open**. Reason: the policy's suspension check runs before the whole storage round trip (`HEAD`, 16-byte read, `promote`, `delete`: seconds), so a suspension committed meanwhile (Case 3 step 1) would otherwise let the write through. What remains is the SD8 statement-level race (a suspension committing between this read and the insert, one transaction). `remove` is unchanged: its window between `authorize` and the write is one transaction, as SD8 states. `isLocallySuspended` gained an optional `conn` (default: the pool) so the read runs on the open transaction: a pool read there would need a third connection next to the session advisory lock and the transaction and could starve a small pool. `DoctorsService` is therefore a constructor dependency of `RecordAttachmentsService` (`TOKENS.DoctorsService`, registered before it in `bootstrap.ts`). The contract says this in one sentence on `completeRecordAttachmentUpload`.
2. **Dependency list (4.6).** `RecordAttachmentsService` injects `Db`, `AuditRecorder`, `RecordLinksService`, `UploadIntentsService`, `DoctorsService`, `STORAGE` and `Env`. `STORAGE` is used only for `presignDownload` (local signing) in `downloadUrl`; section 4.6 first listed neither it nor `DoctorsService`.
3. **`findLive(id, recordId)` plans on `idx_record_attachments_medical_record_id`, not the primary key** (section 3.3 said the PK). Both predicates are equalities, so the planner uses the partial index (`medical_record_id`, `id`): still a one-row index access, no Seq Scan (`tests/integration/records-explain.test.ts` accepts either index and forbids a sequential scan). `findLiveById` (replay) uses the PK.
4. **Rate-limit budget on malformed requests (4.1, 4.12).** The limiter sits between `authorize` and the controller. A `403` (role, account state, suspension) and the resolver's `404` for `{id}` consume no budget; the controller's `404` for a non-numeric, zero or negative `{uploadId}` / `{attachmentId}` and its `400` for a request body on `complete`, `download-url` and `DELETE` (and for an invalid intent body) are answered **after** the limiter and do consume budget. The contract states the same for the three path-id operations (`400` = a request body is not accepted; a bad `{uploadId}`/`{attachmentId}` is `404`, not `400`, answered after the rate limit).
5. **`Retry-After` on `complete` (contract wording, no behaviour change).** `Retry-After: 1` is sent only with the lock-held `Conflict` (another request holds the per-intent lock); it is absent on `AttachmentLimitReached` and on every other `Conflict` cause (intent consumed without a result, replay row no longer live, intent closed or expired between the lock read and the short transaction). The shared `RetryAfter` header description in the contract now covers an upload-intent `complete`. The `Conflict` example message is `The resource already exists`.
6. **Test helper.** `tests/helpers/fake-storage.ts` (`InMemoryObjectStorage`) gained a `beforeNextPromote` hook (used to suspend the doctor mid-`complete`); the helper list in section 10 otherwise holds. No `lib/storage` change.
7. **Evidence for RA-R24 (extraction invariant).** Commit `389de6f` did **not** commit the golden statement test before the move, as its message and section 2 step 2 claimed: the golden JSON, the test and the extraction landed together. The invariant was re-proved on 2026-10-19: the `goldenIntentStatements` test body was run against the pre-extraction code (`git archive 389de6f^`, `96278e8`, a docs-only commit on `main`'s code) in an isolated directory and database; the recorded statements and storage calls (create 3 statements / 1 storage call, complete 14/4, replay 8/0, expired 10/1, false bytes 10/3, purge 10/1) are identical to the committed `tests/integration/golden/verification-intent-statements.json`. With the purge normalization removed, the only difference is the `"kind" = ? and ` predicate of the purge listing (the intended ADR 0022 difference 3). Detail: [tasks.md](./tasks.md) "K8 evidence".

### 14.2 Documented trade-offs (owner decisions of the review; each is the behaviour as built)
These are not defects to fix inside this module: removing them would change `verification`'s behaviour or the golden statement test that proves the extraction (section 2 forbids both), or would change a convention shared with `records`.
- **K1 — a failed short transaction loses the quarantine copy (inherited from `main`).** `UploadIntentsService.complete` deletes the quarantine object right after `promote`, before the short transaction (`upload-intents.service.ts`, same order as `main`'s `VerificationService.complete`). If the transaction then fails for a reason other than the cap race (a deadlock, a connection reset, an audit insert error), the promoted object is deleted best-effort, the intent stays open, but its only remaining copy of the bytes is already gone: a retry of the same `uploadId` answers `400 ValidationFailed` (`details[].field = file`), closes the intent, and the doctor must upload again. This is the SD3 consequence for every non-cap short-transaction failure (the same "intent stays open, quarantine object gone, retry answers `400`" outcome the section 4.6 failure table documents). A fix means a deliberate follow-up for both modules: move the quarantine delete after the commit (best-effort, log `upload_orphan_cleanup_failed`) and add the test "short transaction throws, retry of the same `uploadId` returns `201`".
- **K2 — the delete-after-lock verdict uses the transaction-start `NOW()`.** The verdict (`findLockRowForNoKeyUpdate`: `locked_at <= NOW()`) and the trigger `trg_record_attachments_forbid_delete_after_lock` both read the transaction's `NOW()`, which is fixed at transaction start. A `DELETE` that blocks on a concurrent `PATCH` or `complete` of the same author (they all take the record row lock) across `locked_at` is therefore accepted although the lock instant has passed by the time it proceeds, up to the lock wait (bounded by the 2 s statement timeout). Section 3.1 fixes this on purpose: "same clock as the service (the transaction's `NOW()`)", the convention of the `records` trigger. Using `clock_timestamp()` in the verdict and the trigger would need a new migration and would change that shared convention.
- **K5 — the purge loop holds its singleton connection during serial storage deletes.** The loop (moved unchanged by the extraction) holds the singleton lock connection (namespace 1103) while it runs `storage.delete` (2 s timeout) serially for up to 500 expired intents, and under a storage outage it retries the same oldest 500 rows every tick. Reaching starvation needs more than 500 expired open intents plus a storage outage. The golden `purge` entry pins the statement sequence (singleton lock 1103, then per-intent lock 1101), so any restructuring (release between intents, a cursor) changes the golden JSON and the loop's observable behaviour.
- **K6 — the purge listing reads the clinical `description`.** `listExpiredOpenIntents` selects every `INTENT_COLUMNS` entry, including `description` (clinical free text for a `record_attachment` intent), although the purge uses only `id` and `quarantine_key`. The golden `purge` entry pins the full column list, so selecting two columns changes the golden JSON. The text is held in worker memory only for the tick and is never logged (`upload_intent_purge_failed` logs the error, not the row).

### 14.3 Verification record
- **Unit** (`npm test`): 167 suites, 3304 tests, all pass (baseline before the module: 157 suites / 2988). **Integration** (`npm run test:integration`, isolated PostgreSQL 18 with `btree_gist`, Redis db 14): 55 suites, 1746 tests: 1736 passed, 8 failed, 2 skipped. The 8 are environment or clock failures unrelated to this module and unchanged by it: 4 password-rejection cases of `db-roles.test.ts` (trust-auth server), 3 MinIO tests of `storage-adapter.test.ts` (plus its suite that cannot start without MinIO), and `consultations.test.ts` "should allow exactly 120 minutes before the start and refuse closer, for patients only" (a wall-clock dependent test; passes solo). The module's suites pass: `record-attachments{,-rbac,-rules,-audit,-privacy,-links}.test.ts`, `upload-intents.test.ts`, `verification.test.ts` (golden unchanged), `admin-doctors.test.ts`, `records*`, `migrations`, `db-roles` (its attachment rows), `no-store`, `records-explain`. Typecheck and `npx eslint .` clean. The contract parses, every `$ref` resolves, no duplicate `operationId`; `tests/unit/contract/record-attachments-contract.test.ts` pins the operations and the wording above.
- **Manual QA** (2026-10-19, [manual-qa.md](./manual-qa.md)): `scripts/curl-test-record-attachments.sh` 331 pass / 0 fail; `scripts/curl-test-verification.sh` re-run as the extraction gate 274 pass / 0 fail against a real Identity. **Limit:** both ran against the DEV-ONLY in-memory storage stand-in `scripts/storage-qa-fake-s3.mjs`, **not MinIO or S3** (Docker was unavailable). The module is not verified end to end against real MinIO until the script is repeated there and `tests/integration/storage-adapter.test.ts` runs green with MinIO.

### 14.4 Docs and contract state
`contracts/openapi.yaml` is final (C1-C6 and the review wording) and matches the code for the four routes, the `MedicalRecord.attachments` description and the `ErrorCode` enum; the hub copy is refreshed by the sync script. The doc refresh list of section 12 was carried out on 2026-10-20 (service card, INDEX, system-design router, architecture shards `file-handling`, `clinical-records`, `data-model`, `api`, `rbac`, `overview`, `infrastructure`, `capacity`, `deployment`, `resilience`, `runbook`, the records and verification spec pointers, ADR 0022 as written in E0). Owner-side `CLAUDE.md` text that lags the contract is reported, not edited, by `/update-docs`.
