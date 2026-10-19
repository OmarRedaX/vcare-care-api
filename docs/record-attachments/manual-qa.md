---
title: record-attachments — Manual QA (CURL)
owner: care-team
service: care-service
module: record-attachments
status: passed
diataxis: how-to
last_verified: 2026-10-19
tags: [manual-qa, record-attachments, records, attachments, uploads, upload-intents, presigned-post, download-url, lock-trigger, cap, audit, rbac, no-store, rate-limit, clinical-privacy, storage-stand-in]
related: [record-attachments-spec, record-attachments-tasks, record-attachments-brainstorm, records-manual-qa, verification-manual-qa, adr-0022-upload-intents-module, file-handling, clinical-records, rbac]
---

# record-attachments — Manual QA (CURL)

_Run: 2026-10-19 • Server: http://127.0.0.1:3001 (real Care API, `src/server.ts`), fake Identity http://127.0.0.1:3023, **storage stand-in** http://127.0.0.1:9013 (NOT real S3 or MinIO, see Environment) • Branch `feature/record-attachments` • Result: 331 pass / 0 fail_

Every route of the module is driven with CURL against the running server: `POST /api/records/{id}/attachments/uploads`, `POST /api/records/{id}/attachments/uploads/{uploadId}/complete`, `POST /api/records/{id}/attachments/{attachmentId}/download-url`, `DELETE /api/records/{id}/attachments/{attachmentId}`, plus `MedicalRecord.attachments` on `GET /api/records/{id}` and the patient timeline. The upload is done exactly as a browser does it: the intent's policy fields are sent with `curl --form-string`, the file last with `curl -F`, to the presigned URL; the 60 s download URL is then followed with a plain `GET`. Expected values come from `contracts/openapi.yaml` and `docs/record-attachments/spec.md` (sections 4, 5, 8, 10.3), not from "200". Rows with method `check` are database / storage-stand-in / Redis / server-log assertions made with the owner login (119 of 331); the other 212 rows are HTTP calls. All data is synthetic (patients 501 and 502, doctors 601-604 and 606, admins 1 and 2); clinical text and attachment descriptions are only short `QA-ATT-*` marker strings and marker bytes inside the test PDF, which this file never repeats. No token, cookie, presigned URL, POST field, storage key or secret is recorded.

**Extraction gate.** The same session re-ran `scripts/curl-test-verification.sh` against a real Identity: 274 pass / 0 fail, the recorded baseline (section "Extraction gate" below and [verification/manual-qa.md](../verification/manual-qa.md)).

## Environment
- Docker and MinIO were unavailable, so the stack ran natively. Isolated PostgreSQL 18.3 on `127.0.0.1:5499` (trust auth), throwaway database `care_qa_record_attachments_test`, migrated with the repo CLI as the owner role (`npm run migrate`: 31 migrations, including `20261018120000_create_record_attachments` and `20261018120100_comment_upload_intents_description`) and `ensure-app-login`, so the API connected as `care_app` (member of `vcare_app`), never as the owner. The jest database (`care_test`) and the shared `:5432` cluster were not touched. Redis `localhost:6379` db index 12 only (flushed before every call by the script, except inside the burst sections; no other index touched by Care).
- `node scripts/consultations-qa-fake-identity.mjs` (port 3023): JWKS and token minting (patients 5xx, doctors 6xx, admins, pending / rejected / suspended variants, expired, `typ=service`). The attachment routes make no Identity call.
- **`node scripts/storage-qa-fake-s3.mjs` (port 9013): a DEV-ONLY, in-memory, path-style S3 stand-in written for this run. It is NOT real S3 and NOT MinIO.** It implements only what `lib/storage/s3.adapter.ts` calls: the presigned POST (multipart, policy decoded and its `eq`, `starts-with`, `content-length-range` and expiry conditions enforced, exact key), `HEAD`, ranged `GET`, `CopyObject` (honouring `x-amz-copy-source-if-match`, else 412), `DeleteObject`, and the presigned `GET` (60 s expiry from `X-Amz-Date` + `X-Amz-Expires`, `response-content-disposition` / `response-content-type` honoured, anonymous reads refused with 403). It does **not** verify signatures or credentials, apply encryption, versioning, CORS, lifecycle rules or durability, and its timing and error bodies are approximations. It also exposes a QA control surface (`/__count`, `/__calls`, `/__clock`, `/__fail`, `/__reset`) used for the storage-side assertions, the expiry probes and the fault injection. What this run proves is the Care side of the contract (what Care signs, checks, stores, audits and returns) against an S3-shaped peer; it does not replace a run against real MinIO / S3 (see "Not exercised").
- `npx tsx src/server.ts` with `NODE_ENV=development`, `PORT=3001`, `INTERNAL_PORT=3101`, `VIDEO_PROVIDER=fake`, `STORAGE_ENDPOINT` = the stand-in, `STORAGE_FORCE_PATH_STYLE=true`, synthetic storage credentials, default upload / download TTLs (policy 300 s, intent 900 s, URL 60 s), `LOG_LEVEL=info` (the log is scanned by the script). `care-worker` ran once on demand (`npx tsx src/worker.ts --once upload-intent-purge` with the same environment) for the purge case.
- Run: `CARE_OWNER_DATABASE_URL=postgres://<owner>@127.0.0.1:5499/care_qa_record_attachments_test CARE_APP_DATABASE_URL=postgres://<care_app login>@127.0.0.1:5499/care_qa_record_attachments_test REDIS_URL=redis://127.0.0.1:6379/12 FAKE_S3_URL=http://127.0.0.1:9013 CARE_WORKER_PURGE_CMD='npx tsx src/worker.ts --once upload-intent-purge' SERVER_LOG=<care-api log> QA_REPORT=<file> bash scripts/curl-test-record-attachments.sh` (about 5 minutes; it refuses a database that does not end in `_test` or contain `_qa`). `FAKE_S3_URL`, `CARE_APP_DATABASE_URL`, `CARE_WORKER_PURGE_CMD` and `SERVER_LOG` are optional: without them the storage-side, direct grant / trigger, purge and log checks are reported as SKIPPED, not passed. `QA_KEEP=1` skips the end-of-run fixture reset; `QA_DEBUG_FILE` keeps the first 400 bytes of the body of a failed case.
- Windows (git-bash) host, Node 24.

## How the lock was reached
The 24 h lock is decided by database time (`locked_at <= NOW()`), so the script moves the clock of the record instead of waiting a day (same technique as [records/manual-qa.md](../records/manual-qa.md)): while the record is still open it runs one owner statement that sets `created_at`, `updated_at` and `locked_at` together to `now() - 24 h + N s`. `N = +150` leaves it open for the add and the delete that follow; `N = -3` makes it locked. The statement must run while the row is open (once locked, the `BEFORE UPDATE` trigger of `medical_records` refuses every update, the owner's included). The exact same-instant race is covered by the integration tests with a frozen transaction clock.

## Coverage summary
Authentication (none / malformed / expired / `typ=service`) on all four routes; role denials that fire before any lookup (**admin on all four routes** with an existing, unknown and non-numeric record id, two admins; patients on intent, complete and delete; pending and rejected doctors; pending patient and suspended admin on `download-url`); intent validation (blank, empty, 501 code points ASCII and non-ASCII, NUL, `null`, number, boolean, array, object, unknown members alone and next to a valid description, array / string / malformed JSON bodies) with no intent row and no audit written; the valid boundaries (no body, `{}`, 1 character, 500 code points, 500 astral code points counted as code points, newline) and the intent response shape (key set, policy decoded: `content-length-range` 1..10 485 760, exact `eq $key`, 5-minute policy, 15-minute intent); the full flow intent → browser-style presigned POST → `complete` (201, metadata only, detected type, HEAD size, description carried, intent consumed with `result_id`, quarantine object deleted, final object stored, `attachment.added` audit with flat metadata and `afterLock=false`) → replay (200, same id, no second row or audit) → list on `GET /records/{id}` for the patient, the author and a related doctor and on the timeline (zero storage calls) → `download-url` (60 s URL followed, bytes compared with `cmp`, `attachment` disposition and verified content type, the same URL without its signature refused, URL dead after expiry, **one audit row per issued URL**) → `DELETE` (204, soft delete, object kept, `attachment.removed` audit) → unlisted, `download-url` and second delete 404; detected type wins over the declared type and the name (JPEG named `.pdf`, PNG named `.txt`); the 10 485 760-byte boundary accepted; body rules (a JSON body on `complete`, `download-url` and `DELETE` is 400) and five malformed ids (`abc`, 0, -1, 1.5, a 20-digit number) on every path position, `DELETE …/attachments/uploads` 404; the RBAC matrix on `download-url` (patient owner, author, related doctor 200; other patient, stranger, cancelled-only doctor 404; admin and pending doctor 403; foreign-record attachment 404 under both record paths) and on the three writes (related, stranger, cancelled-only and another author 404; foreign, other-record, other-kind and unknown intent 404 with the intents left open); spoofed `X-User-Id` / `X-Role` ignored; `complete` verification (false bytes behind a `.pdf` name and `application/pdf` type → `400` `file`, no row, intent closed, replay `409 Conflict`; no object; oversize (10 485 761) and empty refused by the storage policy; tampered key and expired POST policy refused by the storage policy; expired intent `410 UploadIntentExpired`, object deleted, intent closed, replay `409`); storage faults (`HEAD` and copy failing → `500 InternalError`, no row, intent still open, the same `complete` then succeeds); the purge loop (`care-worker --once upload-intent-purge` closes an expired `record_attachment` intent and deletes its quarantine object, leaves unexpired intents open); the cap (19 live, the next intent uploaded before the cap, the 20th succeeds, `complete` at 20 and a 21st intent → `409 AttachmentLimitReached` with the quarantine object and the open intent intact, a delete frees a slot and the same intent then completes, **two concurrent completes at 19 → exactly one 201 and one 409**, added minus removed equals 20); the lock boundary (add before the lock `afterLock=false`; add after the lock allowed, `afterLock=true`, the `medical_records` row byte-for-byte unchanged both times; delete before the lock 204; delete after the lock `409 RecordLocked` with the attachment unchanged and no audit row; 404 beats 409 for an absent, already-deleted or other-record attachment; `download-url` still works on a locked record; admin 403); direct database guarantees (care_app soft delete after the lock raises `check_violation` 23514 from `trg_record_attachments_forbid_delete_after_lock`, the owner is refused too, column-level `UPDATE` denied with 42501 on every column but `deleted_at`, no `DELETE` / `TRUNCATE`, `INSERT` of `id` / `created_at` / `deleted_at` denied, the file-type, size and description CHECKs, the foreign key, `ON DELETE RESTRICT`, the exact column grants, and the positive control that a pre-lock soft delete passes the trigger); the locally suspended author (403 on intent, complete and delete, 404 on own `download-url`, the patient, a related doctor and the assigned doctor still open the file); `Idempotency-Key` ignored on the routes it was sent to (same key, different body: 201 twice, no 422, two different intents; two URLs issued); Redis scan (no marker, key, signed-URL parameter or storage host in any key or value, no `idem` key); rate limits (intents 20/h with the 21st `429`, per user, independent of the write and read buckets; complete + delete share the 20/min bucket; `download-url` 120/min with the 121st `429` and no audit row for it; `Retry-After` and `no-store` on the `429`; admin denial consumes no budget); audit hygiene (metadata allowlist, no marker / key / URL, doctor and patient actors only, `attachment.added` count equals the rows, `attachment.removed` count equals the soft-deleted rows, `GET /api/audit-logs` as admin shows the rows without clinical content); and a server-log scan for the markers, storage-key prefixes, signed-URL parameters, the storage host, `Bearer ` and a JWT prefix.

Every HTTP row also asserts: `success`, the full error envelope (`code`, `message`, `details[]`, `requestId` equal to the sent id), the echoed `X-Request-Id` header, `Cache-Control: no-store`, that an error body carries no marker, storage-key prefix or signed-URL parameter, and that no success body other than the intent and the download URL carries a URL, an object key or `uploadedByUserId`.

## Cases
| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 1 | check | fixtures | owner | six records with no attachment and no audit row yet | 6 0 0 | 6 0 0 | PASS |
| 2 | POST | /api/records/31/attachments/uploads | none | intent none | 401 Unauthorized | 401 Unauthorized | PASS |
| 3 | POST | /api/records/31/attachments/uploads/1/complete | none | complete none | 401 Unauthorized | 401 Unauthorized | PASS |
| 4 | POST | /api/records/31/attachments/1/download-url | none | download-url none | 401 Unauthorized | 401 Unauthorized | PASS |
| 5 | DELETE | /api/records/31/attachments/1 | none | delete none | 401 Unauthorized | 401 Unauthorized | PASS |
| 6 | POST | /api/records/31/attachments/uploads | malformed | intent malformed | 401 Unauthorized | 401 Unauthorized | PASS |
| 7 | POST | /api/records/31/attachments/uploads/1/complete | malformed | complete malformed | 401 Unauthorized | 401 Unauthorized | PASS |
| 8 | POST | /api/records/31/attachments/1/download-url | malformed | download-url malformed | 401 Unauthorized | 401 Unauthorized | PASS |
| 9 | DELETE | /api/records/31/attachments/1 | malformed | delete malformed | 401 Unauthorized | 401 Unauthorized | PASS |
| 10 | POST | /api/records/31/attachments/uploads | expired | intent expired | 401 TokenExpired | 401 TokenExpired | PASS |
| 11 | POST | /api/records/31/attachments/uploads/1/complete | expired | complete expired | 401 TokenExpired | 401 TokenExpired | PASS |
| 12 | POST | /api/records/31/attachments/1/download-url | expired | download-url expired | 401 TokenExpired | 401 TokenExpired | PASS |
| 13 | DELETE | /api/records/31/attachments/1 | expired | delete expired | 401 TokenExpired | 401 TokenExpired | PASS |
| 14 | POST | /api/records/31/attachments/uploads | service-token | intent service-token | 401 Unauthorized | 401 Unauthorized | PASS |
| 15 | POST | /api/records/31/attachments/uploads/1/complete | service-token | complete service-token | 401 Unauthorized | 401 Unauthorized | PASS |
| 16 | POST | /api/records/31/attachments/1/download-url | service-token | download-url service-token | 401 Unauthorized | 401 Unauthorized | PASS |
| 17 | DELETE | /api/records/31/attachments/1 | service-token | delete service-token | 401 Unauthorized | 401 Unauthorized | PASS |
| 18 | check | auth | owner | unauthenticated calls created no intent, no attachment, no audit row | 0 0 0 | 0 0 0 | PASS |
| 19 | POST | /api/records/31/attachments/uploads | admin | intent denied for admin (existing record) | 403 Forbidden | 403 Forbidden | PASS |
| 20 | POST | /api/records/99999999/attachments/uploads | admin | intent denied for admin (unknown record: role beats lookup) | 403 Forbidden | 403 Forbidden | PASS |
| 21 | POST | /api/records/abc/attachments/uploads | admin | intent denied for admin (non-numeric record id) | 403 Forbidden | 403 Forbidden | PASS |
| 22 | POST | /api/records/31/attachments/uploads/1/complete | admin | complete denied for admin | 403 Forbidden | 403 Forbidden | PASS |
| 23 | POST | /api/records/99999999/attachments/uploads/abc/complete | admin | complete denied for admin (unknown record, non-numeric upload id) | 403 Forbidden | 403 Forbidden | PASS |
| 24 | POST | /api/records/31/attachments/1/download-url | admin | download-url denied for admin (existing record) | 403 Forbidden | 403 Forbidden | PASS |
| 25 | POST | /api/records/99999999/attachments/99999999/download-url | admin | download-url denied for admin (unknown ids: role beats lookup) | 403 Forbidden | 403 Forbidden | PASS |
| 26 | POST | /api/records/abc/attachments/abc/download-url | admin | download-url denied for admin (non-numeric ids) | 403 Forbidden | 403 Forbidden | PASS |
| 27 | DELETE | /api/records/31/attachments/1 | admin | delete denied for admin | 403 Forbidden | 403 Forbidden | PASS |
| 28 | DELETE | /api/records/99999999/attachments/99999999 | admin | delete denied for admin (unknown ids) | 403 Forbidden | 403 Forbidden | PASS |
| 29 | POST | /api/records/31/attachments/uploads | admin2 | intent denied for admin2 (existing record) | 403 Forbidden | 403 Forbidden | PASS |
| 30 | POST | /api/records/99999999/attachments/uploads | admin2 | intent denied for admin2 (unknown record: role beats lookup) | 403 Forbidden | 403 Forbidden | PASS |
| 31 | POST | /api/records/abc/attachments/uploads | admin2 | intent denied for admin2 (non-numeric record id) | 403 Forbidden | 403 Forbidden | PASS |
| 32 | POST | /api/records/31/attachments/uploads/1/complete | admin2 | complete denied for admin2 | 403 Forbidden | 403 Forbidden | PASS |
| 33 | POST | /api/records/99999999/attachments/uploads/abc/complete | admin2 | complete denied for admin2 (unknown record, non-numeric upload id) | 403 Forbidden | 403 Forbidden | PASS |
| 34 | POST | /api/records/31/attachments/1/download-url | admin2 | download-url denied for admin2 (existing record) | 403 Forbidden | 403 Forbidden | PASS |
| 35 | POST | /api/records/99999999/attachments/99999999/download-url | admin2 | download-url denied for admin2 (unknown ids: role beats lookup) | 403 Forbidden | 403 Forbidden | PASS |
| 36 | POST | /api/records/abc/attachments/abc/download-url | admin2 | download-url denied for admin2 (non-numeric ids) | 403 Forbidden | 403 Forbidden | PASS |
| 37 | DELETE | /api/records/31/attachments/1 | admin2 | delete denied for admin2 | 403 Forbidden | 403 Forbidden | PASS |
| 38 | DELETE | /api/records/99999999/attachments/99999999 | admin2 | delete denied for admin2 (unknown ids) | 403 Forbidden | 403 Forbidden | PASS |
| 39 | POST | /api/records/31/attachments/uploads | patient | intent denied for a patient (patient) | 403 Forbidden | 403 Forbidden | PASS |
| 40 | POST | /api/records/31/attachments/uploads/1/complete | patient | complete denied for a patient (patient) | 403 Forbidden | 403 Forbidden | PASS |
| 41 | DELETE | /api/records/31/attachments/1 | patient | delete denied for a patient (patient) | 403 Forbidden | 403 Forbidden | PASS |
| 42 | POST | /api/records/31/attachments/uploads | patient-other | intent denied for a patient (patient-other) | 403 Forbidden | 403 Forbidden | PASS |
| 43 | POST | /api/records/31/attachments/uploads/1/complete | patient-other | complete denied for a patient (patient-other) | 403 Forbidden | 403 Forbidden | PASS |
| 44 | DELETE | /api/records/31/attachments/1 | patient-other | delete denied for a patient (patient-other) | 403 Forbidden | 403 Forbidden | PASS |
| 45 | POST | /api/records/31/attachments/uploads | doctor-pending | intent, doctor token status pending | 403 Forbidden | 403 Forbidden | PASS |
| 46 | POST | /api/records/31/attachments/uploads/1/complete | doctor-pending | complete, doctor token status pending | 403 Forbidden | 403 Forbidden | PASS |
| 47 | POST | /api/records/31/attachments/1/download-url | doctor-pending | download-url, doctor token status pending | 403 Forbidden | 403 Forbidden | PASS |
| 48 | DELETE | /api/records/31/attachments/1 | doctor-pending | delete, doctor token status pending | 403 Forbidden | 403 Forbidden | PASS |
| 49 | POST | /api/records/31/attachments/uploads | doctor-rejected | intent, doctor token status rejected | 403 Forbidden | 403 Forbidden | PASS |
| 50 | DELETE | /api/records/31/attachments/1 | doctor-rejected | delete, doctor token status rejected | 403 Forbidden | 403 Forbidden | PASS |
| 51 | POST | /api/records/31/attachments/1/download-url | patient-pending | download-url, patient token status pending | 403 Forbidden | 403 Forbidden | PASS |
| 52 | POST | /api/records/31/attachments/1/download-url | admin-suspended | download-url, admin token status suspended | 403 Forbidden | 403 Forbidden | PASS |
| 53 | check | rbac | owner | denied calls created no intent, no attachment, no audit row | 0 0 0 | 0 0 0 | PASS |
| 54 | POST | /api/records/31/attachments/uploads | doctor | intent validation: description-blank | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 55 | POST | /api/records/31/attachments/uploads | doctor | intent validation: description-empty | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 56 | POST | /api/records/31/attachments/uploads | doctor | intent validation: description-501-code-points | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 57 | POST | /api/records/31/attachments/uploads | doctor | intent validation: description-501-non-ascii | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 58 | POST | /api/records/31/attachments/uploads | doctor | intent validation: description-NUL | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 59 | POST | /api/records/31/attachments/uploads | doctor | intent validation: description-null | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 60 | POST | /api/records/31/attachments/uploads | doctor | intent validation: description-number | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 61 | POST | /api/records/31/attachments/uploads | doctor | intent validation: description-boolean | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 62 | POST | /api/records/31/attachments/uploads | doctor | intent validation: description-array | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 63 | POST | /api/records/31/attachments/uploads | doctor | intent validation: description-object | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 64 | POST | /api/records/31/attachments/uploads | doctor | intent validation: unknown-member-alone | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 65 | POST | /api/records/31/attachments/uploads | doctor | intent validation: unknown-member-with-valid-description | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 66 | POST | /api/records/31/attachments/uploads | doctor | intent validation: unknown-member-fileType | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 67 | POST | /api/records/31/attachments/uploads | doctor | intent validation: array-body | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 68 | POST | /api/records/31/attachments/uploads | doctor | intent validation: non-object-json-string | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 69 | POST | /api/records/31/attachments/uploads | doctor | intent validation: malformed-json | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 70 | check | validation | owner | validation failures created no intent row and no audit row | 0 0 | 0 0 | PASS |
| 71 | POST | /api/records/31/attachments/uploads | doctor | intent without a body at all | 201 | 201 | PASS |
| 72 | POST | /api/records/31/attachments/uploads | doctor | intent with an empty object | 201 | 201 | PASS |
| 73 | POST | /api/records/31/attachments/uploads | doctor | intent with a 1-character description | 201 | 201 | PASS |
| 74 | POST | /api/records/31/attachments/uploads | doctor | intent with a 500-code-point description | 201 | 201 | PASS |
| 75 | POST | /api/records/31/attachments/uploads | doctor | intent with 500 astral code points (1000 UTF-16 units): counted in code points | 201 | 201 | PASS |
| 76 | POST | /api/records/31/attachments/uploads | doctor | intent with a multi-line description (newline allowed) | 201 | 201 | PASS |
| 77 | check | validation | owner | six valid intents inserted six open record_attachment intents owned by the author for this record, no attachment, no audit row | 6 0 0 | 6 0 0 | PASS |
| 78 | check | validation | owner | the stored description of the 500-astral intent is 500 characters | 500 | 500 | PASS |
| 79 | POST | /api/records/31/attachments/uploads | doctor-spoof | spoofed X-User-Id / X-Role are ignored (related doctor stays 404) | 404 NotFound | 404 NotFound | PASS |
| 80 | POST | /api/records/31/attachments/uploads | doctor | intent with a description | 201 | 201 | PASS |
| 81 | check | db | owner | the intent row: kind record_attachment, target = the record, owner = the author, no document type, description kept, open, quarantine key, 10 MB cap, 15 minute expiry | record_attachment 31 601 true true false 10485760 true | record_attachment 31 601 true true false 10485760 true | PASS |
| 82 | check | storage | owner | creating an intent touched no stored object (signing is local) | 0 | 0 | PASS |
| 83 | check | upload | owner | the browser-style presigned POST of a PDF (declared application/pdf, file named .pdf) is accepted: 204 | 204 | 204 | PASS |
| 84 | check | storage | owner | quarantine / final object counts | 1 0 | 1 0 | PASS |
| 85 | POST | /api/records/31/attachments/uploads/476/complete | doctor | complete: the stored object is verified, promoted, and the attachment is created | 201 | 201 | PASS |
| 86 | check | db | owner | one live row: author, detected type, HEAD size, record-attachments/ key, description from the intent | 1 601 application/pdf 32 true true | 1 601 application/pdf 32 true true | PASS |
| 87 | check | db | owner | the intent is consumed with result_id = the attachment | true 206 | true 206 | PASS |
| 88 | check | storage | owner | quarantine / final object counts after complete | 0 1 | 0 1 | PASS |
| 89 | check | audit | owner | one attachment.added row (actor doctor, request id, entity record_attachment, flat metadata, afterLock false) | 1 | 1 | PASS |
| 90 | check | audit | owner | attachment.added metadata holds no description, key or marker | 0 | 0 | PASS |
| 91 | POST | /api/records/31/attachments/uploads/476/complete | doctor | replayed complete returns the same attachment with 200 | 200 | 200 | PASS |
| 92 | check | db | owner | the replay created no second row and no second audit row, left the quarantine area empty | 1 1 | 1 1 | PASS |
| 93 | GET | /api/records/31 | patient | GET record by the owning patient lists the attachment (metadata only) | 200 | 200 | PASS |
| 94 | GET | /api/records/31 | doctor | GET record by the author lists it | 200 | 200 | PASS |
| 95 | GET | /api/records/31 | doctor-related | GET record by a related doctor lists it | 200 | 200 | PASS |
| 96 | GET | /api/patients/501/records | patient | patient timeline carries the attachment on its record and [] on the others | 200 | 200 | PASS |
| 97 | check | storage | owner | reading a record and a timeline made zero storage calls | 0 | 0 | PASS |
| 98 | POST | /api/records/31/attachments/206/download-url | patient | download-url by the owning patient: 60 s URL | 200 | 200 | PASS |
| 99 | check | download | owner | following the presigned URL returns the file bytes, byte for byte | 200 same | 200 same | PASS |
| 100 | check | download | owner | the response is an attachment of the stored verified type | 1 1 | 1 1 | PASS |
| 101 | check | download | owner | the same object URL without its signature is refused (private bucket, no anonymous read): 403 | 403 | 403 | PASS |
| 102 | check | audit | owner | attachment.url_issued row written for the issued URL (patient, request id, flat metadata, viewerIsAuthor false) | 1 | 1 | PASS |
| 103 | POST | /api/records/31/attachments/206/download-url | doctor | download-url by the author | 200 | 200 | PASS |
| 104 | POST | /api/records/31/attachments/206/download-url | doctor | a second URL for the same attachment is a second issuance | 200 | 200 | PASS |
| 105 | POST | /api/records/31/attachments/206/download-url | doctor-related | download-url by a related doctor | 200 | 200 | PASS |
| 106 | check | audit | owner | one audit row per issued URL: 4 URLs issued, 4 rows (patient, author twice with viewerIsAuthor true, related doctor) | 4 2 | 4 2 | PASS |
| 107 | POST | /api/records/31/attachments/206/download-url | patient | download-url, for the expiry probe | 200 | 200 | PASS |
| 108 | check | download | owner | the URL stops working after its 60 s (stand-in clock moved 75 s forward): 403 | 403 | 403 | PASS |
| 109 | DELETE | /api/records/31/attachments/206 | doctor | delete before the lock: soft delete, 204 and an empty body | 204 | 204 | PASS |
| 110 | check | db | owner | the row is soft-deleted (deleted_at set), the object is kept (RA-D4) | 1 true | 1 true | PASS |
| 111 | check | audit | owner | one attachment.removed row (author, request id, metadata recordId only) | 1 | 1 | PASS |
| 112 | GET | /api/records/31 | patient | the deleted attachment is no longer listed | 200 | 200 | PASS |
| 113 | POST | /api/records/31/attachments/206/download-url | patient | download-url of a deleted attachment | 404 NotFound | 404 NotFound | PASS |
| 114 | POST | /api/records/31/attachments/206/download-url | doctor | download-url of a deleted attachment (author) | 404 NotFound | 404 NotFound | PASS |
| 115 | DELETE | /api/records/31/attachments/206 | doctor | second delete of the same attachment | 404 NotFound | 404 NotFound | PASS |
| 116 | check | upload | owner | a JPEG named scan.pdf, declared application/pdf, is accepted by the storage policy | 204 | 204 | PASS |
| 117 | POST | /api/records/31/attachments/uploads/477/complete | doctor | complete: detected image/jpeg, not the declared type or the name | 201 | 201 | PASS |
| 118 | check | upload | owner | a PNG named notes.txt, declared text/plain, is accepted by the storage policy | 204 | 204 | PASS |
| 119 | POST | /api/records/31/attachments/uploads/478/complete | doctor | complete: detected image/png | 201 | 201 | PASS |
| 120 | check | upload | owner | a file of exactly 10 485 760 bytes is accepted by the storage policy | 204 | 204 | PASS |
| 121 | POST | /api/records/31/attachments/uploads/479/complete | doctor | complete at the 10 MB boundary: accepted, size is the HEAD size | 201 | 201 | PASS |
| 122 | check | db | owner | three more live attachments (jpeg, png, 10 MB pdf), types are the detected ones | 3 image/jpeg,image/png,application/pdf | 3 image/jpeg,image/png,application/pdf | PASS |
| 123 | DELETE | /api/records/31/attachments/207 | doctor | cleanup delete of attachment 207 | 204 | 204 | PASS |
| 124 | DELETE | /api/records/31/attachments/208 | doctor | cleanup delete of attachment 208 | 204 | 204 | PASS |
| 125 | DELETE | /api/records/31/attachments/209 | doctor | cleanup delete of attachment 209 | 204 | 204 | PASS |
| 126 | check | upload | owner | fixture upload for the suspended-author intent | 204 | 204 | PASS |
| 127 | check | upload | owner | fixture upload for the foreign-intent matrix | 204 | 204 | PASS |
| 128 | POST | /api/records/31/attachments/uploads/484/complete | doctor | complete with a JSON body (the route takes none) | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 129 | POST | /api/records/31/attachments/210/download-url | doctor | download-url with a JSON body | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 130 | DELETE | /api/records/31/attachments/210 | doctor | delete with a JSON body | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 131 | check | body | owner | the body rejections changed nothing: the intent is open, the attachment live | false - 1 | false - 1 | PASS |
| 132 | POST | /api/records/abc/attachments/uploads | doctor | intent with bad record id [abc] | 404 NotFound | 404 NotFound | PASS |
| 133 | POST | /api/records/31/attachments/uploads/abc/complete | doctor | complete with bad upload id [abc] | 404 NotFound | 404 NotFound | PASS |
| 134 | POST | /api/records/31/attachments/abc/download-url | patient | download-url with bad attachment id [abc] | 404 NotFound | 404 NotFound | PASS |
| 135 | DELETE | /api/records/31/attachments/abc | doctor | delete with bad attachment id [abc] | 404 NotFound | 404 NotFound | PASS |
| 136 | POST | /api/records/abc/attachments/210/download-url | patient | download-url with bad record id [abc] | 404 NotFound | 404 NotFound | PASS |
| 137 | POST | /api/records/0/attachments/uploads | doctor | intent with bad record id [0] | 404 NotFound | 404 NotFound | PASS |
| 138 | POST | /api/records/31/attachments/uploads/0/complete | doctor | complete with bad upload id [0] | 404 NotFound | 404 NotFound | PASS |
| 139 | POST | /api/records/31/attachments/0/download-url | patient | download-url with bad attachment id [0] | 404 NotFound | 404 NotFound | PASS |
| 140 | DELETE | /api/records/31/attachments/0 | doctor | delete with bad attachment id [0] | 404 NotFound | 404 NotFound | PASS |
| 141 | POST | /api/records/0/attachments/210/download-url | patient | download-url with bad record id [0] | 404 NotFound | 404 NotFound | PASS |
| 142 | POST | /api/records/-1/attachments/uploads | doctor | intent with bad record id [-1] | 404 NotFound | 404 NotFound | PASS |
| 143 | POST | /api/records/31/attachments/uploads/-1/complete | doctor | complete with bad upload id [-1] | 404 NotFound | 404 NotFound | PASS |
| 144 | POST | /api/records/31/attachments/-1/download-url | patient | download-url with bad attachment id [-1] | 404 NotFound | 404 NotFound | PASS |
| 145 | DELETE | /api/records/31/attachments/-1 | doctor | delete with bad attachment id [-1] | 404 NotFound | 404 NotFound | PASS |
| 146 | POST | /api/records/-1/attachments/210/download-url | patient | download-url with bad record id [-1] | 404 NotFound | 404 NotFound | PASS |
| 147 | POST | /api/records/1.5/attachments/uploads | doctor | intent with bad record id [1.5] | 404 NotFound | 404 NotFound | PASS |
| 148 | POST | /api/records/31/attachments/uploads/1.5/complete | doctor | complete with bad upload id [1.5] | 404 NotFound | 404 NotFound | PASS |
| 149 | POST | /api/records/31/attachments/1.5/download-url | patient | download-url with bad attachment id [1.5] | 404 NotFound | 404 NotFound | PASS |
| 150 | DELETE | /api/records/31/attachments/1.5 | doctor | delete with bad attachment id [1.5] | 404 NotFound | 404 NotFound | PASS |
| 151 | POST | /api/records/1.5/attachments/210/download-url | patient | download-url with bad record id [1.5] | 404 NotFound | 404 NotFound | PASS |
| 152 | POST | /api/records/99999999999999999999/attachments/uploads | doctor | intent with bad record id [99999999999999999999] | 404 NotFound | 404 NotFound | PASS |
| 153 | POST | /api/records/31/attachments/uploads/99999999999999999999/complete | doctor | complete with bad upload id [99999999999999999999] | 404 NotFound | 404 NotFound | PASS |
| 154 | POST | /api/records/31/attachments/99999999999999999999/download-url | patient | download-url with bad attachment id [99999999999999999999] | 404 NotFound | 404 NotFound | PASS |
| 155 | DELETE | /api/records/31/attachments/99999999999999999999 | doctor | delete with bad attachment id [99999999999999999999] | 404 NotFound | 404 NotFound | PASS |
| 156 | POST | /api/records/99999999999999999999/attachments/210/download-url | patient | download-url with bad record id [99999999999999999999] | 404 NotFound | 404 NotFound | PASS |
| 157 | DELETE | /api/records/31/attachments/uploads | doctor | DELETE .../attachments/uploads reaches the delete route with attachmentId "uploads": 404 | 404 NotFound | 404 NotFound | PASS |
| 158 | POST | /api/records/31/attachments/210/download-url | patient | download-url: owning patient | 200 | 200 | PASS |
| 159 | POST | /api/records/31/attachments/210/download-url | doctor | download-url: author | 200 | 200 | PASS |
| 160 | POST | /api/records/31/attachments/210/download-url | doctor-related | download-url: doctor with a booked relationship to the patient | 200 | 200 | PASS |
| 161 | POST | /api/records/31/attachments/210/download-url | patient-other | download-url: another patient | 404 NotFound | 404 NotFound | PASS |
| 162 | POST | /api/records/31/attachments/210/download-url | doctor-unrelated | download-url: unrelated doctor | 404 NotFound | 404 NotFound | PASS |
| 163 | POST | /api/records/31/attachments/210/download-url | doctor-cancelled-only | download-url: doctor whose rows with the patient are cancelled / no_show only | 404 NotFound | 404 NotFound | PASS |
| 164 | POST | /api/records/31/attachments/210/download-url | admin | download-url: admin (existing attachment) | 403 Forbidden | 403 Forbidden | PASS |
| 165 | POST | /api/records/31/attachments/99999999/download-url | patient | download-url: unknown attachment id | 404 NotFound | 404 NotFound | PASS |
| 166 | POST | /api/records/99999999/attachments/210/download-url | patient | download-url: unknown record id | 404 NotFound | 404 NotFound | PASS |
| 167 | POST | /api/records/32/attachments/210/download-url | doctor | download-url: attachment of ANOTHER record under this record path (author of both) | 404 NotFound | 404 NotFound | PASS |
| 168 | POST | /api/records/32/attachments/210/download-url | patient-other | download-url: attachment of another record under the patient-owned record path | 404 NotFound | 404 NotFound | PASS |
| 169 | POST | /api/records/31/attachments/211/download-url | doctor | download-url: the other record attachment under this record path | 404 NotFound | 404 NotFound | PASS |
| 170 | POST | /api/records/31/attachments/210/download-url | patient-spoof | download-url: spoofed X-User-Id does not widen access | 404 NotFound | 404 NotFound | PASS |
| 171 | POST | /api/records/31/attachments/uploads | doctor-related | intent: related (not author) doctor | 404 NotFound | 404 NotFound | PASS |
| 172 | POST | /api/records/31/attachments/uploads | doctor-unrelated | intent: unrelated doctor | 404 NotFound | 404 NotFound | PASS |
| 173 | POST | /api/records/31/attachments/uploads | doctor-cancelled-only | intent: cancelled / no_show-only doctor | 404 NotFound | 404 NotFound | PASS |
| 174 | POST | /api/records/99999999/attachments/uploads | doctor | intent: unknown record | 404 NotFound | 404 NotFound | PASS |
| 175 | POST | /api/records/36/attachments/uploads | doctor | intent: the author of ANOTHER record is not the author of this one | 404 NotFound | 404 NotFound | PASS |
| 176 | POST | /api/records/31/attachments/uploads/484/complete | doctor-related | complete: related doctor with the author intent id | 404 NotFound | 404 NotFound | PASS |
| 177 | POST | /api/records/31/attachments/uploads/484/complete | doctor-unrelated | complete: unrelated doctor | 404 NotFound | 404 NotFound | PASS |
| 178 | POST | /api/records/31/attachments/uploads/484/complete | doctor-cancelled-only | complete: cancelled / no_show-only doctor | 404 NotFound | 404 NotFound | PASS |
| 179 | POST | /api/records/31/attachments/uploads/484/complete | doctor-603 | complete: another author doctor on this record path (resolver) | 404 NotFound | 404 NotFound | PASS |
| 180 | POST | /api/records/36/attachments/uploads/484/complete | doctor | complete: the intent id of record 1 on a record 601 does not author (resolver) | 404 NotFound | 404 NotFound | PASS |
| 181 | POST | /api/records/31/attachments/uploads/483/complete | doctor | complete: ANOTHER doctor's intent (owner mismatch) | 404 NotFound | 404 NotFound | PASS |
| 182 | POST | /api/records/32/attachments/uploads/484/complete | doctor | complete: the intent of ANOTHER record (author of both): target mismatch | 404 NotFound | 404 NotFound | PASS |
| 183 | POST | /api/records/31/attachments/uploads/485/complete | doctor | complete: an intent of ANOTHER kind (verification_document) owned by the caller | 404 NotFound | 404 NotFound | PASS |
| 184 | POST | /api/records/31/attachments/uploads/99999999/complete | doctor | complete: unknown upload id | 404 NotFound | 404 NotFound | PASS |
| 185 | check | complete | owner | every foreign / other-record / other-kind attempt left the intents open and created no attachment | false - false - 1 | false - false - 1 | PASS |
| 186 | DELETE | /api/records/31/attachments/210 | doctor-related | delete: related doctor | 404 NotFound | 404 NotFound | PASS |
| 187 | DELETE | /api/records/31/attachments/210 | doctor-unrelated | delete: unrelated doctor | 404 NotFound | 404 NotFound | PASS |
| 188 | DELETE | /api/records/31/attachments/210 | doctor-cancelled-only | delete: cancelled / no_show-only doctor | 404 NotFound | 404 NotFound | PASS |
| 189 | DELETE | /api/records/99999999/attachments/210 | doctor | delete: unknown record | 404 NotFound | 404 NotFound | PASS |
| 190 | DELETE | /api/records/31/attachments/99999999 | doctor | delete: unknown attachment | 404 NotFound | 404 NotFound | PASS |
| 191 | DELETE | /api/records/31/attachments/211 | doctor | delete: an attachment of ANOTHER record under this path | 404 NotFound | 404 NotFound | PASS |
| 192 | DELETE | /api/records/32/attachments/210 | doctor | delete: this record attachment under another record path | 404 NotFound | 404 NotFound | PASS |
| 193 | DELETE | /api/records/31/attachments/210 | doctor-spoof | delete: spoofed X-User-Id / X-Role are ignored | 404 NotFound | 404 NotFound | PASS |
| 194 | check | rbac | owner | no denied write changed an attachment; the main attachment is still live and its row unchanged | 1 | 1 | PASS |
| 195 | check | rbac | owner | NotAssignedDoctor never appears: spot check of the related doctor on every write route | 0 | 0 | PASS |
| 196 | check | upload | owner | plain text named evil.pdf, declared application/pdf: the storage policy accepts it (it does not read bytes) | 204 | 204 | PASS |
| 197 | POST | /api/records/31/attachments/uploads/486/complete | doctor | complete: false bytes behind a .pdf name are rejected | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 198 | check | db | owner | no row, intent closed without a result | 1 true - | 1 true - | PASS |
| 199 | check | storage | owner | the rejected object was deleted from quarantine (count back to its value before the upload) | 2 | 2 | PASS |
| 200 | POST | /api/records/31/attachments/uploads/486/complete | doctor | complete: replaying the closed (rejected) intent | 409 Conflict | 409 Conflict | PASS |
| 201 | POST | /api/records/31/attachments/uploads/487/complete | doctor | complete: no object was uploaded | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 202 | check | db | owner | the missing-object intent is closed without a result, no row | 1 true - | 1 true - | PASS |
| 203 | check | upload | owner | a file of 10 485 761 bytes is refused by the presigned POST policy (content-length-range): 400 | 400 | 400 | PASS |
| 204 | check | upload | owner | a 0-byte file is refused by the presigned POST policy (content-length-range): 400 | 400 | 400 | PASS |
| 205 | check | storage | owner | neither refused upload left an object (quarantine count unchanged) | 2 | 2 | PASS |
| 206 | POST | /api/records/31/attachments/uploads/488/complete | doctor | complete: after a refused (oversize / empty) upload there is no object | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 207 | check | upload | owner | a POST with a different key than the policy allows is refused (403) | 403 | 403 | PASS |
| 208 | POST | /api/records/31/attachments/uploads/489/complete | doctor | complete: the tampered upload stored nothing under the intent key | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 209 | check | upload | owner | a POST after the policy expiry (stand-in clock +400 s, intent still open) is refused: 403 | 403 | 403 | PASS |
| 210 | POST | /api/records/31/attachments/uploads/490/complete | doctor | complete: nothing stored after the expired policy | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 211 | check | db | owner | none of the failed completes created an attachment | 1 | 1 | PASS |
| 212 | check | upload | owner | upload for the expired-intent case | 204 | 204 | PASS |
| 213 | POST | /api/records/31/attachments/uploads/491/complete | doctor | complete after expires_at: 410 | 410 UploadIntentExpired | 410 UploadIntentExpired | PASS |
| 214 | check | db | owner | the expired intent is closed without a result, no row | 1 true - | 1 true - | PASS |
| 215 | check | storage | owner | the expired intent quarantine object was deleted (count back to its value before the upload) | 2 | 2 | PASS |
| 216 | POST | /api/records/31/attachments/uploads/491/complete | doctor | complete: replaying the closed expired intent | 409 Conflict | 409 Conflict | PASS |
| 217 | check | upload | owner | upload for the head-fault case | 204 | 204 | PASS |
| 218 | POST | /api/records/31/attachments/uploads/492/complete | doctor | complete while the storage head call fails | 500 InternalError | 500 InternalError | PASS |
| 219 | check | db | owner | storage head fault: no row, intent still open, no audit row | 1 false - | 1 false - | PASS |
| 220 | POST | /api/records/31/attachments/uploads/492/complete | doctor | the same complete succeeds once storage recovers (head) | 201 | 201 | PASS |
| 221 | DELETE | /api/records/31/attachments/213 | doctor | cleanup delete after the head fault case | 204 | 204 | PASS |
| 222 | check | upload | owner | upload for the copy-fault case | 204 | 204 | PASS |
| 223 | POST | /api/records/31/attachments/uploads/493/complete | doctor | complete while the storage copy call fails | 500 InternalError | 500 InternalError | PASS |
| 224 | check | db | owner | storage copy fault: no row, intent still open, no audit row | 1 false - | 1 false - | PASS |
| 225 | POST | /api/records/31/attachments/uploads/493/complete | doctor | the same complete succeeds once storage recovers (copy) | 201 | 201 | PASS |
| 226 | DELETE | /api/records/31/attachments/214 | doctor | cleanup delete after the copy fault case | 204 | 204 | PASS |
| 227 | check | upload | owner | upload for the purge case | 204 | 204 | PASS |
| 228 | check | purge | owner | care-worker --once upload-intent-purge ran and logged upload_intent_purge_done | 1 | 1 | PASS |
| 229 | check | purge | owner | the expired record_attachment intent was closed without a result | true - | true - | PASS |
| 230 | check | purge | owner | an unexpired open intent was left open | false - | false - | PASS |
| 231 | check | purge | owner | the purge deleted the expired intent quarantine object | 2 | 2 | PASS |
| 232 | POST | /api/records/31/attachments/uploads/494/complete | doctor | complete of the purged intent | 409 Conflict | 409 Conflict | PASS |
| 233 | check | cap | owner | 19 live attachments after 19 completes | 19 | 19 | PASS |
| 234 | check | upload | owner | the next intent is created at 19 and its file uploaded before the cap is reached | 204 | 204 | PASS |
| 235 | GET | /api/records/34 | patient | the 20th attachment succeeded: the record lists 20 | 200 | 200 | PASS |
| 236 | POST | /api/records/34/attachments/uploads/515/complete | doctor | complete with 20 live: 409 AttachmentLimitReached | 409 AttachmentLimitReached | 409 AttachmentLimitReached | PASS |
| 237 | check | cap | owner | the refused complete left 20 rows, the intent open and (courtesy pre-check) the quarantine object intact | 20 false - | 20 false - | PASS |
| 238 | check | storage | owner | the quarantine object is still there | 3 | 3 | PASS |
| 239 | POST | /api/records/34/attachments/uploads | doctor | a 21st intent: 409 AttachmentLimitReached | 409 AttachmentLimitReached | 409 AttachmentLimitReached | PASS |
| 240 | DELETE | /api/records/34/attachments/215 | doctor | delete one attachment frees a slot | 204 | 204 | PASS |
| 241 | POST | /api/records/34/attachments/uploads/515/complete | doctor | the SAME intent now completes (the doctor deleted one and retried) | 201 | 201 | PASS |
| 242 | check | cap | owner | back at 20 live, intent consumed | 20 true | 20 true | PASS |
| 243 | DELETE | /api/records/34/attachments/216 | doctor | delete one more (19 live) for the concurrency case | 204 | 204 | PASS |
| 244 | check | upload | owner | upload A | 204 | 204 | PASS |
| 245 | check | upload | owner | upload B | 204 | 204 | PASS |
| 246 | check | concurrency | owner | two simultaneous completes at 19 live: exactly one 201 and one 409 | 201 409  | 201 409  | PASS |
| 247 | check | concurrency | owner | the loser answers AttachmentLimitReached; the record holds exactly 20 live attachments | AttachmentLimitReached 20 | AttachmentLimitReached 20 | PASS |
| 248 | check | cap | owner | the 20-attachment record never exceeded 20: attachment.added rows minus the soft-deleted rows equal 20 live | 20 | 20 | PASS |
| 249 | check | lock | owner | add before the lock: afterLock false, and the medical_records row is byte-for-byte unchanged | false <row hash> | false <row hash> | PASS |
| 250 | DELETE | /api/records/33/attachments/237 | doctor | delete before the lock (about 2 minutes ahead): 204 | 204 | 204 | PASS |
| 251 | check | lock | owner | add AFTER the lock is allowed: afterLock true (database time), medical_records row byte-for-byte unchanged | true <row hash> | true <row hash> | PASS |
| 252 | GET | /api/records/33 | patient | the locked record lists the attachment added after the lock | 200 | 200 | PASS |
| 253 | DELETE | /api/records/33/attachments/238 | doctor | delete AFTER the lock: 409 RecordLocked | 409 RecordLocked | 409 RecordLocked | PASS |
| 254 | check | lock | owner | the refused delete left the attachment live and unchanged, wrote no audit row | <row hash> 0 | <row hash> 0 | PASS |
| 255 | DELETE | /api/records/33/attachments/237 | doctor | locked record, attachment already deleted before the lock: 404 beats 409 | 404 NotFound | 404 NotFound | PASS |
| 256 | DELETE | /api/records/33/attachments/99999999 | doctor | locked record, absent attachment: 404 beats 409 | 404 NotFound | 404 NotFound | PASS |
| 257 | DELETE | /api/records/33/attachments/210 | doctor | locked record, attachment of another record: 404 beats 409 | 404 NotFound | 404 NotFound | PASS |
| 258 | POST | /api/records/33/attachments/238/download-url | patient | download-url still works on a locked record | 200 | 200 | PASS |
| 259 | POST | /api/records/33/attachments/238/download-url | doctor-related | download-url on a locked record by a related doctor | 200 | 200 | PASS |
| 260 | DELETE | /api/records/33/attachments/238 | admin | admin delete on a locked record: still 403 | 403 Forbidden | 403 Forbidden | PASS |
| 261 | check | db | owner | care_app soft delete of an attachment of a LOCKED record raises check_violation (23514) from the trigger | 1 1 | 1 1 | PASS |
| 262 | check | db | owner | the trigger names itself as the violated constraint | 1 | 1 | PASS |
| 263 | check | db | owner | the owner is refused too (the trigger fires for every role) | 1 | 1 | PASS |
| 264 | check | db | owner | the refused direct updates left the row unchanged | <row hash> | <row hash> | PASS |
| 265 | check | db | owner | care_app UPDATE of record_attachments.description is permission denied (SQLSTATE 42501) | 1 | 1 | PASS |
| 266 | check | db | owner | care_app UPDATE of record_attachments.object_key is permission denied (SQLSTATE 42501) | 1 | 1 | PASS |
| 267 | check | db | owner | care_app UPDATE of record_attachments.file_type is permission denied (SQLSTATE 42501) | 1 | 1 | PASS |
| 268 | check | db | owner | care_app UPDATE of record_attachments.size_bytes is permission denied (SQLSTATE 42501) | 1 | 1 | PASS |
| 269 | check | db | owner | care_app UPDATE of record_attachments.uploaded_by_user_id is permission denied (SQLSTATE 42501) | 1 | 1 | PASS |
| 270 | check | db | owner | care_app UPDATE of record_attachments.medical_record_id is permission denied (SQLSTATE 42501) | 1 | 1 | PASS |
| 271 | check | db | owner | care_app UPDATE of record_attachments.created_at is permission denied (SQLSTATE 42501) | 1 | 1 | PASS |
| 272 | check | db | owner | care_app UPDATE of record_attachments.id is permission denied (SQLSTATE 42501) | 1 | 1 | PASS |
| 273 | check | db | owner | care_app has no DELETE and no TRUNCATE on record_attachments | 1 1 | 1 1 | PASS |
| 274 | check | db | owner | care_app cannot set id / created_at / deleted_at on INSERT (column-level grant) | 3 | 3 | PASS |
| 275 | check | db | owner | the file-type CHECK refuses a type outside PDF / JPEG / PNG | 1 | 1 | PASS |
| 276 | check | db | owner | the size CHECK refuses 0 and 10 485 761 bytes | 2 | 2 | PASS |
| 277 | check | db | owner | the description CHECK refuses a blank description | 1 | 1 | PASS |
| 278 | check | db | owner | a dangling record id is refused by the foreign key | 1 | 1 | PASS |
| 279 | check | db | owner | the owner cannot DELETE the parent medical record while attachments exist (ON DELETE RESTRICT) | 1 | 1 | PASS |
| 280 | check | db | owner | care_app privileges: UPDATE on deleted_at only; INSERT on exactly the six columns; SELECT yes; no table-level UPDATE / DELETE | deleted_at;description,file_type,medical_record_id,object_key,size_bytes,uploaded_by_user_id;true;false;false | deleted_at;description,file_type,medical_record_id,object_key,size_bytes,uploaded_by_user_id;true;false;false | PASS |
| 281 | check | db | owner | control: care_app soft delete of an attachment of an OPEN record is allowed by the trigger | 1 | 1 | PASS |
| 282 | POST | /api/records/36/attachments/uploads | doctor-suspended | intent by a locally suspended author | 403 Forbidden | 403 Forbidden | PASS |
| 283 | POST | /api/records/36/attachments/uploads/483/complete | doctor-suspended | complete by a locally suspended author | 403 Forbidden | 403 Forbidden | PASS |
| 284 | DELETE | /api/records/36/attachments/212 | doctor-suspended | delete by a locally suspended author | 403 Forbidden | 403 Forbidden | PASS |
| 285 | POST | /api/records/36/attachments/212/download-url | doctor-suspended | download-url of own attachment by a locally suspended author: 404 | 404 NotFound | 404 NotFound | PASS |
| 286 | POST | /api/records/36/attachments/212/download-url | patient | the patient still opens the suspended author file | 200 | 200 | PASS |
| 287 | POST | /api/records/36/attachments/212/download-url | doctor-related | another consulted doctor still opens the suspended author file | 200 | 200 | PASS |
| 288 | POST | /api/records/36/attachments/212/download-url | doctor | the assigned doctor of the patient opens it too | 200 | 200 | PASS |
| 289 | check | suspended | owner | the suspended-author calls changed nothing: attachment live, intent open | 1 false - | 1 false - | PASS |
| 290 | POST | /api/records/36/attachments/uploads/483/complete | doctor-603 | after reinstatement the same intent completes (control) | 201 | 201 | PASS |
| 291 | POST | /api/records/31/attachments/uploads | doctor | intent with an Idempotency-Key | 201 | 201 | PASS |
| 292 | POST | /api/records/31/attachments/uploads | doctor | same Idempotency-Key, different body: processed again, no 422, a different intent | 201 | 201 | PASS |
| 293 | POST | /api/records/31/attachments/210/download-url | patient | download-url with an Idempotency-Key | 200 | 200 | PASS |
| 294 | POST | /api/records/31/attachments/210/download-url | patient | same key again: a second issuance, not a replay | 200 | 200 | PASS |
| 295 | check | redis | owner | no marker, storage key, signed-URL parameter or storage host in any Redis key or value; no idempotency key stored; Redis had keys to scan | 0 0 keys | 0 0 keys | PASS |
| 296 | check | ratelimit | owner | intent bucket: 20 intents in the hour all succeed | 201 x20; | 201 x20; | PASS |
| 297 | POST | /api/records/35/attachments/uploads | doctor | the 21st intent is limited | 429 RateLimited | 429 RateLimited | PASS |
| 298 | check | ratelimit | owner | the 429 carries Retry-After and no-store | 1 1 | 1 1 | PASS |
| 299 | check | ratelimit | owner | the limited intent created no row (20 open intents for the rate-limit record) | 20 | 20 | PASS |
| 300 | POST | /api/records/36/attachments/uploads | doctor-603 | the intent bucket is per user: another author is not limited | 201 | 201 | PASS |
| 301 | POST | /api/records/35/attachments/210/download-url | patient | the read bucket is independent of the intent bucket | 404 NotFound | 404 NotFound | PASS |
| 302 | POST | /api/records/31/attachments/uploads | doctor-related | a denied (404) call by another user consumed none of the author budget and is not limited | 404 NotFound | 404 NotFound | PASS |
| 303 | check | ratelimit | owner | write bucket: 20 deletes of an absent attachment in a minute all answer 404 (budget consumed after authorize) | 404 x20; | 404 x20; | PASS |
| 304 | DELETE | /api/records/35/attachments/99999999 | doctor | the 21st write (a delete) is limited | 429 RateLimited | 429 RateLimited | PASS |
| 305 | POST | /api/records/35/attachments/uploads/99999999/complete | doctor | complete shares the write bucket: limited too | 429 RateLimited | 429 RateLimited | PASS |
| 306 | POST | /api/records/31/attachments/210/download-url | doctor | the read bucket is independent: the same doctor can still request a URL | 200 | 200 | PASS |
| 307 | DELETE | /api/records/35/attachments/99999999 | admin | admin is denied at the role step and consumes no budget (403, not 429) | 403 Forbidden | 403 Forbidden | PASS |
| 308 | check | ratelimit | owner | read bucket: 120 download-url calls in a minute all succeed | 200 x120; | 200 x120; | PASS |
| 309 | POST | /api/records/31/attachments/210/download-url | patient | the 121st download-url is limited | 429 RateLimited | 429 RateLimited | PASS |
| 310 | check | ratelimit | owner | one audit row per issued URL: 120 rows for 120 URLs, none for the limited call | 120 | 120 | PASS |
| 311 | check | audit | owner | every attachment audit row has only flat scalar metadata keys from the allowlist | 0 | 0 | PASS |
| 312 | check | audit | owner | no audit row holds a marker, an object key, a quarantine key or a URL | 0 | 0 | PASS |
| 313 | check | audit | owner | attachment audit rows are attributed to doctors and patients only, never to an admin | 0 | 0 | PASS |
| 314 | check | audit | owner | attachment.added rows equal the attachments ever created through the API (one per row, none for replays, refusals or rollbacks) | 36 | 36 | PASS |
| 315 | check | audit | owner | attachment.removed rows equal the soft-deleted rows (minus the one direct-SQL control) | 9 | 9 | PASS |
| 316 | check | audit | owner | every audit entity of an attachment action exists as a row (entity ids are real attachment ids) | 0 | 0 | PASS |
| 317 | GET | /api/audit-logs?action=attachment.url_issued&limit=100 | admin | admin reads the attachment audit rows (metadata only) | 200 | 200 | PASS |
| 318 | check | log | owner | captured log is non-trivial | 1 | 1 | PASS |
| 319 | check | log | owner | no '<synthetic marker>' in the server log | 0 | 0 | PASS |
| 320 | check | log | owner | no '<synthetic marker>' in the server log | 0 | 0 | PASS |
| 321 | check | log | owner | no '<synthetic marker>' in the server log | 0 | 0 | PASS |
| 322 | check | log | owner | no '<synthetic marker>' in the server log | 0 | 0 | PASS |
| 323 | check | log | owner | no '<synthetic marker>' in the server log | 0 | 0 | PASS |
| 324 | check | log | owner | no 'QA-ATT-' in the server log | 0 | 0 | PASS |
| 325 | check | log | owner | no 'quarantine/' in the server log | 0 | 0 | PASS |
| 326 | check | log | owner | no 'record-attachments/' in the server log | 0 | 0 | PASS |
| 327 | check | log | owner | no 'X-Amz' in the server log | 0 | 0 | PASS |
| 328 | check | log | owner | no '127.0.0.1:9013' in the server log | 0 | 0 | PASS |
| 329 | check | log | owner | no 'Bearer ' in the server log | 0 | 0 | PASS |
| 330 | check | log | owner | no '<jwt prefix>' in the server log | 0 | 0 | PASS |
| 331 | check | log | owner | no 5xx request_completed line in the captured log other than the two injected storage faults | 2 | 2 | PASS |

## Failures / notes
- **No product failure:** every case matches the spec and the contract. No `NotAssignedDoctor` appeared on any attachment route, no 5xx other than the two deliberately injected storage faults, and the server log (scanned for the markers, the `quarantine/` and `record-attachments/` prefixes, `X-Amz`, the storage host, `Bearer ` and a JWT prefix) held none of them. The captured log has `error` level lines only for those two faults (`unhandled_error` and `request_completed`, one pair per fault; the error carries the operation name only).
- **Storage faults need two failures.** The AWS SDK client in `lib/storage` retries a 5xx once (`maxAttempts: 2`), so the stand-in is told to fail the next two `HEAD` (or copy) calls; one failure is retried away and `complete` succeeds. This is adapter behaviour, not a defect.
- **One 500 writes two log lines** (`unhandled_error` and `request_completed`), so the log check counts `request_completed` lines with a 5xx status (exactly 2 expected).
- Harness issues found while building the script (not product failures): (1) non-ASCII characters and `\u` escape sequences typed into the script were converted to raw characters by the editing tool, so the Windows `curl --data-binary` re-encoded them and the 500-astral-code-point intent came back `400`; the script now builds those bodies from ASCII-only escape text generated by `uesc()`. (2) The first run of the final script reported three failures because the QA database still held 45 `upload_intents` rows created by the verification run that shared it; the counts and the reset now filter on `kind = 'record_attachment'`. (3) The verification re-run (case 95, unsigned object URL) exposed that the first version of the stand-in answered anonymous reads with 200; a private bucket answers 403, so the stand-in now does, and this script has an explicit case for it (row "the same object URL without its signature is refused").
- Tokens live 15 minutes and the fake Identity memoises them for 10, so the script re-mints all tokens at the start of every section.
- The `care_app` login on the isolated cluster already existed (`ensure-app-login` reported `created: false`). The database `care_qa_record_attachments_test`, the processes started for this run (fake Identity, storage stand-in, API) were stopped and removed afterwards, Redis db 12 was flushed, and the jest database was never touched.

## Not exercised by CURL (covered elsewhere or not coverable here)
- **Real S3 / MinIO behaviour.** Not run: signature validity of the presigned POST and GET, the `x-amz-server-side-encryption` header being accepted, bucket CORS, Block Public Access, clock skew, real error bodies and the adapter's own timeouts. `tests/integration/storage-adapter.test.ts` (MinIO) is the suite for that and could not run here either (it needs Docker). **This run must be repeated against MinIO or a real bucket before the module is called verified end to end.**
- A re-POST to the quarantine key after the checks (the ETag-bound `promote` failure, `replaceAfterNextHead`), a failing audit insert on `complete` / `download-url` (rollback, no URL, no presign), the same-instant race of a delete against the lock moment, a mid-flight lock-refused `complete` (`409` + `Retry-After: 1`), the deadlock races (a `PATCH` or a follow-up booking racing a `complete`), the `EXPLAIN` plans and the timing budgets: these need fault injection, a frozen clock or concurrency control and are covered by the integration suites `record-attachments-rules`, `-audit`, `-links` and `records-explain`.
- A real `care-worker` loop interval: only the single `--once upload-intent-purge` tick was run.

## Extraction gate: `scripts/curl-test-verification.sh` re-run (2026-10-19)
The spec (section 2) makes this script the gate for the `upload-intents` extraction. It ran in the same session on the same branch against: the **real** `vcare-identity-api` (branch `main`, which now implements `GET /internal/users` and `PATCH /internal/users/{id}/status`, so no shim) on its own throwaway PostgreSQL database `identity_qa_verification_test` (same native `:5499` cluster, argon2 prebuilt for Windows, a freshly seeded `care-qa-verification` service client, Redis db 10); `care-api` and a **continuously running** `care-worker` with `IDENTITY_JWKS_URL` / `IDENTITY_INTERNAL_URL` pointing at that Identity; and the **same storage stand-in** instead of MinIO. The Identity outage section was driven by the script killing and restarting the whole Identity process.
- **First run: 273 pass / 1 fail.** Case 95 ("unsigned object URL is private", expected 403, got 200) failed because the stand-in answered anonymous reads with 200. Diagnosis: a stand-in gap (a private bucket refuses anonymous reads), not a Care defect; the stand-in was fixed.
- **Second run, fixed stand-in, clean databases: 274 pass / 0 fail / 0 skipped, equal to the recorded baseline (274 / 0).** All sections ran, including the Identity outage, the `202` pending answer and the worker convergence to `approved/synced` (case 244), the `upload-intent-purge` tick (case 264), the expired intent `410` (case 71), the presigned URL expiry after 60 s (case 271) and the log hygiene grep (case 274).
- Caveat: storage was the stand-in, not MinIO, so this proves the extraction preserved verification's behaviour against an S3-shaped peer; the golden statement test and the MinIO adapter suite remain the other oracles.
