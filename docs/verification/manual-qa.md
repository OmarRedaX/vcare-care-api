---
title: verification — Manual QA (CURL)
owner: care-team
service: care-service
module: verification
status: verified
diataxis: how-to
last_verified: 2026-10-08
tags: [verification, manual-qa, curl, rbac, minio, identity-sync, worker, case-1, case-2]
related: [verification-spec, verification-tasks, verification-brainstorm, file-handling, integration, quickstart]
---

# verification — Manual QA (CURL)

_Run: 2026-10-08 • Server: http://localhost:3001 (internal 3101) • Result: 274 pass / 0 fail (plus 2 pass in the separate real-Identity probe)_

Repeatable form: `scripts/curl-test-verification.sh` (the main table below is its report, `PHASE=all`; the probe is `PHASE=gap`). Every case checks the status, `error.code`, the response shape against `contracts/openapi.yaml`, the echoed `X-Request-Id`, `Cache-Control: no-store`, and that no storage key or URL leaks into read DTOs. Tokens, presigned URLs, cookies, emails and bodies are not recorded; the reviewer-reason sentinel is shown as `<reason sentinel>`. All data is synthetic (`@example.test`, generated PDF/PNG/JPEG bytes).

## Environment

| Component | How it ran |
|---|---|
| Identity | Real `vcare-identity-api` (branch `feature/internal`, used read-only; only its own dev DB was migrated and a `care-qa-verification` service client seeded with `npm run seed:service-client`). Public `:3000`, internal `:3100`. Users (patient, admin, 8 doctors) were inserted by SQL with a per-run password; tokens came from `POST /api/auth/login`. |
| Identity internal users API | **Not implemented** in the real Identity yet (`GET /internal/users` and `PATCH /internal/users/{id}/status` exist only in its contract). The decision and sync cases therefore ran through a small QA shim on `:3110` (kept outside both repos) that forwards `/internal/auth/*` and health to the real Identity and serves the two missing routes from Identity's own `users` table, following `../vcare-hub/contracts/identity-service.openapi.yaml` (`pending to active/rejected`, `rejected to pending`, `active to suspended`, same status = 200, any other pair = `409 InvalidStatusTransition`). Care's `IDENTITY_INTERNAL_URL` pointed at the shim; service tokens were real. |
| Care | `care-api` and `care-worker` from `feature/verification` via `tsx` on the host, against the local Postgres (`vcare_care`, with the four verification migrations applied) and Redis db 1. |
| Storage | Real MinIO from care's `docker-compose.yml` (`minio`, `minio-setup`, host `:9002`, bucket `care-private`). Presigned POSTs and GETs were driven with CURL as a browser would. |
| Outage | The script stopped and restarted the shim (`IDENTITY_STOP_CMD` / `IDENTITY_START_CMD`); the real Identity (JWKS, login) stayed up. |

## Cases

Real Identity probe (`PHASE=gap`, Care pointed at the real Identity internal listener `:3100`, then re-pointed):

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| G1 | PATCH | /api/admin/applications/{id}/approve | admin | approve a submitted application while the real Identity has no `/internal/users/{id}/status` route | 200 or 202 pending | 202 (`approved/pending`; job `pending`, attempts 3, `last_error_code=HTTP_404`) | PASS |
| G2 | worker | identity-sync loop | system | Care re-pointed at an Identity internal API that implements the route; wait for the 10 s loop | job `succeeded`, profile `synced`, Identity user `pending` to `active` | job succeeded (9 attempts), profile `synced`, Identity status active | PASS |

Main run (`PHASE=all`):

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 1 | POST | /api/doctors/me/documents/uploads | none | no token | 401 Unauthorized | 401 Unauthorized | PASS |
| 2 | POST | /api/doctors/me/documents/uploads | none | tampered token | 401 Unauthorized | 401 Unauthorized | PASS |
| 3 | POST | /api/doctors/me/documents/uploads | patient | wrong role (patient) | 403 Forbidden | 403 Forbidden | PASS |
| 4 | POST | /api/doctors/me/documents/uploads | admin | wrong role (admin) | 403 Forbidden | 403 Forbidden | PASS |
| 5 | POST | /api/doctors/me/documents/uploads/1/complete | none | no token | 401 Unauthorized | 401 Unauthorized | PASS |
| 6 | POST | /api/doctors/me/documents/uploads/1/complete | none | tampered token | 401 Unauthorized | 401 Unauthorized | PASS |
| 7 | POST | /api/doctors/me/documents/uploads/1/complete | patient | wrong role (patient) | 403 Forbidden | 403 Forbidden | PASS |
| 8 | POST | /api/doctors/me/documents/uploads/1/complete | admin | wrong role (admin) | 403 Forbidden | 403 Forbidden | PASS |
| 9 | POST | /api/doctors/me/documents/1/download-url | none | no token | 401 Unauthorized | 401 Unauthorized | PASS |
| 10 | POST | /api/doctors/me/documents/1/download-url | none | tampered token | 401 Unauthorized | 401 Unauthorized | PASS |
| 11 | POST | /api/doctors/me/documents/1/download-url | patient | wrong role (patient) | 403 Forbidden | 403 Forbidden | PASS |
| 12 | POST | /api/doctors/me/documents/1/download-url | admin | wrong role (admin) | 403 Forbidden | 403 Forbidden | PASS |
| 13 | DELETE | /api/doctors/me/documents/1 | none | no token | 401 Unauthorized | 401 Unauthorized | PASS |
| 14 | DELETE | /api/doctors/me/documents/1 | none | tampered token | 401 Unauthorized | 401 Unauthorized | PASS |
| 15 | DELETE | /api/doctors/me/documents/1 | patient | wrong role (patient) | 403 Forbidden | 403 Forbidden | PASS |
| 16 | DELETE | /api/doctors/me/documents/1 | admin | wrong role (admin) | 403 Forbidden | 403 Forbidden | PASS |
| 17 | GET | /api/admin/applications | none | no token | 401 Unauthorized | 401 Unauthorized | PASS |
| 18 | GET | /api/admin/applications | patient | wrong role (patient) | 403 Forbidden | 403 Forbidden | PASS |
| 19 | GET | /api/admin/applications | doctor | wrong role (doctor) | 403 Forbidden | 403 Forbidden | PASS |
| 20 | GET | /api/admin/applications/1 | none | no token | 401 Unauthorized | 401 Unauthorized | PASS |
| 21 | GET | /api/admin/applications/1 | patient | wrong role (patient) | 403 Forbidden | 403 Forbidden | PASS |
| 22 | GET | /api/admin/applications/1 | doctor | wrong role (doctor) | 403 Forbidden | 403 Forbidden | PASS |
| 23 | POST | /api/admin/applications/1/documents/1/download-url | none | no token | 401 Unauthorized | 401 Unauthorized | PASS |
| 24 | POST | /api/admin/applications/1/documents/1/download-url | patient | wrong role (patient) | 403 Forbidden | 403 Forbidden | PASS |
| 25 | POST | /api/admin/applications/1/documents/1/download-url | doctor | wrong role (doctor) | 403 Forbidden | 403 Forbidden | PASS |
| 26 | PATCH | /api/admin/applications/1/approve | none | no token | 401 Unauthorized | 401 Unauthorized | PASS |
| 27 | PATCH | /api/admin/applications/1/approve | patient | wrong role (patient) | 403 Forbidden | 403 Forbidden | PASS |
| 28 | PATCH | /api/admin/applications/1/approve | doctor | wrong role (doctor) | 403 Forbidden | 403 Forbidden | PASS |
| 29 | PATCH | /api/admin/applications/1/reject | none | no token | 401 Unauthorized | 401 Unauthorized | PASS |
| 30 | PATCH | /api/admin/applications/1/reject | patient | wrong role (patient) | 403 Forbidden | 403 Forbidden | PASS |
| 31 | PATCH | /api/admin/applications/1/reject | doctor | wrong role (doctor) | 403 Forbidden | 403 Forbidden | PASS |
| 32 | PATCH | /api/admin/applications/1/reopen | none | no token | 401 Unauthorized | 401 Unauthorized | PASS |
| 33 | PATCH | /api/admin/applications/1/reopen | patient | wrong role (patient) | 403 Forbidden | 403 Forbidden | PASS |
| 34 | PATCH | /api/admin/applications/1/reopen | doctor | wrong role (doctor) | 403 Forbidden | 403 Forbidden | PASS |
| 35 | GET | /api/admin/applications | patient | spoofed X-Role/X-User-Id headers are ignored | 403 | 403 | PASS |
| 36 | POST | /api/doctors/me/documents/uploads | doctor | active doctor, no profile yet | 404 NotFound | 404 NotFound | PASS |
| 37 | POST | /api/doctors/apply | doctor | submit=true with no documents -> no profile created | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 38 | GET | doctor_profiles | doctor | failed submit leaves no profile row | 0 | 0 | PASS |
| 39 | GET | /api/doctors/me/application | doctor | application before profile | 404 NotFound | 404 NotFound | PASS |
| 40 | POST | /api/doctors/apply | doctor | create draft profile (pending token) | 201 | 201 | PASS |
| 41 | POST | /api/doctors/apply | doctor | create draft profile (active token) | 201 | 201 | PASS |
| 42 | GET | /api/doctors/me/application | doctor | own application view lists missingRequirements | 200 | 200 | PASS |
| 43 | GET | /api/doctors/me/application | doctor | missingRequirements = license_document,id_document | license_document,id_document | license_document,id_document | PASS |
| 44 | POST | /api/doctors/apply | doctor | submit=true with zero documents | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 45 | POST | /api/doctors/me/documents/uploads | doctor | intent: invalid type | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 46 | POST | /api/doctors/me/documents/uploads | doctor | intent: missing type | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 47 | POST | /api/doctors/me/documents/uploads | doctor | intent: unknown property rejected | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 48 | POST | /api/doctors/me/documents/uploads/abc/complete | doctor | complete: non-numeric upload id | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 49 | POST | /api/doctors/me/documents/uploads/0/complete | doctor | complete: zero upload id | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 50 | POST | /api/doctors/me/documents/uploads/999999999/complete | doctor | complete: unknown upload id | 404 NotFound | 404 NotFound | PASS |
| 51 | POST | /api/doctors/me/documents/abc/download-url | doctor | download-url: non-numeric document id | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 52 | POST | /api/doctors/me/documents/999999999/download-url | doctor | download-url: unknown document | 404 NotFound | 404 NotFound | PASS |
| 53 | DELETE | /api/doctors/me/documents/999999999 | doctor | delete: unknown document | 404 NotFound | 404 NotFound | PASS |
| 54 | POST | /api/doctors/me/documents/uploads | doctor | intent for valid PDF | 201 | 201 | PASS |
| 55 | POST | /api/doctors/me/documents/uploads/144/complete | doctor | complete: another doctor's intent | 404 NotFound | 404 NotFound | PASS |
| 56 | POST | /api/doctors/me/documents/uploads/144/complete | doctor | complete: nothing uploaded yet (object missing) | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 57 | GET | upload_intents | doctor | intent closed without a document after failed complete | 0 | 0 | PASS |
| 58 | POST | /api/doctors/me/documents/uploads/144/complete | doctor | complete again on closed intent | 409 Conflict | 409 Conflict | PASS |
| 59 | POST | /api/doctors/me/documents/uploads | doctor | intent for fake .pdf | 201 | 201 | PASS |
| 60 | POST | storage presigned POST | doctor | upload text file named license.pdf declared application/pdf | 204 | 204 | PASS |
| 61 | POST | /api/doctors/me/documents/uploads/145/complete | doctor | complete: wrong magic bytes despite .pdf name + application/pdf | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 62 | GET | verification_documents | doctor | no row created for the fake PDF | 0 | 0 | PASS |
| 63 | POST | /api/doctors/me/documents/uploads/145/complete | doctor | complete: replay on rejected intent | 409 Conflict | 409 Conflict | PASS |
| 64 | POST | /api/doctors/me/documents/uploads | doctor | intent for oversized file | 201 | 201 | PASS |
| 65 | POST | storage presigned POST | doctor | upload 11 MiB file is refused by the storage policy (content-length-range) | 400 | 400 | PASS |
| 66 | POST | /api/doctors/me/documents/uploads/146/complete | doctor | complete: oversized object never stored | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 67 | POST | /api/doctors/me/documents/uploads | doctor | intent for empty file | 201 | 201 | PASS |
| 68 | POST | storage presigned POST | doctor | upload 0-byte file is refused by the storage policy | 400 | 400 | PASS |
| 69 | POST | /api/doctors/me/documents/uploads | doctor | intent to be expired | 201 | 201 | PASS |
| 70 | POST | storage presigned POST | doctor | upload valid PDF for the to-be-expired intent | 204 | 204 | PASS |
| 71 | POST | /api/doctors/me/documents/uploads/148/complete | doctor | complete after expires_at | 410 UploadIntentExpired | 410 UploadIntentExpired | PASS |
| 72 | POST | /api/doctors/me/documents/uploads/148/complete | doctor | complete again after expiry | 409 Conflict | 409 Conflict | PASS |
| 73 | POST | /api/doctors/me/documents/uploads | doctor | A: create degree intent | 201 | 201 | PASS |
| 74 | POST | storage presigned POST | doctor | A: browser-style upload of degree.jpg | 204 | 204 | PASS |
| 75 | POST | /api/doctors/me/documents/uploads/149/complete | doctor | A: complete valid degree | 201 | 201 | PASS |
| 76 | GET | document fileType | doctor | JPEG detected from bytes | image/jpeg | image/jpeg | PASS |
| 77 | POST | /api/doctors/me/documents/uploads | doctor | A: create license intent | 201 | 201 | PASS |
| 78 | POST | storage presigned POST | doctor | A: browser-style upload of license.pdf | 204 | 204 | PASS |
| 79 | POST | /api/doctors/me/documents/uploads/150/complete | doctor | A: complete valid license | 201 | 201 | PASS |
| 80 | POST | /api/doctors/me/documents/uploads/150/complete | doctor | replay complete returns the same document | 200 | 200 | PASS |
| 81 | GET | document id | doctor | replay returns identical document id | 54 | 54 | PASS |
| 82 | GET | audit_logs | doctor | document_uploaded audited exactly once despite replay | 1 | 1 | PASS |
| 83 | POST | /api/doctors/me/documents/uploads | doctor | A: create id intent | 201 | 201 | PASS |
| 84 | POST | storage presigned POST | doctor | A: browser-style upload of id.png | 204 | 204 | PASS |
| 85 | POST | /api/doctors/me/documents/uploads/151/complete | doctor | A: complete valid id | 201 | 201 | PASS |
| 86 | POST | /api/doctors/me/documents/uploads/150/complete | doctor | replay complete with unknown body field | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 87 | POST | /api/doctors/me/documents/uploads | doctor | intent with Idempotency-Key (first) | 201 | 201 | PASS |
| 88 | POST | /api/doctors/me/documents/uploads | doctor | same key + same body replays original | 201 | 201 | PASS |
| 89 | POST | uploadId | doctor | replay returned the same uploadId | 152 | 152 | PASS |
| 90 | POST | /api/doctors/me/documents/uploads | doctor | same key + different body | 422 IdempotencyConflict | 422 IdempotencyConflict | PASS |
| 91 | POST | /api/doctors/me/documents/54/download-url | doctor | own document download URL | 200 | 200 | PASS |
| 92 | GET | presigned GET | doctor | presigned URL serves the document | 200 | 200 | PASS |
| 93 | GET | presigned GET | doctor | attachment disposition + sniffed content type | attachment + application/pdf | attachment + application/pdf | PASS |
| 94 | GET | presigned GET | doctor | downloaded bytes equal uploaded bytes | same | same | PASS |
| 95 | GET | object URL without signature | doctor | unsigned object URL is private | 403 | 403 | PASS |
| 96 | POST | /api/doctors/me/documents/54/download-url | doctor | second issue | 200 | 200 | PASS |
| 97 | GET | audit_logs | doctor | one audit row per issued URL (2 issues) | 2 | 2 | PASS |
| 98 | POST | /api/doctors/me/documents/54/download-url | doctor | foreign doctor's document -> 404 | 404 NotFound | 404 NotFound | PASS |
| 99 | DELETE | /api/doctors/me/documents/54 | doctor | foreign doctor deletes document -> 404 | 404 NotFound | 404 NotFound | PASS |
| 100 | GET | /api/doctors/me/application | doctor | application after uploads, no URL or key in DTO | 200 | 200 | PASS |
| 101 | GET | missingRequirements | doctor | all requirements satisfied | (none) | (none) | PASS |
| 102 | DELETE | /api/doctors/me/documents/53 | doctor | delete own optional degree (draft) | 204 | 204 | PASS |
| 103 | DELETE | /api/doctors/me/documents/53 | doctor | delete again -> 404 | 404 NotFound | 404 NotFound | PASS |
| 104 | GET | audit_logs | doctor | document_deleted audited | 1 | 1 | PASS |
| 105 | POST | /api/doctors/me/documents/53/download-url | doctor | download URL of deleted document | 404 NotFound | 404 NotFound | PASS |
| 106 | POST | /api/doctors/apply | doctor | submit with license + id | 200 | 200 | PASS |
| 107 | GET | doctor_profiles | doctor | state after draft submit (no Identity call) | submitted/not_required | submitted/not_required | PASS |
| 108 | GET | audit_logs | doctor | verification.submitted audited | 1 | 1 | PASS |
| 109 | POST | /api/doctors/apply | doctor | re-apply while submitted | 409 ApplicationNotEditable | 409 ApplicationNotEditable | PASS |
| 110 | POST | /api/doctors/me/documents/uploads | doctor | new intent while submitted | 409 ApplicationNotEditable | 409 ApplicationNotEditable | PASS |
| 111 | DELETE | /api/doctors/me/documents/54 | doctor | delete document while submitted | 409 ApplicationNotEditable | 409 ApplicationNotEditable | PASS |
| 112 | POST | /api/doctors/me/documents/54/download-url | doctor | download own document while submitted | 200 | 200 | PASS |
| 113 | POST | /api/doctors/apply | doctor | docB: create draft profile | 201 | 201 | PASS |
| 114 | POST | /api/doctors/me/documents/uploads | doctor | docB: create license intent | 201 | 201 | PASS |
| 115 | POST | storage presigned POST | doctor | docB: browser-style upload of license.pdf | 204 | 204 | PASS |
| 116 | POST | /api/doctors/me/documents/uploads/153/complete | doctor | docB: complete valid license | 201 | 201 | PASS |
| 117 | POST | /api/doctors/me/documents/uploads | doctor | docB: create id intent | 201 | 201 | PASS |
| 118 | POST | storage presigned POST | doctor | docB: browser-style upload of id.png | 204 | 204 | PASS |
| 119 | POST | /api/doctors/me/documents/uploads/154/complete | doctor | docB: complete valid id | 201 | 201 | PASS |
| 120 | POST | /api/doctors/apply | doctor | docB: submit with license + id | 200 | 200 | PASS |
| 121 | POST | /api/doctors/apply | doctor | docC: create draft profile | 201 | 201 | PASS |
| 122 | POST | /api/doctors/me/documents/uploads | doctor | docC: create license intent | 201 | 201 | PASS |
| 123 | POST | storage presigned POST | doctor | docC: browser-style upload of license.pdf | 204 | 204 | PASS |
| 124 | POST | /api/doctors/me/documents/uploads/155/complete | doctor | docC: complete valid license | 201 | 201 | PASS |
| 125 | POST | /api/doctors/me/documents/uploads | doctor | docC: create id intent | 201 | 201 | PASS |
| 126 | POST | storage presigned POST | doctor | docC: browser-style upload of id.png | 204 | 204 | PASS |
| 127 | POST | /api/doctors/me/documents/uploads/156/complete | doctor | docC: complete valid id | 201 | 201 | PASS |
| 128 | POST | /api/doctors/apply | doctor | docC: submit with license + id | 200 | 200 | PASS |
| 129 | POST | /api/doctors/apply | doctor | docD: create draft profile | 201 | 201 | PASS |
| 130 | POST | /api/doctors/me/documents/uploads | doctor | docD: create license intent | 201 | 201 | PASS |
| 131 | POST | storage presigned POST | doctor | docD: browser-style upload of license.pdf | 204 | 204 | PASS |
| 132 | POST | /api/doctors/me/documents/uploads/157/complete | doctor | docD: complete valid license | 201 | 201 | PASS |
| 133 | POST | /api/doctors/me/documents/uploads | doctor | docD: create id intent | 201 | 201 | PASS |
| 134 | POST | storage presigned POST | doctor | docD: browser-style upload of id.png | 204 | 204 | PASS |
| 135 | POST | /api/doctors/me/documents/uploads/158/complete | doctor | docD: complete valid id | 201 | 201 | PASS |
| 136 | POST | /api/doctors/apply | doctor | docD: submit with license + id | 200 | 200 | PASS |
| 137 | POST | /api/doctors/apply | doctor | docF: create draft profile | 201 | 201 | PASS |
| 138 | POST | /api/doctors/me/documents/uploads | doctor | docF: create license intent | 201 | 201 | PASS |
| 139 | POST | storage presigned POST | doctor | docF: browser-style upload of license.pdf | 204 | 204 | PASS |
| 140 | POST | /api/doctors/me/documents/uploads/159/complete | doctor | docF: complete valid license | 201 | 201 | PASS |
| 141 | POST | /api/doctors/me/documents/uploads | doctor | docF: create id intent | 201 | 201 | PASS |
| 142 | POST | storage presigned POST | doctor | docF: browser-style upload of id.png | 204 | 204 | PASS |
| 143 | POST | /api/doctors/me/documents/uploads/160/complete | doctor | docF: complete valid id | 201 | 201 | PASS |
| 144 | POST | /api/doctors/apply | doctor | docF: submit with license + id | 200 | 200 | PASS |
| 145 | GET | /api/admin/applications | admin | default queue (status=submitted) | 200 | 200 | PASS |
| 146 | GET | queue contents | admin | queue contains submitted applications only | (none) | (none) | PASS |
| 147 | GET | /api/admin/applications?status=submitted&limit=2 | admin | page 1 (limit=2) | 200 | 200 | PASS |
| 148 | GET | meta | admin | page 1 reports hasMore + cursor | true + yes | true + yes | PASS |
| 149 | GET | /api/admin/applications?status=submitted&limit=2&cursor=<cursor> | admin | page 2 via cursor | 200 | 200 | PASS |
| 150 | GET | pagination | admin | pages are disjoint | disjoint | disjoint | PASS |
| 151 | GET | /api/admin/applications?status=submitted&limit=2&cursor=<cursor> | admin | tampered cursor | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 152 | GET | /api/admin/applications?status=approved&limit=2&cursor=<cursor> | admin | cursor reused with another status | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 153 | GET | /api/admin/applications?status=bogus | admin | invalid status filter | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 154 | GET | /api/admin/applications?limit=0 | admin | limit=0 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 155 | GET | /api/admin/applications?limit=101 | admin | limit=101 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 156 | GET | /api/admin/applications?limit=abc | admin | limit not a number | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 157 | GET | /api/admin/applications?bogus=1 | admin | unknown query key | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 158 | GET | /api/admin/applications?status=draft&limit=5 | admin | status=draft filter | 200 | 200 | PASS |
| 159 | GET | /api/admin/applications/36 | admin | detail | 200 | 200 | PASS |
| 160 | GET | documents | admin | detail lists license + id metadata only | id,license | id,license | PASS |
| 161 | GET | audit_logs | admin | documents_viewed audited | 1 | 1 | PASS |
| 162 | GET | /api/admin/applications/abc | admin | detail: non-numeric id | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 163 | GET | /api/admin/applications/0 | admin | detail: id=0 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 164 | GET | /api/admin/applications/999999999 | admin | detail: unknown id | 404 NotFound | 404 NotFound | PASS |
| 165 | POST | /api/admin/applications/36/documents/54/download-url | admin | admin download URL | 200 | 200 | PASS |
| 166 | GET | presigned GET | admin | admin URL serves the document | 200 | 200 | PASS |
| 167 | POST | /api/admin/applications/36/documents/54/download-url | admin | second issue | 200 | 200 | PASS |
| 168 | GET | audit_logs | admin | one audit row per issue (3 doctor + 2 admin = 5) | 5 | 5 | PASS |
| 169 | POST | /api/admin/applications/38/documents/54/download-url | admin | document belongs to another application | 404 NotFound | 404 NotFound | PASS |
| 170 | POST | /api/admin/applications/36/documents/999999999/download-url | admin | unknown document | 404 NotFound | 404 NotFound | PASS |
| 171 | POST | /api/admin/applications/36/documents/53/download-url | admin | soft-deleted document | 404 NotFound | 404 NotFound | PASS |
| 172 | PATCH | /api/admin/applications/999999999/approve | admin | approve unknown id | 404 NotFound | 404 NotFound | PASS |
| 173 | PATCH | /api/admin/applications/abc/approve | admin | approve non-numeric id | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 174 | PATCH | /api/admin/applications/36/approve | admin | approve: unknown body field | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 175 | PATCH | /api/admin/applications/36/approve | admin | approve: note > 2000 chars | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 176 | PATCH | /api/admin/applications/36/reject | admin | reject: reason missing | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 177 | PATCH | /api/admin/applications/36/reject | admin | reject: reason too short | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 178 | PATCH | /api/admin/applications/36/reject | admin | reject: control character in reason | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 179 | PATCH | /api/admin/applications/36/reject | admin | reject: no body | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 180 | PATCH | /api/admin/applications/36/reopen | admin | reopen a submitted application | 409 ApplicationNotReviewable | 409 ApplicationNotReviewable | PASS |
| 181 | PATCH | /api/admin/applications/999999999/reject | admin | reject unknown id | 404 NotFound | 404 NotFound | PASS |
| 182 | PATCH | /api/admin/applications/36/approve | admin | approve with Idempotency-Key, Identity healthy | 200 | 200 | PASS |
| 183 | GET | doctor_profiles | admin | approved + synced | approved/synced | approved/synced | PASS |
| 184 | GET | identity users.status | admin | Identity account is active | active | active | PASS |
| 185 | PATCH | /api/admin/applications/36/approve | admin | replay same key + body returns original 200 | 200 | 200 | PASS |
| 186 | PATCH | /api/admin/applications/36/approve | admin | same key, different body | 422 IdempotencyConflict | 422 IdempotencyConflict | PASS |
| 187 | PATCH | /api/admin/applications/36/approve | admin | approve again without key (already approved) | 409 ApplicationNotReviewable | 409 ApplicationNotReviewable | PASS |
| 188 | PATCH | /api/admin/applications/36/reject | admin | reject an approved application | 409 ApplicationNotReviewable | 409 ApplicationNotReviewable | PASS |
| 189 | PATCH | /api/admin/applications/36/reopen | admin | reopen an approved application | 409 ApplicationNotReviewable | 409 ApplicationNotReviewable | PASS |
| 190 | GET | audit_logs | admin | verification.approved + identity_sync.synced audited once each | 1 + 1 | 1 + 1 | PASS |
| 191 | GET | identity_sync_jobs | admin | job succeeded | succeeded | succeeded | PASS |
| 192 | POST | /api/doctors/apply | doctor | doctor re-submits an approved application | 409 Conflict | 409 Conflict | PASS |
| 193 | POST | /api/doctors/me/documents/uploads | doctor | intent after approval | 409 ApplicationNotEditable | 409 ApplicationNotEditable | PASS |
| 194 | DELETE | /api/doctors/me/documents/54 | doctor | delete document after approval | 409 ApplicationNotEditable | 409 ApplicationNotEditable | PASS |
| 195 | GET | /api/doctors/me/application | doctor | own view after approval | 200 | 200 | PASS |
| 196 | GET | status | doctor | own view shows approved/synced | approved/synced | approved/synced | PASS |
| 197 | GET | /api/admin/applications?status=approved&limit=100 | admin | queue status=approved | 200 | 200 | PASS |
| 198 | GET | /api/admin/applications/36 | admin | detail hydrates the doctor block (Case 2) | 200 | 200 | PASS |
| 199 | GET | doctor block | admin | profileHydrated true with displayName | true + yes | true + yes | PASS |
| 200 | PATCH | /api/admin/applications/{id}/approve | admin | two concurrent approvals: exactly one succeeds (200/202), one 409 | 200 409  | 200 409  | PASS |
| 201 | PATCH | /api/admin/applications/40/reject | admin | reject, Identity healthy | 200 | 200 | PASS |
| 202 | GET | doctor_profiles | admin | rejected/synced | rejected/synced | rejected/synced | PASS |
| 203 | GET | identity users.status | admin | Identity account is rejected | rejected | rejected | PASS |
| 204 | GET | /api/doctors/me/application | doctor | rejected doctor reads the decision (pending-status token) | 200 | 200 | PASS |
| 205 | GET | reviewNote | doctor | decision note visible to the doctor | <reason sentinel> | <reason sentinel> | PASS |
| 206 | GET | /api/admin/applications/40 | admin | admin detail after reject | 200 | 200 | PASS |
| 207 | GET | /api/doctors/me/application | doctor | fresh rejected-status token can read the application | 200 | 200 | PASS |
| 208 | PATCH | /api/admin/applications/40/reject | admin | reject an already rejected application | 409 ApplicationNotReviewable | 409 ApplicationNotReviewable | PASS |
| 209 | PATCH | /api/admin/applications/40/approve | admin | approve a rejected application | 409 ApplicationNotReviewable | 409 ApplicationNotReviewable | PASS |
| 210 | POST | /api/doctors/me/documents/uploads | doctor | D(rejected): create degree intent | 201 | 201 | PASS |
| 211 | POST | storage presigned POST | doctor | D(rejected): browser-style upload of degree.pdf | 204 | 204 | PASS |
| 212 | POST | /api/doctors/me/documents/uploads/161/complete | doctor | D(rejected): complete valid degree | 201 | 201 | PASS |
| 213 | DELETE | /api/doctors/me/documents/64 | doctor | rejected doctor deletes a document | 204 | 204 | PASS |
| 214 | POST | /api/doctors/apply | doctor | doctor resubmits (rejected -> submitted, Identity -> pending) | 200/202 | 200 | PASS |
| 215 | GET | doctor_profiles | doctor | resubmitted: submitted + Identity pending synced | submitted/synced | submitted/synced | PASS |
| 216 | GET | identity users.status | doctor | Identity account back to pending | pending | pending | PASS |
| 217 | PATCH | /api/admin/applications/40/reject | admin | reject again | 200 | 200 | PASS |
| 218 | PATCH | /api/admin/applications/40/reopen | admin | admin reopens the rejected application | 200/202 | 200 | PASS |
| 219 | GET | doctor_profiles | admin | reopened: submitted/synced, decision cleared | submitted/synced +  | submitted/synced +  | PASS |
| 220 | GET | identity users.status | admin | Identity account pending after reopen | pending | pending | PASS |
| 221 | GET | audit_logs | admin | reopened audited | 1 | 1 | PASS |
| 222 | PATCH | /api/admin/applications/40/approve | admin | approve the reopened application | 200 | 200 | PASS |
| 223 | GET | /api/doctors/me/application | doctor | doctor sees approved after the full cycle | 200 | 200 | PASS |
| 224 | PATCH | /api/admin/applications/39/reject | admin | reject while Identity says active -> 409 from Identity | 202 | 202 | PASS |
| 225 | GET | identitySync | admin | 202 body says failed | failed | failed | PASS |
| 226 | GET | doctor_profiles | admin | profile marked failed, decision kept | rejected/failed | rejected/failed | PASS |
| 227 | GET | identity_sync_jobs | admin | job failed, not retried | failed | failed | PASS |
| 228 | GET | audit_logs | admin | identity_sync.failed audited | 1 | 1 | PASS |
| 229 | POST | /api/doctors/apply | doctor | docH: create draft profile (never hydrated before the outage) | 201 | 201 | PASS |
| 230 | GET | /api/admin/applications/42 | admin | Case 2 with Identity down: cold cache, detail still 200 (degraded) | 200 | 200 | PASS |
| 231 | GET | doctor block | admin | cache miss + outage: profileHydrated=false, displayName null | false +  | false +  | PASS |
| 232 | GET | /api/admin/applications/41 | admin | Case 2 with Identity down: warm cache entry is served | 200 | 200 | PASS |
| 233 | GET | doctor block | admin | cache hit + outage: profileHydrated=true | true | true | PASS |
| 234 | GET | /api/admin/applications?status=submitted&limit=100 | admin | Case 2 with Identity down: queue still 200 | 200 | 200 | PASS |
| 235 | PATCH | /api/admin/applications/41/approve | admin | approve while Identity is down -> 202 pending | 202 | 202 | PASS |
| 236 | PATCH | latency | admin | inline attempts finish in < 15 s | yes | yes | PASS |
| 237 | GET | identitySync | admin | 202 body says pending | pending | pending | PASS |
| 238 | GET | doctor_profiles | admin | decision kept, sync pending | approved/pending | approved/pending | PASS |
| 239 | GET | audit_logs | admin | identity_sync.pending audited once | 1 | 1 | PASS |
| 240 | PATCH | /api/admin/applications/41/approve | admin | second approve while pending sync | 409 ApplicationNotReviewable | 409 ApplicationNotReviewable | PASS |
| 241 | GET | /api/doctors/me/application | doctor | doctor sees approved + pending | 200 | 200 | PASS |
| 242 | GET | status | doctor | own view approved/pending | approved/pending | approved/pending | PASS |
| 243 | GET | identity_sync_jobs | admin | job still pending with attempts > 0 | pending + yes | pending + yes | PASS |
| 244 | GET | doctor_profiles | admin | care-worker converged the pending sync after Identity returned | approved/synced | approved/synced | PASS |
| 245 | GET | identity users.status | admin | Identity account is active | active | active | PASS |
| 246 | GET | audit_logs | admin | identity_sync.synced audited once | 1 | 1 | PASS |
| 247 | GET | identity_sync_jobs | admin | job succeeded | succeeded | succeeded | PASS |
| 248 | POST | /api/doctors/me/documents/uploads | doctor | malformed Idempotency-Key | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 249 | POST | /api/doctors/me/documents/uploads | doctor | E: create license intent | 201 | 201 | PASS |
| 250 | POST | storage presigned POST | doctor | E: browser-style upload of license.pdf | 204 | 204 | PASS |
| 251 | POST | /api/doctors/me/documents/uploads/162/complete | doctor | E: complete valid license | 201 | 201 | PASS |
| 252 | POST | /api/doctors/me/documents/uploads | doctor | E: create id intent | 201 | 201 | PASS |
| 253 | POST | storage presigned POST | doctor | E: browser-style upload of id.png | 204 | 204 | PASS |
| 254 | POST | /api/doctors/me/documents/uploads/163/complete | doctor | E: complete valid id | 201 | 201 | PASS |
| 255 | POST | /api/doctors/me/documents/uploads | doctor | E: open intent with stored PDF, completed after suspension | 201 | 201 | PASS |
| 256 | POST | storage presigned POST | doctor | E: upload PDF for the open intent | 204 | 204 | PASS |
| 257 | POST | /api/doctors/me/documents/uploads | doctor | locally suspended doctor: new intent (token still valid) | 403 Forbidden | 403 Forbidden | PASS |
| 258 | POST | /api/doctors/me/documents/uploads/164/complete | doctor | locally suspended doctor: complete a pending intent | 403 Forbidden | 403 Forbidden | PASS |
| 259 | DELETE | /api/doctors/me/documents/65 | doctor | locally suspended doctor: delete document | 403 Forbidden | 403 Forbidden | PASS |
| 260 | POST | /api/doctors/apply | doctor | locally suspended doctor: submit=true | 403 Forbidden | 403 Forbidden | PASS |
| 261 | POST | /api/doctors/apply | doctor | locally suspended doctor: submit=false draft save (doctors spec: apply route has no doctor_not_suspended) | 200 | 200 | PASS |
| 262 | POST | /api/doctors/me/documents/uploads | doctor | intent left open then expired (purge loop) | 201 | 201 | PASS |
| 263 | POST | storage presigned POST | doctor | upload valid PDF to be purged | 204 | 204 | PASS |
| 264 | GET | upload_intents | doctor | worker upload-intent-purge closed the expired open intent | yes | yes | PASS |
| 265 | POST | /api/doctors/me/documents/uploads/165/complete | doctor | complete on a purged intent | 409 Conflict | 409 Conflict | PASS |
| 266 | POST | /api/doctors/me/documents/uploads | doctor | 20 intents within the hour all succeed | 201 | 201 | PASS |
| 267 | POST | /api/doctors/me/documents/uploads | doctor | 21st intent in the hour | 429 RateLimited | 429 RateLimited | PASS |
| 268 | GET | Retry-After | doctor | 429 carries Retry-After | yes | yes | PASS |
| 269 | GET | /api/admin/applications | admin | non-UUID X-Request-Id replaced by a generated UUID | yes | yes | PASS |
| 270 | GET | /api/admin/applications | admin | missing X-Request-Id: one is generated | yes | yes | PASS |
| 271 | GET | presigned GET | doctor | URL is dead after 60 s | 403 | 403 | PASS |
| 272 | GET | audit_logs | admin | no reviewer prose in audit metadata | 0 | 0 | PASS |
| 273 | GET | identity_sync_jobs | admin | reason kept only on the job row (needed for retry) | yes | yes | PASS |
| 274 | GET | care logs | admin | no tokens, keys, signed URLs or reviewer prose in Care logs | 0 | 0 | PASS |

## Failures / notes

No spec or contract case failed. Findings from the logs and code while running:

- **Worker retries hydrate the doctor profile for nothing (low).** `src/app/verification/service/verification.service.ts` `syncJob` always ends by building the view (`this.view(...)`, lines about 203-206), which calls `identity.getUsersBatch`. The worker (`processDueSyncJob`, line 166) discards the result, so every 10 s retry tick makes an extra `GET /internal/users` and, while Identity is failing, logs `identity_hydration_degraded` (warn plus metric) from `care-worker`. Repro: approve while the Identity internal API is down, then watch `care-worker` output, which shows one `identity_hydration_degraded` per tick. Effect: wasted Identity calls and a misleading Case-2 degradation metric. Fix idea: build the view only when `actor !== null` (the inline path).
- **Environment gap, not a Care bug.** The real Identity on `feature/internal` serves only `/internal/auth/*` and health, so Case 1 cannot reach `synced` against it. G1: Care kept the decision, answered 202 pending and kept retrying on 404. G2: it converged as soon as a compliant API answered. The Identity internal-users module must land before end-to-end QA works without a shim.
- **Spec tension to resolve.** CLAUDE.md says a locally suspended doctor is blocked on every doctor action, but the doctors spec gives `POST /doctors/apply` no `doctor_not_suspended` check, so a suspended doctor can still save a draft (`submit=false` returns 200, the "draft save" case in the table). Submit, intent, complete and delete are all `403 Forbidden` as the verification spec requires. Decide whether apply should also fail closed.
- **Design observation.** The queue cursor MAC key is `SERVICE_CLIENT_SECRET` (`encodeCursor` / `decodeCursor`); rotating Care's Identity client secret silently invalidates every outstanding cursor (they then answer `400 ValidationFailed`).
- Oversized (11 MiB) and empty uploads are refused by MinIO's POST policy (HTTP 400) before Care sees them; the later `complete` answers `400 ValidationFailed` because no object exists. Care's own HEAD size check is only reachable if the policy is bypassed and was not exercised.

## Not run

- Browser CORS preflight for the presigned POST (CURL is server to server).
- In-flight `Idempotency-Key` (`409 Conflict` + `Retry-After: 1`) and Redis-down behaviour (idempotency, rate limit, hydration cache).
- Rate limits other than 20 intents per hour per doctor (admin 120/min, doctor writes 20/min, reads 120/min).
- Storage outage during `complete`, audit-insert failure before download-url (fail closed), orphan reconciliation, concurrent `complete` calls and pool exhaustion: unit and integration territory.
- Identity `404` or malformed-response variants other than the real-Identity 404 probe.
- Alert delivery for `IdentityApprovalSyncPending` and `IdentitySyncTransitionRejected`: only the state change (job and profile `failed`, `identity_sync.failed` audit) was verified.

## Re-run

```bash
docker compose up -d minio minio-setup          # MSYS_NO_PATHCONV=1 in Git Bash
npm run migrate && npm run migrate:ensure-app-login
# start Identity (public 3000, internal 3100) plus a contract-compliant internal users API,
# then care-api and care-worker with IDENTITY_INTERNAL_URL, SERVICE_CLIENT_*, STORAGE_* set
IDENTITY_DATABASE_URL=... CARE_OWNER_DATABASE_URL=... \
IDENTITY_STOP_CMD=... IDENTITY_START_CMD=... CARE_WORKER_PURGE_CMD=... CARE_LOG_FILES="..." \
  scripts/curl-test-verification.sh        # PHASE=gap runs only the real-Identity probe
```
