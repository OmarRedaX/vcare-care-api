---
title: records — Manual QA (CURL)
owner: care-team
service: care-service
module: records
status: passed
diataxis: how-to
last_verified: 2026-10-18
tags: [manual-qa, records, medical-records, amendments, lock-trigger, timeline, follow-up, has-record, audit, rbac, no-store, rate-limit, clinical-privacy]
related: [records-spec, records-tasks, records-brainstorm, sessions-manual-qa, consultations-manual-qa, clinical-records, rbac]
---

# records — Manual QA (CURL)

_Run: 2026-10-18 • Server: http://127.0.0.1:3001 (real Care API, `src/server.ts`), fake Identity http://127.0.0.1:3023 • Result: 328 pass / 0 fail_

Every endpoint of the module is driven with CURL against the running server: `POST /api/consultations/{id}/record`, `GET /api/records/{id}`, `PATCH /api/records/{id}`, `GET /api/patients/{patientUserId}/records`, plus `Consultation.hasRecord` (get-one, list, doctor calendar) and `POST /api/consultations` with `followUpOfRecordId`. Rows with method `check` are database / Redis / fake-Identity / server-log assertions made with the owner login. Expected values come from `contracts/openapi.yaml` and `docs/records/spec.md`, not from "200". All data is synthetic (patients 501-503 and 507, doctors 601-606, admins 1 and 2); clinical text is only short `QA-REC-*` marker strings, which this file never repeats, and no token, cookie or secret is recorded.

## Environment
- Docker was unavailable (the daemon is not running), so the stack ran natively. Isolated PostgreSQL 18 cluster on `127.0.0.1:5499` (trust auth), throwaway database `care_qa_records_test`, migrated with the repo CLI as the owner role (`src/migrate.ts latest`, 29 migrations including the three records migrations) and then `ensure-app-login`, so the API connected as `care_app` (member of `vcare_app`), never as the owner. The shared dev cluster on `:5432` was not touched. Redis `localhost:6379` db index 12 only (flushed before every call by the script; no other index touched).
- `node scripts/consultations-qa-fake-identity.mjs` (port 3023): JWKS, token minting (patients 5xx, doctors 6xx, admins, pending / suspended variants, expired, `typ=service`) and `GET /internal/users?ids=` with a call log. The records routes make no Identity call (asserted below); the fake serves token verification and the booking fixtures.
- `npx tsx src/server.ts` with `NODE_ENV=development`, `PORT=3001`, `INTERNAL_PORT=3101`, `VIDEO_PROVIDER=fake`, dummy `STORAGE_*` values (no storage call in this module), `LOG_LEVEL=info` (the log is scanned by the script). No `care-worker` ran: records queue no notification.
- Run: `CARE_OWNER_DATABASE_URL=postgres://<owner>@127.0.0.1:5499/care_qa_records_test CARE_APP_DATABASE_URL=postgres://<care_app login>@127.0.0.1:5499/care_qa_records_test REDIS_URL=redis://127.0.0.1:6379/12 SERVER_LOG=<care-api log> QA_REPORT=<file> bash scripts/curl-test-records.sh` (about 7 minutes; it refuses a database that does not end in `_test` or contain `_qa`). `CARE_APP_DATABASE_URL` is optional (enables the direct grant / trigger rows); `QA_KEEP=1` skips the end-of-run fixture reset; `QA_DEBUG_FILE` keeps the first 400 bytes of the body of a failed case.
- Windows (git-bash) host, Node 24.

## How the lock was reached
The lock is decided by database time (`locked_at <= NOW()`), so the script moves the clock of the row instead of waiting 24 hours: while a record is still open it runs one owner statement that sets `created_at`, `updated_at` and `locked_at` together to `now() - 24 h + N s` (`chk_medical_records_lock` keeps holding). `N = +5` or `+8` leaves a record open for a PATCH issued a moment later (still an in-place update); `N = -2` / `-3` makes it locked (an amendment). The statement must run while the row is open: once locked, the `BEFORE UPDATE` trigger refuses every update, the owner's included (asserted below). Boundary probes use a margin of 2 to 8 seconds; the exact instant (`locked_at = NOW()`, `+ 1 µs`) is covered by the integration tests with a frozen transaction clock.

## Coverage summary
Authentication (none / malformed / expired / `typ=service`) on all four routes; role denials that fire before any lookup (admin on every route with an existing, unknown and non-numeric id, patient on create and PATCH, pending doctor and pending patient, suspended admin); create validation (empty, blank, 2 vs 3 code points, 2000 / 2001, NUL, non-string, JSON null, per-field blank and over-length, nine bad `diagnosisCode` values, `followUpInDays` 0 / -1 / 366 / 1.5 / "7" / null, unknown members `patientUserId` / `doctorUserId` / `consultationId` / `lockedAt` / `attachments`, array and string bodies, malformed JSON, no body) with no row and no audit written; the creation gate (every non-completed status, `NotAssignedDoctor` before the status, unrelated and cancelled / no-show-only doctors 404, unknown and six malformed ids 404, other patient 403, second create 409 even with an `Idempotency-Key`, three simultaneous creates give one 201 and two 409); happy creates (minimal, full, upper and lower bounds, right after the real `complete` route) and the `record.created` audit row; get-one for the patient, the author and a related doctor, and the 404 / 403 matrix; query members on get-one rejected; PATCH validation (reason-only and `{}` bodies, null members, unknown members, every field's bounds, reason 2 / 1001 / NUL / null), the pre-lock no-op (byte-identical row, `updated_at` unchanged, no audit), in-place changes with `changedFields` audit, pre-lock `reason` ignored, the lock boundary on both sides, amendments (reason required, original row byte-identical, equal value still appends, multi-field, oldest first on read, `reasonLength` audit without the text), the PATCH RBAC matrix on open and locked records, direct database refusals for `care_app` and the owner; the timeline (default sort, keyset paging with limit 2 walking every record once, `limit` 0 / 1 / 100 / 101 / abc / 1.5 / -1, malformed / empty / oversized cursor, unknown query member, patient repeated on every page, `patient: null` without a profile, tie on equal `created_at` broken by id across a page boundary, empty timeline still audited, `me` / non-numeric / zero / negative ids 404, booked-only relationship allowed, cancelled / no-show-only 404); a locally suspended doctor (403 on create and PATCH, 404 on both reads, the patient and other consulted doctors still read the records); `hasRecord` on get-one (patient, doctor, admin), list and calendar; follow-up booking (own record 201 and stored, replay, conflicting replay 422, another patient's / another doctor's / unknown / soft-deleted record 404, 0 / string / null 400, no consultation row created by any rejection, the FK rejects a dangling id); no `Idempotency-Key` effect and no clinical text or idempotency key in Redis; rate limits (write bucket 20/min shared by create and PATCH, read 120/min, timeline 60/min, independent buckets, `Retry-After` and `no-store` on the 429); audit metadata allowlist, no clinical text in audit rows, and a server-log scan for the clinical markers, `Bearer ` and JWT prefixes.

Every response row also asserts: `success`, the full error envelope (`code`, `message`, `details[]`, `requestId` equal to the sent id), the echoed `X-Request-Id` header, `Cache-Control: no-store`, and (on errors) that no clinical marker appears in the body. Over all the runs against this server instance (including the draft runs), the log held 1651 completed requests, no `error` level line and no 5xx.

## Cases
| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 1 | POST | /api/consultations/97/record | none | create none | 401 Unauthorized | 401 Unauthorized | PASS |
| 2 | GET | /api/records/1 | none | get none | 401 Unauthorized | 401 Unauthorized | PASS |
| 3 | PATCH | /api/records/1 | none | patch none | 401 Unauthorized | 401 Unauthorized | PASS |
| 4 | GET | /api/patients/501/records | none | timeline none | 401 Unauthorized | 401 Unauthorized | PASS |
| 5 | POST | /api/consultations/97/record | malformed | create malformed | 401 Unauthorized | 401 Unauthorized | PASS |
| 6 | GET | /api/records/1 | malformed | get malformed | 401 Unauthorized | 401 Unauthorized | PASS |
| 7 | PATCH | /api/records/1 | malformed | patch malformed | 401 Unauthorized | 401 Unauthorized | PASS |
| 8 | GET | /api/patients/501/records | malformed | timeline malformed | 401 Unauthorized | 401 Unauthorized | PASS |
| 9 | POST | /api/consultations/97/record | expired | create expired | 401 TokenExpired | 401 TokenExpired | PASS |
| 10 | GET | /api/records/1 | expired | get expired | 401 TokenExpired | 401 TokenExpired | PASS |
| 11 | PATCH | /api/records/1 | expired | patch expired | 401 TokenExpired | 401 TokenExpired | PASS |
| 12 | GET | /api/patients/501/records | expired | timeline expired | 401 TokenExpired | 401 TokenExpired | PASS |
| 13 | POST | /api/consultations/97/record | service-token | create service-token | 401 Unauthorized | 401 Unauthorized | PASS |
| 14 | GET | /api/records/1 | service-token | get service-token | 401 Unauthorized | 401 Unauthorized | PASS |
| 15 | PATCH | /api/records/1 | service-token | patch service-token | 401 Unauthorized | 401 Unauthorized | PASS |
| 16 | GET | /api/patients/501/records | service-token | timeline service-token | 401 Unauthorized | 401 Unauthorized | PASS |
| 17 | check | auth | owner | unauthenticated calls created nothing | 0 0 | 0 0 | PASS |
| 18 | POST | /api/consultations/97/record | admin | create denied for admin (existing consultation) | 403 Forbidden | 403 Forbidden | PASS |
| 19 | POST | /api/consultations/99999999/record | admin | create denied for admin (unknown consultation: role beats lookup) | 403 Forbidden | 403 Forbidden | PASS |
| 20 | POST | /api/consultations/abc/record | admin | create denied for admin (non-numeric id) | 403 Forbidden | 403 Forbidden | PASS |
| 21 | GET | /api/records/99999999 | admin | get denied for admin (unknown id) | 403 Forbidden | 403 Forbidden | PASS |
| 22 | PATCH | /api/records/99999999 | admin | patch denied for admin (unknown id) | 403 Forbidden | 403 Forbidden | PASS |
| 23 | GET | /api/patients/501/records | admin | timeline denied for admin | 403 Forbidden | 403 Forbidden | PASS |
| 24 | GET | /api/patients/abc/records | admin | timeline denied for admin (non-numeric id) | 403 Forbidden | 403 Forbidden | PASS |
| 25 | POST | /api/consultations/97/record | admin2 | create denied for admin2 (existing consultation) | 403 Forbidden | 403 Forbidden | PASS |
| 26 | POST | /api/consultations/99999999/record | admin2 | create denied for admin2 (unknown consultation: role beats lookup) | 403 Forbidden | 403 Forbidden | PASS |
| 27 | POST | /api/consultations/abc/record | admin2 | create denied for admin2 (non-numeric id) | 403 Forbidden | 403 Forbidden | PASS |
| 28 | GET | /api/records/99999999 | admin2 | get denied for admin2 (unknown id) | 403 Forbidden | 403 Forbidden | PASS |
| 29 | PATCH | /api/records/99999999 | admin2 | patch denied for admin2 (unknown id) | 403 Forbidden | 403 Forbidden | PASS |
| 30 | GET | /api/patients/501/records | admin2 | timeline denied for admin2 | 403 Forbidden | 403 Forbidden | PASS |
| 31 | GET | /api/patients/abc/records | admin2 | timeline denied for admin2 (non-numeric id) | 403 Forbidden | 403 Forbidden | PASS |
| 32 | POST | /api/consultations/97/record | patient | create denied for the consultation patient | 403 Forbidden | 403 Forbidden | PASS |
| 33 | PATCH | /api/records/99999999 | patient | patch denied for a patient | 403 Forbidden | 403 Forbidden | PASS |
| 34 | POST | /api/consultations/97/record | patient-pending | create, patient token status pending | 403 Forbidden | 403 Forbidden | PASS |
| 35 | POST | /api/consultations/97/record | doctor-pending | create, doctor token status pending | 403 Forbidden | 403 Forbidden | PASS |
| 36 | PATCH | /api/records/99999999 | doctor-pending | patch, doctor token status pending | 403 Forbidden | 403 Forbidden | PASS |
| 37 | GET | /api/records/99999999 | doctor-pending | get, doctor token status pending | 403 Forbidden | 403 Forbidden | PASS |
| 38 | GET | /api/records/99999999 | patient-pending | get, patient token status pending | 403 Forbidden | 403 Forbidden | PASS |
| 39 | GET | /api/patients/501/records | patient-pending | timeline, patient token status pending | 403 Forbidden | 403 Forbidden | PASS |
| 40 | GET | /api/patients/501/records | doctor-pending | timeline, doctor token status pending | 403 Forbidden | 403 Forbidden | PASS |
| 41 | GET | /api/records/99999999 | admin-suspended | get, admin token status suspended | 403 Forbidden | 403 Forbidden | PASS |
| 42 | POST | /api/consultations/97/record | doctor-spoof | spoofed X-User-Id / X-Role are ignored (related doctor stays NotAssignedDoctor) | 403 NotAssignedDoctor | 403 NotAssignedDoctor | PASS |
| 43 | check | rbac | owner | denied calls created nothing and audited nothing | 0 0 | 0 0 | PASS |
| 44 | POST | /api/consultations/98/record | doctor | create validation: empty-object | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 45 | POST | /api/consultations/98/record | doctor | create validation: chiefComplaint-missing | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 46 | POST | /api/consultations/98/record | doctor | create validation: chiefComplaint-blank | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 47 | POST | /api/consultations/98/record | doctor | create validation: chiefComplaint-2-code-points | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 48 | POST | /api/consultations/98/record | doctor | create validation: chiefComplaint-2001 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 49 | POST | /api/consultations/98/record | doctor | create validation: chiefComplaint-NUL | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 50 | POST | /api/consultations/98/record | doctor | create validation: chiefComplaint-number | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 51 | POST | /api/consultations/98/record | doctor | create validation: chiefComplaint-null | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 52 | POST | /api/consultations/98/record | doctor | create validation: examinationNotes-blank | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 53 | POST | /api/consultations/98/record | doctor | create validation: examinationNotes-empty | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 54 | POST | /api/consultations/98/record | doctor | create validation: examinationNotes-10001 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 55 | POST | /api/consultations/98/record | doctor | create validation: examinationNotes-NUL | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 56 | POST | /api/consultations/98/record | doctor | create validation: examinationNotes-null | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 57 | POST | /api/consultations/98/record | doctor | create validation: diagnosisText-blank | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 58 | POST | /api/consultations/98/record | doctor | create validation: diagnosisText-2001 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 59 | POST | /api/consultations/98/record | doctor | create validation: treatmentPlan-blank | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 60 | POST | /api/consultations/98/record | doctor | create validation: treatmentPlan-10001 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 61 | POST | /api/consultations/98/record | doctor | create validation: diagnosisCode-[a00] | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 62 | POST | /api/consultations/98/record | doctor | create validation: diagnosisCode-[A0] | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 63 | POST | /api/consultations/98/record | doctor | create validation: diagnosisCode-[A00.12345] | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 64 | POST | /api/consultations/98/record | doctor | create validation: diagnosisCode-[A00.] | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 65 | POST | /api/consultations/98/record | doctor | create validation: diagnosisCode-[A00 ] | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 66 | POST | /api/consultations/98/record | doctor | create validation: diagnosisCode-[AA0] | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 67 | POST | /api/consultations/98/record | doctor | create validation: diagnosisCode-[A000] | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 68 | POST | /api/consultations/98/record | doctor | create validation: diagnosisCode-[] | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 69 | POST | /api/consultations/98/record | doctor | create validation: diagnosisCode-[Z99.9X9ZZ] | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 70 | POST | /api/consultations/98/record | doctor | create validation: diagnosisCode-number | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 71 | POST | /api/consultations/98/record | doctor | create validation: diagnosisCode-null | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 72 | POST | /api/consultations/98/record | doctor | create validation: followUpInDays-0 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 73 | POST | /api/consultations/98/record | doctor | create validation: followUpInDays--1 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 74 | POST | /api/consultations/98/record | doctor | create validation: followUpInDays-366 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 75 | POST | /api/consultations/98/record | doctor | create validation: followUpInDays-1.5 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 76 | POST | /api/consultations/98/record | doctor | create validation: followUpInDays-"7" | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 77 | POST | /api/consultations/98/record | doctor | create validation: followUpInDays-null | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 78 | POST | /api/consultations/98/record | doctor | create validation: unknown-member-patientUserId | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 79 | POST | /api/consultations/98/record | doctor | create validation: unknown-member-doctorUserId | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 80 | POST | /api/consultations/98/record | doctor | create validation: unknown-member-consultationId | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 81 | POST | /api/consultations/98/record | doctor | create validation: unknown-member-locked_at | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 82 | POST | /api/consultations/98/record | doctor | create validation: unknown-member-attachments | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 83 | POST | /api/consultations/98/record | doctor | create validation: array-body | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 84 | POST | /api/consultations/98/record | doctor | create validation: malformed-json | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 85 | POST | /api/consultations/98/record | doctor | create validation: non-object-json-string | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 86 | POST | /api/consultations/98/record | doctor | create validation: no body at all | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 87 | POST | /api/consultations/98/record | doctor | create validation: body sent with Idempotency-Key still validated | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 88 | check | validation | owner | validation failures created no record and no audit row | 0 0 | 0 0 | PASS |
| 89 | POST | /api/consultations/abc/record | doctor | non-numeric consultation id with an invalid body: 404 beats 400 | 404 NotFound | 404 NotFound | PASS |
| 90 | POST | /api/consultations/99/record | doctor | create on a booked consultation | 409 RecordRequiresCompleted | 409 RecordRequiresCompleted | PASS |
| 91 | POST | /api/consultations/100/record | doctor | create on a waiting consultation | 409 RecordRequiresCompleted | 409 RecordRequiresCompleted | PASS |
| 92 | POST | /api/consultations/101/record | doctor | create on a in_progress consultation | 409 RecordRequiresCompleted | 409 RecordRequiresCompleted | PASS |
| 93 | POST | /api/consultations/102/record | doctor | create on a cancelled consultation | 409 RecordRequiresCompleted | 409 RecordRequiresCompleted | PASS |
| 94 | POST | /api/consultations/103/record | doctor | create on a no_show consultation | 409 RecordRequiresCompleted | 409 RecordRequiresCompleted | PASS |
| 95 | check | gate | owner | RecordRequiresCompleted created nothing | 0 0 | 0 0 | PASS |
| 96 | POST | /api/consultations/104/record | doctor | related non-assigned doctor on a booked consultation: NotAssignedDoctor beats the status | 403 NotAssignedDoctor | 403 NotAssignedDoctor | PASS |
| 97 | POST | /api/consultations/98/record | doctor-related | related non-assigned doctor on a completed consultation | 403 NotAssignedDoctor | 403 NotAssignedDoctor | PASS |
| 98 | POST | /api/consultations/98/record | doctor-unrelated | unrelated doctor (no consultation with the patient) | 404 NotFound | 404 NotFound | PASS |
| 99 | POST | /api/consultations/98/record | doctor-cancelled-only | doctor whose only rows with the patient are cancelled / no_show | 404 NotFound | 404 NotFound | PASS |
| 100 | POST | /api/consultations/99999999/record | doctor | unknown consultation | 404 NotFound | 404 NotFound | PASS |
| 101 | POST | /api/consultations/abc/record | doctor | create with bad consultation id [abc] | 404 NotFound | 404 NotFound | PASS |
| 102 | POST | /api/consultations/0/record | doctor | create with bad consultation id [0] | 404 NotFound | 404 NotFound | PASS |
| 103 | POST | /api/consultations/-1/record | doctor | create with bad consultation id [-1] | 404 NotFound | 404 NotFound | PASS |
| 104 | POST | /api/consultations/1.5/record | doctor | create with bad consultation id [1.5] | 404 NotFound | 404 NotFound | PASS |
| 105 | POST | /api/consultations/99999999999999999999/record | doctor | create with bad consultation id [99999999999999999999] | 404 NotFound | 404 NotFound | PASS |
| 106 | POST | /api/consultations/%20/record | doctor | create with bad consultation id [%20] | 404 NotFound | 404 NotFound | PASS |
| 107 | POST | /api/consultations/98/record | patient-other | other patient | 403 Forbidden | 403 Forbidden | PASS |
| 108 | check | gate | owner | failed gates created nothing | 0 0 | 0 0 | PASS |
| 109 | POST | /api/consultations/105/record | doctor | create with the required member only: optional members are null | 201 | 201 | PASS |
| 110 | POST | /api/consultations/97/record | doctor | create with every member (author = assigned doctor) | 201 | 201 | PASS |
| 111 | check | db | owner | one live row per create; locked_at = created_at + 24 h exactly; ids copied from the consultation | 2 true 501 601 | 2 true 501 601 | PASS |
| 112 | check | audit | owner | one record.created row (actor doctor, entity medical_record, request id, flat metadata) | 1 | 1 | PASS |
| 113 | check | audit | owner | record.created metadata carries field names only, never a value | 0 | 0 | PASS |
| 114 | POST | /api/consultations/97/record | doctor | second create on the same consultation | 409 Conflict | 409 Conflict | PASS |
| 115 | POST | /api/consultations/97/record | doctor | second create replayed with an Idempotency-Key is still 409 (no replay) | 409 Conflict | 409 Conflict | PASS |
| 116 | check | db | owner | repeat creates left one row per consultation and one audit row | 2 1 | 2 1 | PASS |
| 117 | POST | /api/consultations/106/record | doctor | create at the upper bounds (2000 / 10000 / 2000 chars, code Z99.9AB2, 365 days) | 201 | 201 | PASS |
| 118 | POST | /api/consultations/107/record | doctor | create at the lower bounds (3 code points, 1 char, code Z99, 1 day, newline + unicode kept) | 201 | 201 | PASS |
| 119 | PATCH | /api/consultations/108/complete | doctor | setup: complete an in_progress consultation through the real route | 200 | 200 | PASS |
| 120 | POST | /api/consultations/108/record | doctor | create right after the real complete | 201 | 201 | PASS |
| 121 | check | concurrency | owner | three simultaneous creates for one consultation: exactly one 201 and two 409 | 201 409 409  | 201 409 409  | PASS |
| 122 | check | concurrency | owner | the losers answer Conflict; one record row and one record.created row for the consultation | Conflict 1 1 | Conflict 1 1 | PASS |
| 123 | POST | /api/consultations/110/record | doctor-603 | create by a not-yet-suspended doctor | 201 | 201 | PASS |
| 124 | GET | /api/records/41 | patient | get by the owning patient | 200 | 200 | PASS |
| 125 | check | audit | owner | record.read audited before the response (actor patient, request id, flat metadata, viewerIsAuthor false) | 1 | 1 | PASS |
| 126 | GET | /api/records/41 | doctor | get by the author doctor | 200 | 200 | PASS |
| 127 | check | audit | owner | author read audited with viewerIsAuthor true | 1 | 1 | PASS |
| 128 | GET | /api/records/41 | doctor-related | get by a doctor with a booked relationship to the patient | 200 | 200 | PASS |
| 129 | GET | /api/records/41 | patient-other | get by another patient | 404 NotFound | 404 NotFound | PASS |
| 130 | GET | /api/records/41 | doctor-unrelated | get by an unrelated doctor | 404 NotFound | 404 NotFound | PASS |
| 131 | GET | /api/records/41 | doctor-cancelled-only | get by a doctor whose rows with the patient are cancelled / no_show only | 404 NotFound | 404 NotFound | PASS |
| 132 | GET | /api/records/41 | admin | get by an admin (existing id) | 403 Forbidden | 403 Forbidden | PASS |
| 133 | GET | /api/records/99999999 | patient | get unknown id | 404 NotFound | 404 NotFound | PASS |
| 134 | GET | /api/records/99999999 | doctor | get unknown id (doctor) | 404 NotFound | 404 NotFound | PASS |
| 135 | GET | /api/records/abc | patient | get with bad id [abc] | 404 NotFound | 404 NotFound | PASS |
| 136 | PATCH | /api/records/abc | doctor | patch with bad id [abc] | 404 NotFound | 404 NotFound | PASS |
| 137 | GET | /api/records/0 | patient | get with bad id [0] | 404 NotFound | 404 NotFound | PASS |
| 138 | PATCH | /api/records/0 | doctor | patch with bad id [0] | 404 NotFound | 404 NotFound | PASS |
| 139 | GET | /api/records/-1 | patient | get with bad id [-1] | 404 NotFound | 404 NotFound | PASS |
| 140 | PATCH | /api/records/-1 | doctor | patch with bad id [-1] | 404 NotFound | 404 NotFound | PASS |
| 141 | GET | /api/records/1.5 | patient | get with bad id [1.5] | 404 NotFound | 404 NotFound | PASS |
| 142 | PATCH | /api/records/1.5 | doctor | patch with bad id [1.5] | 404 NotFound | 404 NotFound | PASS |
| 143 | GET | /api/records/99999999999999999999 | patient | get with bad id [99999999999999999999] | 404 NotFound | 404 NotFound | PASS |
| 144 | PATCH | /api/records/99999999999999999999 | doctor | patch with bad id [99999999999999999999] | 404 NotFound | 404 NotFound | PASS |
| 145 | GET | /api/records/41?foo=bar | patient | get with an unknown query member | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 146 | GET | /api/records/41?limit=5 | doctor | get with a pagination query member | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 147 | GET | /api/records/41 | patient | get ignores an Idempotency-Key | 200 | 200 | PASS |
| 148 | GET | /api/records/41 | patient-other | spoofed X-User-Id / X-Role do not widen access | 404 NotFound | 404 NotFound | PASS |
| 149 | check | audit | owner | rejected reads (404 / 403 / 400) wrote no record.read row: only the 4 successful reads are audited | 4 | 4 | PASS |
| 150 | check | audit | owner | records created so far: no patient_profile.read or listed row from get-one | 0 | 0 | PASS |
| 151 | PATCH | /api/records/41 | doctor | patch validation: reason-only | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 152 | PATCH | /api/records/41 | doctor | patch validation: empty-object | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 153 | PATCH | /api/records/41 | doctor | patch validation: diagnosisText-null | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 154 | PATCH | /api/records/41 | doctor | patch validation: chiefComplaint-null | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 155 | PATCH | /api/records/41 | doctor | patch validation: unknown-member-patientUserId | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 156 | PATCH | /api/records/41 | doctor | patch validation: unknown-member-doctorUserId | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 157 | PATCH | /api/records/41 | doctor | patch validation: unknown-member-lockedAt | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 158 | PATCH | /api/records/41 | doctor | patch validation: unknown-member-isLocked | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 159 | PATCH | /api/records/41 | doctor | patch validation: chiefComplaint-2-code-points | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 160 | PATCH | /api/records/41 | doctor | patch validation: chiefComplaint-blank | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 161 | PATCH | /api/records/41 | doctor | patch validation: chiefComplaint-NUL | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 162 | PATCH | /api/records/41 | doctor | patch validation: treatmentPlan-blank | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 163 | PATCH | /api/records/41 | doctor | patch validation: examinationNotes-10001 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 164 | PATCH | /api/records/41 | doctor | patch validation: diagnosisCode-lowercase | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 165 | PATCH | /api/records/41 | doctor | patch validation: diagnosisCode-A00.12345 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 166 | PATCH | /api/records/41 | doctor | patch validation: followUpInDays-0 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 167 | PATCH | /api/records/41 | doctor | patch validation: followUpInDays-366 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 168 | PATCH | /api/records/41 | doctor | patch validation: followUpInDays-float | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 169 | PATCH | /api/records/41 | doctor | patch validation: followUpInDays-string | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 170 | PATCH | /api/records/41 | doctor | patch validation: reason-2-chars | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 171 | PATCH | /api/records/41 | doctor | patch validation: reason-blank | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 172 | PATCH | /api/records/41 | doctor | patch validation: reason-1001 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 173 | PATCH | /api/records/41 | doctor | patch validation: reason-NUL | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 174 | PATCH | /api/records/41 | doctor | patch validation: reason-null | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 175 | PATCH | /api/records/41 | doctor | patch validation: malformed-json | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 176 | PATCH | /api/records/41 | doctor | patch validation: no body | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 177 | check | patch | owner | validation failures changed nothing and audited nothing | 03966e244c935d38d7e0b038ed8fb020 0 | 03966e244c935d38d7e0b038ed8fb020 0 | PASS |
| 178 | PATCH | /api/records/41 | doctor | pre-lock no-op: values equal to the stored ones | 200 | 200 | PASS |
| 179 | PATCH | /api/records/41 | doctor | pre-lock no-op with a reason (ignored) | 200 | 200 | PASS |
| 180 | check | patch | owner | no-op wrote nothing: row byte-identical, updated_at unchanged, zero record.updated rows | 03966e244c935d38d7e0b038ed8fb020 2026-10-18 04:19:45.786303+03 0 | 03966e244c935d38d7e0b038ed8fb020 2026-10-18 04:19:45.786303+03 0 | PASS |
| 181 | PATCH | /api/records/41 | doctor | pre-lock change of one field updates in place | 200 | 200 | PASS |
| 182 | check | audit | owner | one record.updated row (actor doctor, request id, changedFields names only) | 1 | 1 | PASS |
| 183 | check | db | owner | in-place update kept created_at / locked_at and wrote no amendment | true 0 | true 0 | PASS |
| 184 | PATCH | /api/records/41 | doctor | pre-lock mixed body: one equal field, one changed field, reason ignored | 200 | 200 | PASS |
| 185 | check | audit | owner | mixed patch audited only the changed field name; the reason is nowhere in audit metadata | diagnosisCode 0 | diagnosisCode 0 | PASS |
| 186 | PATCH | /api/records/41 | doctor | pre-lock multi-field change | 200 | 200 | PASS |
| 187 | check | audit | owner | multi-field change audited as comma-joined names | chiefComplaint,examinationNotes,followUpInDays | chiefComplaint,examinationNotes,followUpInDays | PASS |
| 188 | PATCH | /api/records/41 | doctor | patch ignores an Idempotency-Key (same key, different body: no 422) | 200 | 200 | PASS |
| 189 | PATCH | /api/records/41 | doctor | patch with the same Idempotency-Key and another body is processed again | 200 | 200 | PASS |
| 190 | PATCH | /api/records/41 | doctor-related | patch by a related non-author doctor | 403 NotAssignedDoctor | 403 NotAssignedDoctor | PASS |
| 191 | PATCH | /api/records/41 | doctor-unrelated | patch by an unrelated doctor | 404 NotFound | 404 NotFound | PASS |
| 192 | PATCH | /api/records/41 | doctor-cancelled-only | patch by a doctor with cancelled / no_show rows only | 404 NotFound | 404 NotFound | PASS |
| 193 | PATCH | /api/records/41 | patient | patch by the owning patient | 403 Forbidden | 403 Forbidden | PASS |
| 194 | PATCH | /api/records/41 | admin | patch by an admin | 403 Forbidden | 403 Forbidden | PASS |
| 195 | PATCH | /api/records/99999999 | doctor | patch on an unknown record | 404 NotFound | 404 NotFound | PASS |
| 196 | PATCH | /api/records/41 | doctor | patch of the author after the checks: row still the last accepted value | 200 | 200 | PASS |
| 197 | PATCH | /api/records/40 | doctor | about 8 s before the lock: still an in-place update | 200 | 200 | PASS |
| 198 | check | db | owner | before the lock: no amendment row, audit says updated | 0 1 | 0 1 | PASS |
| 199 | PATCH | /api/records/40 | doctor | about 2 s after the lock without a reason | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 200 | PATCH | /api/records/40 | doctor | after the lock: reason-only body | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 201 | PATCH | /api/records/40 | doctor | after the lock: JSON null member (cannot clear a field) | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 202 | PATCH | /api/records/40 | doctor | after the lock: reason shorter than 3 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 203 | check | amend | owner | rejected amendments changed nothing | 775be6046ce2a3ee34792209fc737aaf 0 0 | 775be6046ce2a3ee34792209fc737aaf 0 0 | PASS |
| 204 | PATCH | /api/records/40 | doctor | after the lock with a reason: an amendment is appended | 201 | 201 | PASS |
| 205 | check | amend | owner | the original row is byte-identical after the amendment; one amendment row | 775be6046ce2a3ee34792209fc737aaf 1 | 775be6046ce2a3ee34792209fc737aaf 1 | PASS |
| 206 | check | audit | owner | one record.amended row (amendmentId, reasonLength, changedFields; never the reason text) | 1 | 1 | PASS |
| 207 | PATCH | /api/records/40 | doctor | after the lock a value equal to the original still appends (no diff) | 201 | 201 | PASS |
| 208 | PATCH | /api/records/40 | doctor | after the lock a multi-field amendment | 201 | 201 | PASS |
| 209 | GET | /api/records/40 | patient | get after amendments: original untouched, amendments oldest first, patient sees the reason | 200 | 200 | PASS |
| 210 | check | audit | owner | record.read for the amended record reports amendmentCount 3 | 3 | 3 | PASS |
| 211 | GET | /api/records/40 | doctor-related | a related doctor also sees the amendments | 200 | 200 | PASS |
| 212 | PATCH | /api/records/40 | doctor-related | locked record: related non-author doctor | 403 NotAssignedDoctor | 403 NotAssignedDoctor | PASS |
| 213 | PATCH | /api/records/40 | patient | locked record: patient | 403 Forbidden | 403 Forbidden | PASS |
| 214 | PATCH | /api/records/40 | admin | locked record: admin | 403 Forbidden | 403 Forbidden | PASS |
| 215 | PATCH | /api/records/40 | doctor-unrelated | locked record: unrelated doctor | 404 NotFound | 404 NotFound | PASS |
| 216 | check | amend | owner | those denials appended nothing | 3 3 | 3 3 | PASS |
| 217 | PATCH | /api/records/41 | doctor | full record, about 5 s before the lock: in place | 200 | 200 | PASS |
| 218 | PATCH | /api/records/41 | doctor | full record, about 3 s after the lock: amendment | 201 | 201 | PASS |
| 219 | check | db | owner | care_app UPDATE of a locked record is refused by the trigger | 1 | 1 | PASS |
| 220 | check | db | owner | care_app soft delete of a locked record is refused by the trigger | 1 | 1 | PASS |
| 221 | check | db | owner | the owner is refused too (the trigger fires for every role) | 1 | 1 | PASS |
| 222 | check | db | owner | care_app has no DELETE on medical_records | 1 | 1 | PASS |
| 223 | check | db | owner | care_app has no UPDATE on amendments | 1 | 1 | PASS |
| 224 | check | db | owner | care_app has no DELETE on amendments | 1 | 1 | PASS |
| 225 | check | db | owner | care_app cannot set an amendment id / created_at | 1 | 1 | PASS |
| 226 | check | db | owner | an empty amendment is refused by chk_medical_record_amendments_nonempty | 1 | 1 | PASS |
| 227 | check | db | owner | a record whose locked_at is not created_at + 24 h is refused by chk_medical_records_lock | 1 | 1 | PASS |
| 228 | check | db | owner | the RecordLocked (trigger-only) 409 path is not reachable over HTTP: no PATCH answered 409 | 0 | 0 | PASS |
| 229 | POST | /api/consultations/112/record | doctor | timeline fixture record 1 | 201 | 201 | PASS |
| 230 | POST | /api/consultations/113/record | doctor | timeline fixture record 2 | 201 | 201 | PASS |
| 231 | GET | /api/patients/501/records | patient | timeline by the patient themself: newest first, patient profile, meta | 200 | 200 | PASS |
| 232 | check | audit | owner | exactly one patient_records.listed row (entity patient_records / patient id, request id, flat metadata, no record ids) | 1 | 1 | PASS |
| 233 | check | audit | owner | no patient_profile.read row from the timeline | 0 | 0 | PASS |
| 234 | check | case2 | owner | the timeline made no Identity call (ids only, no hydration) | 0 0 | 0 0 | PASS |
| 235 | check | timeline | owner | keyset paging (limit 2) walks every record once in (created_at, id) descending order | 49,48,46,44,41,40 | 49,48,46,44,41,40 | PASS |
| 236 | check | timeline | owner | page count for limit 2 | 3 | 3 | PASS |
| 237 | GET | /api/patients/501/records?limit=2 | patient | page 1: hasMore true, nextCursor set, count 2, patient present | 200 | 200 | PASS |
| 238 | GET | /api/patients/501/records?limit=2&cursor=WyIyMDI2LTEwLTE4VDAxOjIwOjUxLjYxODgyNFoiLDQ4XQ | patient | page 2: patient repeated identically, continuation records only | 200 | 200 | PASS |
| 239 | GET | /api/patients/501/records?limit=1 | patient | limit 1 | 200 | 200 | PASS |
| 240 | GET | /api/patients/501/records?limit=100 | patient | limit 100 | 200 | 200 | PASS |
| 241 | GET | /api/patients/501/records?limit=0 | patient | limit 0 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 242 | GET | /api/patients/501/records?limit=101 | patient | limit 101 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 243 | GET | /api/patients/501/records?limit=abc | patient | limit not a number | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 244 | GET | /api/patients/501/records?limit=1.5 | patient | limit fractional | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 245 | GET | /api/patients/501/records?limit=-1 | patient | limit negative | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 246 | GET | /api/patients/501/records?cursor=not-a-cursor | patient | malformed cursor | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 247 | GET | /api/patients/501/records?cursor= | patient | empty cursor | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 248 | GET | /api/patients/501/records?cursor=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA | patient | cursor longer than 1024 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 249 | GET | /api/patients/501/records?foo=bar | patient | unknown query member | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 250 | GET | /api/patients/501/records | doctor | timeline by the author doctor | 200 | 200 | PASS |
| 251 | GET | /api/patients/501/records | doctor-related | timeline by a doctor with a booked-only relationship sees all doctors records | 200 | 200 | PASS |
| 252 | GET | /api/patients/501/records | doctor-unrelated | timeline by an unrelated doctor | 404 NotFound | 404 NotFound | PASS |
| 253 | GET | /api/patients/501/records | doctor-cancelled-only | timeline by a doctor with cancelled / no_show rows only | 404 NotFound | 404 NotFound | PASS |
| 254 | GET | /api/patients/501/records | patient-other | timeline of another patient | 404 NotFound | 404 NotFound | PASS |
| 255 | GET | /api/patients/me/records | patient | timeline path /patients/me/records | 404 NotFound | 404 NotFound | PASS |
| 256 | GET | /api/patients/abc/records | patient | timeline with a non-numeric patient id | 404 NotFound | 404 NotFound | PASS |
| 257 | GET | /api/patients/0/records | doctor | timeline of patient id 0 | 404 NotFound | 404 NotFound | PASS |
| 258 | GET | /api/patients/-5/records | doctor | timeline of a negative id | 404 NotFound | 404 NotFound | PASS |
| 259 | GET | /api/patients/501/records | admin | timeline by an admin | 403 Forbidden | 403 Forbidden | PASS |
| 260 | GET | /api/patients/503/records | patient | patient without a profile row: patient is null, records present, tie broken by id descending | 200 | 200 | PASS |
| 261 | GET | /api/patients/503/records?limit=1 | doctor | tie across a page boundary: page 1 holds the higher id | 200 | 200 | PASS |
| 262 | GET | /api/patients/503/records?limit=1&cursor=WyIyMDI2LTEwLTE3VDIzOjIxOjEwLjY3OTY3M1oiLDUxXQ | doctor | tie across a page boundary: page 2 holds the lower id, last page | 200 | 200 | PASS |
| 263 | GET | /api/patients/502/records | patient-other | timeline of a patient without a profile row, records from the fixtures | 200 | 200 | PASS |
| 264 | GET | /api/patients/507/records | patient-507 | an empty timeline: 200, patient null, records [], still audited | 200 | 200 | PASS |
| 265 | check | audit | owner | the empty page wrote one patient_records.listed row with recordCount 0 | 1 | 1 | PASS |
| 266 | POST | /api/consultations/111/record | doctor-suspended | create by a locally suspended doctor | 403 Forbidden | 403 Forbidden | PASS |
| 267 | PATCH | /api/records/46 | doctor-suspended | patch of own record by a locally suspended doctor | 403 Forbidden | 403 Forbidden | PASS |
| 268 | GET | /api/records/46 | doctor-suspended | get of an authored record by a locally suspended doctor | 404 NotFound | 404 NotFound | PASS |
| 269 | GET | /api/records/41 | doctor-suspended | get of another doctors record by a locally suspended doctor | 404 NotFound | 404 NotFound | PASS |
| 270 | GET | /api/patients/501/records | doctor-suspended | timeline by a locally suspended doctor | 404 NotFound | 404 NotFound | PASS |
| 271 | GET | /api/records/46 | patient | the patient still reads the suspended doctors record | 200 | 200 | PASS |
| 272 | GET | /api/records/46 | doctor-related | a consulted doctor still reads the suspended doctors record | 200 | 200 | PASS |
| 273 | GET | /api/records/46 | doctor | the assigned doctor of the patient reads it too | 200 | 200 | PASS |
| 274 | check | suspended | owner | suspended-doctor calls created nothing | 0 | 0 | PASS |
| 275 | GET | /api/consultations/97 | patient | get-one: hasRecord true after create | 200 | 200 | PASS |
| 276 | GET | /api/consultations/104 | patient | get-one: hasRecord false for a booked consultation | 200 | 200 | PASS |
| 277 | GET | /api/consultations/98 | doctor | get-one: hasRecord false for a completed consultation without a record | 200 | 200 | PASS |
| 278 | GET | /api/consultations/97 | admin | get-one by an admin: hasRecord true, no clinical field | 200 | 200 | PASS |
| 279 | GET | /api/consultations?limit=100&scope=all | patient | list (scope=all): hasRecord true exactly for the consultations with a record | 200 | 200 | PASS |
| 280 | GET | /api/consultations?limit=100&scope=past&status=completed | doctor | doctor list (scope=past, completed): hasRecord matches the record table | 200 | 200 | PASS |
| 281 | GET | /api/consultations/calendar?from=2026-10-15T01:21:23Z&to=2026-10-18T01:21:23Z | doctor | doctor calendar: hasRecord true on a recorded completed row, false on an unrecorded one | 200 | 200 | PASS |
| 282 | POST | /api/consultations | patient | book with followUpOfRecordId = own record with the same doctor | 201 | 201 | PASS |
| 283 | check | db | owner | the link is stored on the consultation row | 41 | 41 | PASS |
| 284 | POST | /api/consultations | patient | replay with the same key and body returns the stored consultation | 201 | 201 | PASS |
| 285 | POST | /api/consultations | patient | same key with a different followUpOfRecordId | 422 IdempotencyConflict | 422 IdempotencyConflict | PASS |
| 286 | POST | /api/consultations | patient | book without followUpOfRecordId stays null | 201 | 201 | PASS |
| 287 | POST | /api/consultations | patient | book with another patients record | 404 NotFound | 404 NotFound | PASS |
| 288 | POST | /api/consultations | patient | book with a record of another doctor (record is doctor 601, booking doctor 602) | 404 NotFound | 404 NotFound | PASS |
| 289 | POST | /api/consultations | patient | book with an unknown record id | 404 NotFound | 404 NotFound | PASS |
| 290 | POST | /api/consultations | patient | book with followUpOfRecordId 0 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 291 | POST | /api/consultations | patient | book with followUpOfRecordId as a string | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 292 | POST | /api/consultations | patient | book with followUpOfRecordId null | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 293 | check | db | owner | rejected follow-up bookings created no consultation row | 24 | 24 | PASS |
| 294 | POST | /api/consultations | patient | book with a record of another patient of the same doctor (503 vs 501 record) | 404 NotFound | 404 NotFound | PASS |
| 295 | check | db | owner | the foreign key rejects a dangling follow-up id at the database level | 1 | 1 | PASS |
| 296 | POST | /api/consultations | patient-502 | book with a soft-deleted record (owner SQL, pre-lock) of this patient and doctor | 404 NotFound | 404 NotFound | PASS |
| 297 | GET | /api/records/43 | patient-502 | get of the soft-deleted record | 404 NotFound | 404 NotFound | PASS |
| 298 | POST | /api/consultations/118/record | doctor | create carrying an Idempotency-Key behaves as without one | 201 | 201 | PASS |
| 299 | PATCH | /api/records/52 | doctor | patch carrying an Idempotency-Key | 200 | 200 | PASS |
| 300 | GET | /api/records/52 | patient-other | get after the writes | 200 | 200 | PASS |
| 301 | GET | /api/patients/502/records | patient-other | timeline after the writes | 200 | 200 | PASS |
| 302 | check | redis | owner | no clinical marker in any Redis key or value, no idempotency key stored, Redis had keys to scan | 0 0 keys | 0 0 keys | PASS |
| 303 | check | ratelimit | owner | write bucket: 20 no-op PATCH calls in a minute all succeed | 200 x20; | 200 x20; | PASS |
| 304 | POST | /api/consultations/119/record | doctor | write bucket shared: the 21st write (a create) is limited | 429 RateLimited | 429 RateLimited | PASS |
| 305 | check | ratelimit | owner | the 429 carries Retry-After and no-store | 1 1 | 1 1 | PASS |
| 306 | check | ratelimit | owner | the limited create wrote nothing | 0 | 0 | PASS |
| 307 | PATCH | /api/records/52 | doctor | the 22nd write is limited too | 429 RateLimited | 429 RateLimited | PASS |
| 308 | GET | /api/records/52 | doctor | read bucket is independent: the same doctor can still read | 200 | 200 | PASS |
| 309 | PATCH | /api/records/40 | doctor-other | write bucket is per user: another doctor is not limited (gets its own error) | 403 NotAssignedDoctor | 403 NotAssignedDoctor | PASS |
| 310 | check | ratelimit | owner | read bucket: 120 GET /records/{id} calls in a minute all succeed | 200 x120; | 200 x120; | PASS |
| 311 | GET | /api/records/52 | patient-other | the 121st read is limited | 429 RateLimited | 429 RateLimited | PASS |
| 312 | GET | /api/patients/502/records | patient-other | timeline bucket is separate from the read bucket | 200 | 200 | PASS |
| 313 | check | ratelimit | owner | timeline bucket: 60 calls in a minute all succeed | 200 x60; | 200 x60; | PASS |
| 314 | GET | /api/patients/502/records | patient-other | the 61st timeline call is limited | 429 RateLimited | 429 RateLimited | PASS |
| 315 | check | audit | owner | every record audit row has only flat scalar metadata keys from the allowlist | 0 | 0 | PASS |
| 316 | check | audit | owner | no audit row holds a clinical marker, a diagnosis code or the amendment reason | 0 | 0 | PASS |
| 317 | check | audit | owner | record audit rows are all attributed to a doctor or a patient, never to an admin | 0 | 0 | PASS |
| 318 | check | audit | owner | record.created count equals the number of records created through the API | 10 | 10 | PASS |
| 319 | check | log | owner | captured log is non-trivial | 1 | 1 | PASS |
| 320 | check | log | owner | no '<synthetic marker>' in the server log | 0 | 0 | PASS |
| 321 | check | log | owner | no '<synthetic marker>' in the server log | 0 | 0 | PASS |
| 322 | check | log | owner | no '<synthetic marker>' in the server log | 0 | 0 | PASS |
| 323 | check | log | owner | no '<synthetic marker>' in the server log | 0 | 0 | PASS |
| 324 | check | log | owner | no '<synthetic marker>' in the server log | 0 | 0 | PASS |
| 325 | check | log | owner | no '<synthetic marker>' in the server log | 0 | 0 | PASS |
| 326 | check | log | owner | no 'Bearer ' in the server log | 0 | 0 | PASS |
| 327 | check | log | owner | no 'Z99.9' in the server log | 0 | 0 | PASS |
| 328 | check | log | owner | no '<jwt prefix>' in the server log | 0 | 0 | PASS |

## Failures / notes
- No product failure: every case matches the spec and the contract.
- **`409 RecordLocked` is not reachable over HTTP.** The service and the trigger read the same transaction `NOW()`, so a PATCH that passes the service lock check cannot hit the trigger (spec 3.6 step 6: it needs a row altered outside the service). No PATCH answered 409 in this run. The trigger itself is proven at the database level (the `care_app` and the owner UPDATE of a locked record, and a soft delete of one, are refused with the `is locked` error); the 409 mapping is covered by the integration tests.
- Not exercised by CURL: a failing audit insert failing a read or rolling back a write (needs fault injection; integration tests cover it), a PATCH racing a follow-up booking for deadlocks, the millisecond-exact lock boundary (see above), the `EXPLAIN` plans and timing budgets (`records-explain` integration suite), and the `record-attachments` surface (out of scope: `attachments` is always `[]`, asserted on every record response together with the absence of any URL, object key or deleted marker).
- Observation (contract-consistent, not a failure): `GET /api/consultations` defaults to `scope=upcoming`, so completed rows (the only ones that can have a record) appear in the list only with `scope=past` or `scope=all`; the script uses those.
- Script / harness issues fixed while writing this run (not product failures): helper counters lost inside command substitutions (now file-backed) caused overlapping fixture rows; a diagnosis code written as `Z99.9X9Z` is in fact valid (four characters after the dot), so the negative case uses `Z99.9X9ZZ`; a non-ASCII character in a body must be sent as a JSON `é` escape because a literal byte is re-encoded by the Windows curl; `psql` prints booleans as `true`, not `t`; `curl -o /dev/null` fails under `MSYS_NO_PATHCONV=1`, so the burst loops write to a temp file; editing the script while it runs breaks the running bash.
- The `care_app` password on the isolated native cluster (`:5499`) was set to a throwaway value by `ensure-app-login`; the database `care_qa_records_test` and every process started for this run were removed afterwards.
