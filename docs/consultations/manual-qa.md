---
title: consultations — Manual QA (CURL)
owner: care-team
service: care-service
module: consultations
status: verified
diataxis: how-to
last_verified: 2026-10-23
tags: [consultations, manual-qa, curl, booking, reschedule, cancel, exclusion-constraint, idempotency, case-2, follow-up, outbox, rbac, no-store, rate-limit, clinical-privacy]
related: [consultations-spec, consultations-tasks, consultations-brainstorm, patients-manual-qa, schedules-manual-qa, admin-doctors-manual-qa, api, rbac, quickstart]
---

# consultations — Manual QA (CURL)

_Run: 2026-10-12 • Server: http://127.0.0.1:3043 • Result: 384 pass / 0 fail_ (the final full run was 383 pass / 1 fail; the single failure was a QA-script expectation, not a product defect, see Failures / notes; the corrected line was re-checked by hand and is shown as row 383)

**Re-run 2026-10-23 (script maintenance, Postgres 5499 `care_test`, Redis 6380/15): 387 pass / 0 fail.** The case table below is the 2026-10-12 record; the re-run differs in three places and the script is the source of truth:
- Cleanup: `reset()` and the mid-run delete for patient 590 mark fixture `notification_outbox` rows `sent` before deleting them, because `trg_notification_outbox_delete_sent_only` refuses to delete pending rows (the trigger is unchanged).
- Case 96 is now `followUpOfRecordId-unknown-record` (404 `NotFound`: follow-up bookings exist, and a missing or foreign record is indistinguishable), plus three new 400 cases (`followUpOfRecordId-string`, `-zero`, `-fraction`); later case numbers shift by three.
- The `notification_outbox` grants case expects `select,insert,delete` yes and `update` no (`true true false true`): migration `20261012120000` grants DELETE, limited to sent rows by the trigger.
- The script needs one active row in `specialties` (the integration suites truncate it); seed a synthetic one before the run and remove it afterwards.

## Environment

The real Care HTTP listener (`npx tsx src/server.ts`, `NODE_ENV=development`, public 3043, internal 3143) ran against a throwaway database `care_qa_consult_test` on the docker test-stack Postgres (`127.0.0.1:5434`), migrated with the repo CLI (`src/migrate.ts latest`, then `ensure-app-login`, so the app connected as `care_app`, not the owner). Redis was the docker test stack (`127.0.0.1:6381`, db 15, flushed at the start and deliberately in the idempotency and Case 2 sections). Storage pointed at a dead endpoint; this slice makes no storage call. No care-worker ran (outbox delivery is a later unit), so outbox rows stay `pending`. The database was dropped and every process stopped afterwards.

**Identity.** `scripts/consultations-qa-fake-identity.mjs` is one loopback process (port 3023) that publishes a JWKS, mints in-memory EdDSA user tokens (patients 501-599 plus pending/rejected/suspended/unverified-email variants, doctors 601-699, admins, expired, `typ=service`), answers `POST /internal/auth/token` and `PATCH /internal/users/{id}/status`, and serves `GET /internal/users?ids=` for Case 2. Its mode is switched at runtime with `GET /__ctl?mode=healthy|down|hang|slow`; `GET /__calls` returns the batch calls received (ids and forwarded `X-Request-Id`), which is how "one batched call per page" and "request id forwarded" are asserted. No token or body is stored.

**Fixtures.** Doctors 601-615 are created through the real `POST /api/doctors/apply`, approved/synced with owner SQL, one 30 min / 500 EGP type and Mon-Sun 09:00-17:00 hours through the real schedules routes (doctor 605 in `Europe/Berlin` for the DST rows; 606-610 are the unbookable variants: unapproved, identity-unsynced, not accepting, no active type, locally suspended). Owner SQL also inserts rows near "now" (policy-window boundaries of +-5 min around the 120 min limit, past-started rows, `waiting`/`in_progress`/`completed`/`no_show`/`cancelled` states) because the booking route cannot create them. Complaint and reason text are the synthetic markers `QA-COMPLAINT-MARKER-7731` and `QA-REASON-MARKER-4410`; they are asserted absent from audit metadata, outbox payloads and the care-api log. No token, response body or clinical text is recorded here.

**Method.** Every call sends a fresh UUID `X-Request-Id` and (on writes) a fresh `Idempotency-Key`. Each row checks status, `success`, `error.code`, `error.requestId` equal to the sent id, a `details` array, the echoed `X-Request-Id` header and `Cache-Control: no-store`, plus a case-specific shape or value assertion. Rows with method `check` are non-HTTP assertions (owner SQL, fake Identity call log, log scan, comparison of two values).

Re-run: start the fake Identity and `src/server.ts` as in the header of `scripts/curl-test-consultations.sh`, then
`CARE_OWNER_DATABASE_URL=postgres://<owner>@127.0.0.1:5434/care_qa_consult_test REDIS_URL=redis://127.0.0.1:6381/15 SERVER_LOG=<care-api log> bash scripts/curl-test-consultations.sh` (about 25 minutes: per-token write-limiter sleep windows, the hang timeouts, three rate-limit loops). The script refuses a database not ending in `_test` or containing `_qa`.

## Endpoints covered

`POST /api/consultations`, `GET /api/consultations`, `GET /api/consultations/{id}`, `PATCH /api/consultations/{id}/reschedule`, `PATCH /api/consultations/{id}/cancel`, `GET /api/patients/{patientUserId}`. Roles: patient (owner, non-owner, token status pending/rejected/suspended, unverified email), doctor (assigned, other, pending, locally suspended), admin, unauthenticated, malformed/expired/`typ=service` token, spoofed `X-User-Id`/`X-Role`.

Scenario groups: happy booking and response shape; RBAC matrix; validation matrix (create, reschedule, cancel, list and get query); booking rules (unknown doctor/type, five unbookable doctor states, past, horizon, off-grid, outside hours, day-off and custom-hours exceptions, DST on `Europe/Berlin` across 2026-10-25); idempotency (replay, conflicting body, replay after Redis loss from the DB row, six parallel same-key requests); real concurrency (8 parallel bookings of one slot, 2 parallel reschedules onto one slot); reschedule and cancel matrices including the patient policy window vs doctor/admin and terminal states; list scopes, status/date filters, keyset pagination, timezone defaults; Case 2 degrade (Identity down, hanging, slow); follow-up flags from doctor suspension and from schedule blocks with `confirmConflicts`; `/patients/{id}` relationship rules; no-store on malformed JSON; direct DB guarantees (exclusion constraint, grants); log hygiene; rate limits.

## Cases

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 1 | POST | /api/consultations | patient | book-happy-path | 201 | 201 | PASS |
| 2 | check | audit | owner | book writes one consultation.booked row (metadata ids/instants only) | 1 | 1 | PASS |
| 3 | check | outbox | owner | book queues booking_confirmed for patient and doctor | 2 501,601 | 2 501,601 | PASS |
| 4 | check | outbox | owner | outbox payload keys are ids/instants only (no text) | 0 | 0 | PASS |
| 5 | check | db | owner | row has server-derived ends_at, price snapshot, canonical patient_timezone, idempotency key persisted | 30 500 EGP Europe/Berlin 6eefcec7-6707-4393-8a7f-896ab2a0570e | 30 500 EGP Europe/Berlin 6eefcec7-6707-4393-8a7f-896ab2a0570e | PASS |
| 6 | POST | /api/consultations | patient | patient-timezone-canonicalized | 201 | 201 | PASS |
| 7 | POST | /api/consultations | patient | start-in-utc-notation-equal-instant | 201 | 201 | PASS |
| 8 | POST | /api/consultations | patient | back-to-back-adjacent-slot-allowed | 201 | 201 | PASS |
| 9 | POST | /api/consultations | patient | last-slot-of-day-16:30-allowed | 201 | 201 | PASS |
| 10 | POST | /api/consultations | patient | identity-headers-ignored-patient-from-token | 201 | 201 | PASS |
| 11 | POST | /api/consultations | patient | complaint-with-newline-and-unicode-allowed | 201 | 201 | PASS |
| 12 | POST | /api/consultations | patient | complaint-exactly-3-code-points | 201 | 201 | PASS |
| 13 | POST | /api/consultations | none | none | 401 Unauthorized | 401 Unauthorized | PASS |
| 14 | GET | /api/consultations | none | none | 401 Unauthorized | 401 Unauthorized | PASS |
| 15 | GET | /api/consultations/161 | none | none | 401 Unauthorized | 401 Unauthorized | PASS |
| 16 | PATCH | /api/consultations/161/reschedule | none | none | 401 Unauthorized | 401 Unauthorized | PASS |
| 17 | PATCH | /api/consultations/161/cancel | none | none | 401 Unauthorized | 401 Unauthorized | PASS |
| 18 | GET | /api/patients/501 | none | none | 401 Unauthorized | 401 Unauthorized | PASS |
| 19 | POST | /api/consultations | malformed | malformed | 401 Unauthorized | 401 Unauthorized | PASS |
| 20 | GET | /api/consultations | malformed | malformed | 401 Unauthorized | 401 Unauthorized | PASS |
| 21 | GET | /api/consultations/161 | malformed | malformed | 401 Unauthorized | 401 Unauthorized | PASS |
| 22 | PATCH | /api/consultations/161/reschedule | malformed | malformed | 401 Unauthorized | 401 Unauthorized | PASS |
| 23 | PATCH | /api/consultations/161/cancel | malformed | malformed | 401 Unauthorized | 401 Unauthorized | PASS |
| 24 | GET | /api/patients/501 | malformed | malformed | 401 Unauthorized | 401 Unauthorized | PASS |
| 25 | POST | /api/consultations | expired | expired | 401 TokenExpired | 401 TokenExpired | PASS |
| 26 | GET | /api/consultations | expired | expired | 401 TokenExpired | 401 TokenExpired | PASS |
| 27 | GET | /api/consultations/161 | expired | expired | 401 TokenExpired | 401 TokenExpired | PASS |
| 28 | PATCH | /api/consultations/161/reschedule | expired | expired | 401 TokenExpired | 401 TokenExpired | PASS |
| 29 | PATCH | /api/consultations/161/cancel | expired | expired | 401 TokenExpired | 401 TokenExpired | PASS |
| 30 | GET | /api/patients/501 | expired | expired | 401 TokenExpired | 401 TokenExpired | PASS |
| 31 | POST | /api/consultations | service-token | service-token | 401 Unauthorized | 401 Unauthorized | PASS |
| 32 | GET | /api/consultations | service-token | service-token | 401 Unauthorized | 401 Unauthorized | PASS |
| 33 | GET | /api/consultations/161 | service-token | service-token | 401 Unauthorized | 401 Unauthorized | PASS |
| 34 | PATCH | /api/consultations/161/reschedule | service-token | service-token | 401 Unauthorized | 401 Unauthorized | PASS |
| 35 | PATCH | /api/consultations/161/cancel | service-token | service-token | 401 Unauthorized | 401 Unauthorized | PASS |
| 36 | GET | /api/patients/501 | service-token | service-token | 401 Unauthorized | 401 Unauthorized | PASS |
| 37 | POST | /api/consultations | doctor | book-denied-doctor | 403 Forbidden | 403 Forbidden | PASS |
| 38 | POST | /api/consultations | admin | book-denied-admin | 403 Forbidden | 403 Forbidden | PASS |
| 39 | POST | /api/consultations | doctor-pending | book-denied-doctor-pending | 403 Forbidden | 403 Forbidden | PASS |
| 40 | POST | /api/consultations | patient-pending | book-denied-patient-pending | 403 Forbidden | 403 Forbidden | PASS |
| 41 | POST | /api/consultations | patient-rejected | book-denied-patient-rejected | 403 Forbidden | 403 Forbidden | PASS |
| 42 | POST | /api/consultations | patient-suspended | book-denied-patient-suspended | 403 Forbidden | 403 Forbidden | PASS |
| 43 | POST | /api/consultations | patient-unverified | book-email-not-verified | 403 EmailNotVerified | 403 EmailNotVerified | PASS |
| 44 | POST | /api/consultations | admin | book-spoofed-X-Role-patient-ignored | 403 Forbidden | 403 Forbidden | PASS |
| 45 | check | rbac | owner | denied bookings created no row | 0 | 0 | PASS |
| 46 | GET | /api/consultations | doctor-pending | list-denied-doctor-pending | 403 Forbidden | 403 Forbidden | PASS |
| 47 | GET | /api/consultations | doctor-rejected | list-denied-doctor-rejected | 403 Forbidden | 403 Forbidden | PASS |
| 48 | GET | /api/consultations | patient-pending | list-denied-patient-pending | 403 Forbidden | 403 Forbidden | PASS |
| 49 | GET | /api/consultations | patient-rejected | list-denied-patient-rejected | 403 Forbidden | 403 Forbidden | PASS |
| 50 | GET | /api/consultations | patient-suspended | list-denied-patient-suspended | 403 Forbidden | 403 Forbidden | PASS |
| 51 | GET | /api/consultations | admin-suspended | list-denied-admin-suspended | 403 Forbidden | 403 Forbidden | PASS |
| 52 | GET | /api/consultations | patient-unverified | unverified-email-patient-can-list | 200 | 200 | PASS |
| 53 | GET | /api/consultations/161 | patient-owner | get-owner | 200 | 200 | PASS |
| 54 | GET | /api/consultations/161 | doctor-assigned | get-assigned-doctor | 200 | 200 | PASS |
| 55 | GET | /api/consultations/161 | admin | get-admin-view-without-complaint | 200 | 200 | PASS |
| 56 | GET | /api/consultations/161 | patient-other | get-non-owner-patient | 404 NotFound | 404 NotFound | PASS |
| 57 | GET | /api/consultations/161 | doctor-other | get-non-assigned-doctor | 404 NotFound | 404 NotFound | PASS |
| 58 | GET | /api/consultations/99999999 | patient | get-nonexistent | 404 NotFound | 404 NotFound | PASS |
| 59 | GET | /api/consultations/99999999 | admin | get-nonexistent-admin | 404 NotFound | 404 NotFound | PASS |
| 60 | GET | /api/consultations/abc | patient | get-bad-id-abc | 404 NotFound | 404 NotFound | PASS |
| 61 | GET | /api/consultations/0 | patient | get-bad-id-0 | 404 NotFound | 404 NotFound | PASS |
| 62 | GET | /api/consultations/-1 | patient | get-bad-id--1 | 404 NotFound | 404 NotFound | PASS |
| 63 | GET | /api/consultations/1.5 | patient | get-bad-id-1.5 | 404 NotFound | 404 NotFound | PASS |
| 64 | GET | /api/consultations/99999999999999999999 | patient | get-bad-id-99999999999999999999 | 404 NotFound | 404 NotFound | PASS |
| 65 | GET | /api/consultations/161 | patient-pending | get-token-status-pending | 403 Forbidden | 403 Forbidden | PASS |
| 66 | check | audit | owner | get-one by patient and doctor each wrote consultation.read, admin wrote none | 1 1 0 | 1 1 0 | PASS |
| 67 | check | audit | owner | consultation.read metadata is {viewerRole} only | 0 | 0 | PASS |
| 68 | PATCH | /api/consultations/161/reschedule | doctor | reschedule-doctor-role-denied | 403 Forbidden | 403 Forbidden | PASS |
| 69 | PATCH | /api/consultations/161/reschedule | patient-other | reschedule-non-owner | 404 NotFound | 404 NotFound | PASS |
| 70 | PATCH | /api/consultations/abc/reschedule | patient | reschedule-non-numeric-id | 404 NotFound | 404 NotFound | PASS |
| 71 | PATCH | /api/consultations/99999999/reschedule | admin | reschedule-nonexistent-admin | 404 NotFound | 404 NotFound | PASS |
| 72 | PATCH | /api/consultations/161/cancel | patient-other | cancel-non-owner-patient | 404 NotFound | 404 NotFound | PASS |
| 73 | PATCH | /api/consultations/161/cancel | doctor-other | cancel-non-assigned-doctor | 404 NotFound | 404 NotFound | PASS |
| 74 | PATCH | /api/consultations/99999999/cancel | admin | cancel-nonexistent-admin | 404 NotFound | 404 NotFound | PASS |
| 75 | PATCH | /api/consultations/161/cancel | doctor-pending | cancel-doctor-token-pending | 403 Forbidden | 403 Forbidden | PASS |
| 76 | check | rbac | owner | denied/not-found writes changed nothing | booked | booked | PASS |
| 77 | PATCH | /api/patients/me | patient | setup-patient-profile | 200 | 200 | PASS |
| 78 | GET | /api/patients/501 | patient-self | patient-profile-self | 200 | 200 | PASS |
| 79 | GET | /api/patients/501 | doctor-related | patient-profile-related-doctor | 200 | 200 | PASS |
| 80 | check | audit | owner | patient_profile.read by the doctor audited (patientUserId + viewerRole) | 1 | 1 | PASS |
| 81 | GET | /api/patients/501 | doctor-unrelated | patient-profile-unrelated-doctor | 404 NotFound | 404 NotFound | PASS |
| 82 | GET | /api/patients/501 | patient-other | patient-profile-other-patient | 404 NotFound | 404 NotFound | PASS |
| 83 | GET | /api/patients/501 | admin | patient-profile-admin-denied | 403 Forbidden | 403 Forbidden | PASS |
| 84 | GET | /api/patients/501 | doctor-pending | patient-profile-doctor-token-pending | 403 Forbidden | 403 Forbidden | PASS |
| 85 | GET | /api/patients/501 | patient-pending | patient-profile-patient-token-pending | 403 Forbidden | 403 Forbidden | PASS |
| 86 | GET | /api/patients/abc | doctor | patient-profile-bad-id-abc | 404 NotFound | 404 NotFound | PASS |
| 87 | GET | /api/patients/0 | doctor | patient-profile-bad-id-0 | 404 NotFound | 404 NotFound | PASS |
| 88 | GET | /api/patients/-1 | doctor | patient-profile-bad-id--1 | 404 NotFound | 404 NotFound | PASS |
| 89 | GET | /api/patients/99999999 | doctor | patient-profile-bad-id-99999999 | 404 NotFound | 404 NotFound | PASS |
| 90 | GET | /api/patients/502 | doctor-related-no-profile | patient-profile-not-created-yet | 404 NotFound | 404 NotFound | PASS |
| 91 | check | audit | owner | no patient_profile.read rows for admin, unrelated doctor, other patient, pending tokens | 0 | 0 | PASS |
| 92 | POST | /api/consultations | patient | unknown-member-patientUserId | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 93 | POST | /api/consultations | patient | unknown-member-price | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 94 | POST | /api/consultations | patient | unknown-member-endsAt | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 95 | POST | /api/consultations | patient | unknown-member-durationMinutes | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 96 | POST | /api/consultations | patient | followUpOfRecordId-not-supported | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 97 | POST | /api/consultations | patient | doctorId-string | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 98 | POST | /api/consultations | patient | doctorId-zero | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 99 | POST | /api/consultations | patient | doctorId-negative | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 100 | POST | /api/consultations | patient | doctorId-float | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 101 | POST | /api/consultations | patient | typeId-missing | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 102 | POST | /api/consultations | patient | typeId-null | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 103 | POST | /api/consultations | patient | startsAt-without-offset | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 104 | POST | /api/consultations | patient | startsAt-date-only | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 105 | POST | /api/consultations | patient | startsAt-number | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 106 | POST | /api/consultations | patient | startsAt-garbage | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 107 | POST | /api/consultations | patient | complaint-missing | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 108 | POST | /api/consultations | patient | complaint-blank | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 109 | POST | /api/consultations | patient | complaint-2-chars | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 110 | POST | /api/consultations | patient | complaint-4001-chars | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 111 | POST | /api/consultations | patient | complaint-nul-char | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 112 | POST | /api/consultations | patient | complaint-not-string | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 113 | POST | /api/consultations | patient | patientTimezone-missing | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 114 | POST | /api/consultations | patient | patientTimezone-invalid-zone | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 115 | POST | /api/consultations | patient | patientTimezone-65-chars | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 116 | POST | /api/consultations | patient | body-is-array | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 117 | POST | /api/consultations | patient | body-empty-object | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 118 | POST | /api/consultations | patient | body-absent | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 119 | POST | /api/consultations | patient | malformed-json | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 120 | POST | /api/consultations | patient | missing-idempotency-key | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 121 | POST | /api/consultations | patient | non-uuid-idempotency-key | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 122 | POST | /api/consultations | patient | empty-idempotency-key-header | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 123 | PATCH | /api/consultations/161/reschedule | patient | reschedule-missing-key | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 124 | PATCH | /api/consultations/161/cancel | patient | cancel-missing-key | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 125 | check | db | owner | no validation-failure created a row | 0 | 0 | PASS |
| 126 | PATCH | /api/consultations/161/reschedule | patient | reschedule-startsAt-missing | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 127 | PATCH | /api/consultations/161/reschedule | patient | reschedule-startsAt-no-offset | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 128 | PATCH | /api/consultations/161/reschedule | patient | reschedule-unknown-member | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 129 | PATCH | /api/consultations/161/reschedule | patient | reschedule-reason-2-chars | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 130 | PATCH | /api/consultations/161/reschedule | patient | reschedule-reason-1001-chars | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 131 | PATCH | /api/consultations/161/reschedule | patient | reschedule-reason-blank | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 132 | PATCH | /api/consultations/161/reschedule | patient | reschedule-no-body | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 133 | PATCH | /api/consultations/161/reschedule | admin | reschedule-admin-reason-required | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 134 | PATCH | /api/consultations/161/cancel | patient | cancel-no-body | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 135 | PATCH | /api/consultations/161/cancel | patient | cancel-reason-2-chars | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 136 | PATCH | /api/consultations/161/cancel | patient | cancel-reason-1001-chars | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 137 | PATCH | /api/consultations/161/cancel | patient | cancel-unknown-member | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 138 | PATCH | /api/consultations/161/cancel | doctor | cancel-doctor-reason-required | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 139 | PATCH | /api/consultations/161/cancel | admin | cancel-admin-reason-required | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 140 | check | db | owner | reschedule/cancel validation failures changed nothing | booked | booked | PASS |
| 141 | GET | /api/consultations?scope=bogus | patient | list-scope-invalid | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 142 | GET | /api/consultations?limit=0 | patient | list-limit-0 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 143 | GET | /api/consultations?limit=101 | patient | list-limit-101 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 144 | GET | /api/consultations?limit=abc | patient | list-limit-not-int | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 145 | GET | /api/consultations?cursor=%%garbage | patient | list-cursor-garbage | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 146 | GET | /api/consultations?status=bogus | patient | list-status-invalid | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 147 | GET | /api/consultations?status=booked&status=cancelled | patient | list-status-repeated-param | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 148 | GET | /api/consultations?status=booked,booked,waiting,in_progress,completed,cancelled,no_show | patient | list-status-7-values | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 149 | GET | /api/consultations?from=2030-01-01T00:00:00 | patient | list-from-no-offset | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 150 | GET | /api/consultations?from=2030-01-02T00:00:00Z&to=2030-01-01T00:00:00Z | patient | list-from-after-to | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 151 | GET | /api/consultations?from=2030-01-01T00:00:00Z&to=2030-01-01T00:00:00Z | patient | list-from-equals-to | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 152 | GET | /api/consultations?timezone=Mars/Olympus | patient | list-timezone-invalid | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 153 | GET | /api/consultations?foo=bar | patient | list-unknown-param | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 154 | GET | /api/consultations?doctorUserId=abc | admin | list-admin-doctorUserId-not-int | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 155 | GET | /api/consultations?needsAdminFollowup=yes | admin | list-admin-needsAdminFollowup-not-bool | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 156 | GET | /api/consultations/161?timezone=Mars/Olympus | patient | get-timezone-invalid | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 157 | GET | /api/consultations?doctorUserId=601 | patient | list-admin-filter-doctorUserId-by-patient | 403 Forbidden | 403 Forbidden | PASS |
| 158 | GET | /api/consultations?patientUserId=501 | doctor | list-admin-filter-patientUserId-by-doctor | 403 Forbidden | 403 Forbidden | PASS |
| 159 | GET | /api/consultations?needsAdminFollowup=true | patient | list-admin-filter-followup-by-patient | 403 Forbidden | 403 Forbidden | PASS |
| 160 | GET | /api/consultations?needsAdminFollowup=false | doctor | list-admin-filter-followup-false-by-doctor | 403 Forbidden | 403 Forbidden | PASS |
| 161 | POST | /api/consultations | patient | doctor-unknown | 404 NotFound | 404 NotFound | PASS |
| 162 | POST | /api/consultations | patient | type-unknown | 404 NotFound | 404 NotFound | PASS |
| 163 | POST | /api/consultations | patient | type-of-another-doctor | 404 NotFound | 404 NotFound | PASS |
| 164 | POST | /api/consultations | patient | doctorId-is-a-patient-user | 404 NotFound | 404 NotFound | PASS |
| 165 | POST | /api/consultations | patient | doctor-unapproved | 409 DoctorNotBookable | 409 DoctorNotBookable | PASS |
| 166 | POST | /api/consultations | patient | doctor-identity-unsynced | 409 DoctorNotBookable | 409 DoctorNotBookable | PASS |
| 167 | POST | /api/consultations | patient | doctor-not-accepting | 409 DoctorNotBookable | 409 DoctorNotBookable | PASS |
| 168 | POST | /api/consultations | patient | doctor-no-active-type | 409 DoctorNotBookable | 409 DoctorNotBookable | PASS |
| 169 | POST | /api/consultations | patient | doctor-locally-suspended | 409 DoctorNotBookable | 409 DoctorNotBookable | PASS |
| 170 | POST | /api/consultations | patient | start-in-past-yesterday | 422 BookingInPast | 422 BookingInPast | PASS |
| 171 | POST | /api/consultations | patient | start-one-minute-ago | 422 BookingInPast | 422 BookingInPast | PASS |
| 172 | POST | /api/consultations | patient | start-61-days-ahead | 422 BeyondBookingHorizon | 422 BeyondBookingHorizon | PASS |
| 173 | POST | /api/consultations | patient | start-59-days-ahead-allowed | 201 | 201 | PASS |
| 174 | POST | /api/consultations | patient | outside-hours-before-hours-08:00 | 422 OutsideWorkingHours | 422 OutsideWorkingHours | PASS |
| 175 | POST | /api/consultations | patient | outside-hours-before-hours-half-08:30 | 422 OutsideWorkingHours | 422 OutsideWorkingHours | PASS |
| 176 | POST | /api/consultations | patient | outside-hours-at-closing-time-17:00 | 422 OutsideWorkingHours | 422 OutsideWorkingHours | PASS |
| 177 | POST | /api/consultations | patient | outside-hours-off-grid-16:45-16:45 | 422 OutsideWorkingHours | 422 OutsideWorkingHours | PASS |
| 178 | POST | /api/consultations | patient | outside-hours-off-grid-10:15-10:15 | 422 OutsideWorkingHours | 422 OutsideWorkingHours | PASS |
| 179 | POST | /api/consultations | patient | outside-hours-after-hours-17:30 | 422 OutsideWorkingHours | 422 OutsideWorkingHours | PASS |
| 180 | POST | /api/consultations | patient | off-grid-by-one-minute | 422 OutsideWorkingHours | 422 OutsideWorkingHours | PASS |
| 181 | POST | /api/doctors/me/exceptions | doctor | setup-day-off | 201 | 201 | PASS |
| 182 | POST | /api/doctors/me/exceptions | doctor | setup-custom-hours-12-14 | 201 | 201 | PASS |
| 183 | POST | /api/consultations | patient | booking-on-day-off | 422 OutsideWorkingHours | 422 OutsideWorkingHours | PASS |
| 184 | POST | /api/consultations | patient | custom-hours-before-window | 422 OutsideWorkingHours | 422 OutsideWorkingHours | PASS |
| 185 | POST | /api/consultations | patient | custom-hours-inside-window | 201 | 201 | PASS |
| 186 | POST | /api/consultations | patient | custom-hours-last-slot-13:30 | 201 | 201 | PASS |
| 187 | POST | /api/consultations | patient | slot-taken-same-start | 409 SlotUnavailable | 409 SlotUnavailable | PASS |
| 188 | POST | /api/consultations | patient | slot-taken-by-self-other-key | 409 SlotUnavailable | 409 SlotUnavailable | PASS |
| 189 | check | db | owner | exactly one live consultation at the contested slot | 1 | 1 | PASS |
| 190 | POST | /api/consultations | patient | dst-before-change-09:00-berlin | 201 | 201 | PASS |
| 191 | POST | /api/consultations | patient | dst-after-change-09:00-berlin | 201 | 201 | PASS |
| 192 | POST | /api/consultations | patient | dst-change-day-last-slot-16:30 | 201 | 201 | PASS |
| 193 | POST | /api/consultations | patient | dst-off-grid-09:15 | 422 OutsideWorkingHours | 422 OutsideWorkingHours | PASS |
| 194 | POST | /api/consultations | patient | dst-utc-notation-evaluated-in-doctor-zone-11:00-berlin | 201 | 201 | PASS |
| 195 | POST | /api/consultations | patient | idem-first-call | 201 | 201 | PASS |
| 196 | POST | /api/consultations | patient | idem-replay-same-body-same-response | 201 | 201 | PASS |
| 197 | POST | /api/consultations | patient | idem-same-key-different-body | 422 IdempotencyConflict | 422 IdempotencyConflict | PASS |
| 198 | check | db | owner | replay and conflict created exactly one row for the key | 1 | 1 | PASS |
| 199 | POST | /api/consultations | patient | idem-same-key-other-principal-is-independent | 201 | 201 | PASS |
| 200 | POST | /api/consultations | patient | idem-db-replay-after-redis-loss | 201 | 201 | PASS |
| 201 | POST | /api/consultations | patient | idem-db-conflict-after-redis-loss | 422 IdempotencyConflict | 422 IdempotencyConflict | PASS |
| 202 | check | idempotency | owner | six parallel same-key requests answer only 201 (original/replay) or 409 Conflict (in flight) | 0 | 0 | PASS |
| 203 | check | idempotency | owner | in-flight 409s carry code Conflict + Retry-After: 1; all 201s share one id | 1 | 1 | PASS |
| 204 | check | idempotency | owner | exactly one row for the parallel key | 1 | 1 | PASS |
| 205 | check | concurrency | owner | 8 parallel bookings of one slot: exactly one 201 | 1 | 1 | PASS |
| 206 | check | concurrency | owner | ... and seven 409 SlotUnavailable (no 5xx) | 7 | 7 | PASS |
| 207 | check | concurrency | owner | exactly one row, one booking audit row, two outbox rows for the slot | 1 1 2 | 1 1 2 | PASS |
| 208 | check | concurrency | owner | loser rows leave no outbox/audit residue (rollback) | 0 | 0 | PASS |
| 209 | POST | /api/consultations | patient | reschedule-fixture-book | 201 | 201 | PASS |
| 210 | PATCH | /api/consultations/189/reschedule | patient | reschedule-patient-outside-window | 200 | 200 | PASS |
| 211 | check | db | owner | reschedule updated the same row, cleared reminders and follow-up flag | 1 false | 1 false | PASS |
| 212 | check | audit | owner | consultation.rescheduled audited for a patient caller (byRole, from/to; no reason text) | 1 | 1 | PASS |
| 213 | check | outbox | owner | reschedule queued rescheduled for both parties | 2 | 2 | PASS |
| 214 | PATCH | /api/consultations/189/reschedule | patient | reschedule-same-start-noop | 200 | 200 | PASS |
| 215 | check | db | owner | same-start reschedule: no write, no audit, no outbox | 2026-10-12 01:40:32.386913+00 1 2 | 2026-10-12 01:40:32.386913+00 1 2 | PASS |
| 216 | PATCH | /api/consultations/189/reschedule | patient | reschedule-key-first | 200 | 200 | PASS |
| 217 | PATCH | /api/consultations/189/reschedule | patient | reschedule-replay-same-key | 200 | 200 | PASS |
| 218 | PATCH | /api/consultations/189/reschedule | patient | reschedule-same-key-different-body | 422 IdempotencyConflict | 422 IdempotencyConflict | PASS |
| 219 | PATCH | /api/consultations/189/reschedule | patient | reschedule-off-grid | 422 OutsideWorkingHours | 422 OutsideWorkingHours | PASS |
| 220 | PATCH | /api/consultations/189/reschedule | patient | reschedule-outside-hours | 422 OutsideWorkingHours | 422 OutsideWorkingHours | PASS |
| 221 | PATCH | /api/consultations/189/reschedule | patient | reschedule-to-past | 422 BookingInPast | 422 BookingInPast | PASS |
| 222 | PATCH | /api/consultations/189/reschedule | patient | reschedule-beyond-horizon | 422 BeyondBookingHorizon | 422 BeyondBookingHorizon | PASS |
| 223 | POST | /api/consultations | patient | reschedule-target-fixture-book | 201 | 201 | PASS |
| 224 | PATCH | /api/consultations/189/reschedule | patient | reschedule-onto-taken-slot | 409 SlotUnavailable | 409 SlotUnavailable | PASS |
| 225 | check | db | owner | failed reschedules left the row at its last good time | 2026-10-24T11:00:00 | 2026-10-24T11:00:00 | PASS |
| 226 | POST | /api/consultations | patient | reschedule-race-fixture-1 | 201 | 201 | PASS |
| 227 | POST | /api/consultations | patient | reschedule-race-fixture-2 | 201 | 201 | PASS |
| 228 | check | concurrency | owner | two reschedules onto one slot: one 200 and one 409 SlotUnavailable | 200 409 | 200 409 | PASS |
| 229 | check | concurrency | owner | the loser kept its old interval; one row at the target | 1 | 1 | PASS |
| 230 | PATCH | /api/consultations/193/reschedule | patient | reschedule-patient-inside-window-115min | 409 PolicyWindowViolation | 409 PolicyWindowViolation | PASS |
| 231 | PATCH | /api/consultations/194/reschedule | patient | reschedule-patient-start-already-past | 409 PolicyWindowViolation | 409 PolicyWindowViolation | PASS |
| 232 | PATCH | /api/consultations/195/reschedule | patient | reschedule-patient-outside-window-125min | 200 | 200 | PASS |
| 233 | PATCH | /api/consultations/193/reschedule | admin | reschedule-admin-inside-window-with-reason | 200 | 200 | PASS |
| 234 | check | audit | owner | admin reschedule audited with byRole=admin and reasonLength only | 1 | 1 | PASS |
| 235 | PATCH | /api/consultations/194/reschedule | admin | reschedule-admin-past-started-row | 200 | 200 | PASS |
| 236 | PATCH | /api/consultations/196/reschedule | patient | reschedule-status-waiting | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 237 | PATCH | /api/consultations/197/reschedule | patient | reschedule-status-in_progress | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 238 | PATCH | /api/consultations/198/reschedule | patient | reschedule-status-completed | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 239 | PATCH | /api/consultations/199/reschedule | patient | reschedule-status-no_show | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 240 | PATCH | /api/consultations/200/reschedule | patient | reschedule-status-cancelled | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 241 | POST | /api/consultations | patient | reschedule-guard-fixture-book | 201 | 201 | PASS |
| 242 | PATCH | /api/consultations/201/reschedule | patient | reschedule-doctor-not-accepting | 409 DoctorNotBookable | 409 DoctorNotBookable | PASS |
| 243 | POST | /api/consultations | patient | cancel-fixture-book | 201 | 201 | PASS |
| 244 | PATCH | /api/consultations/202/cancel | patient | cancel-patient-outside-window-empty-body | 200 | 200 | PASS |
| 245 | check | audit | owner | consultation.cancelled audited (byRole, fromStatus; request id) | 1 | 1 | PASS |
| 246 | check | outbox | owner | cancel queued cancelled for both parties | 2 | 2 | PASS |
| 247 | POST | /api/consultations | patient | cancel-releases-slot-rebook-same-start | 201 | 201 | PASS |
| 248 | PATCH | /api/consultations/202/cancel | patient | cancel-already-cancelled-new-key | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 249 | POST | /api/consultations | patient | cancel-with-reason-fixture | 201 | 201 | PASS |
| 250 | PATCH | /api/consultations/204/cancel | patient | cancel-patient-with-reason | 200 | 200 | PASS |
| 251 | PATCH | /api/consultations/204/cancel | patient | cancel-replay-same-key | 200 | 200 | PASS |
| 252 | PATCH | /api/consultations/204/cancel | patient | cancel-same-key-different-body | 422 IdempotencyConflict | 422 IdempotencyConflict | PASS |
| 253 | check | audit | owner | cancel audit stores reasonLength, never the reason | 1 | 1 | PASS |
| 254 | GET | /api/consultations/204 | patient | get-cancelled-shows-reason-to-owner | 200 | 200 | PASS |
| 255 | GET | /api/consultations/204 | admin | get-cancelled-admin-no-complaint | 200 | 200 | PASS |
| 256 | PATCH | /api/consultations/205/cancel | patient | cancel-patient-inside-window-115min | 409 PolicyWindowViolation | 409 PolicyWindowViolation | PASS |
| 257 | PATCH | /api/consultations/206/cancel | patient | cancel-patient-outside-window-125min | 200 | 200 | PASS |
| 258 | PATCH | /api/consultations/205/cancel | doctor | cancel-doctor-inside-window-with-reason | 200 | 200 | PASS |
| 259 | PATCH | /api/consultations/207/cancel | admin | cancel-admin-inside-window-with-reason | 200 | 200 | PASS |
| 260 | PATCH | /api/consultations/208/cancel | patient | cancel-waiting-allowed | 200 | 200 | PASS |
| 261 | PATCH | /api/consultations/209/cancel | patient | cancel-status-in_progress | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 262 | PATCH | /api/consultations/210/cancel | patient | cancel-status-completed | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 263 | PATCH | /api/consultations/211/cancel | patient | cancel-status-no_show | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 264 | PATCH | /api/consultations/212/cancel | patient | cancel-status-cancelled | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 265 | PATCH | /api/consultations/213/cancel | admin | cancel-admin-terminal-or-active-in_progress | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 266 | check | db | owner | chk_consultations_cancel_shape holds: every cancelled row has cancelled_at and cancelled_by | 0 | 0 | PASS |
| 267 | POST | /api/consultations | patient | list-fixture-book-09:00 | 201 | 201 | PASS |
| 268 | POST | /api/consultations | patient | list-fixture-book-09:30 | 201 | 201 | PASS |
| 269 | POST | /api/consultations | patient | list-fixture-book-10:00 | 201 | 201 | PASS |
| 270 | POST | /api/consultations | patient | list-fixture-book-10:30 | 201 | 201 | PASS |
| 271 | POST | /api/consultations | patient | list-fixture-book-11:00 | 201 | 201 | PASS |
| 272 | GET | /api/consultations?limit=2 | patient | list-patient-page-1 | 200 | 200 | PASS |
| 273 | check | case2 | owner | one batched Identity call for the page, ids = distinct counterpart (601) only | 1 601 | 1 601 | PASS |
| 274 | check | case2 | owner | batch call forwards the request id | 1a99ecab-22f4-4307-a94a-2a8297cef8a7 | 1a99ecab-22f4-4307-a94a-2a8297cef8a7 | PASS |
| 275 | GET | /api/consultations?limit=2&cursor=WyIyMDI2LTExLTAzVDA3OjMwOjAwLjAwMDAwMFoiLDIxNV0 | patient | list-patient-page-2 | 200 | 200 | PASS |
| 276 | check | case2 | owner | cache hit: page 2 added no Identity call | 1 | 1 | PASS |
| 277 | GET | /api/consultations?limit=2&cursor=WyIyMDI2LTExLTAzVDA4OjMwOjAwLjAwMDAwMFoiLDIxN10 | patient | list-patient-page-3-last | 200 | 200 | PASS |
| 278 | check | pagination | owner | pages cover all 5 rows once, in ascending order | 5 | 5 | PASS |
| 279 | GET | /api/consultations | patient | list-default-limit-and-scope-upcoming | 200 | 200 | PASS |
| 280 | GET | /api/consultations?scope=past | patient | list-scope-past-empty | 200 | 200 | PASS |
| 281 | GET | /api/consultations?scope=all&status=cancelled | patient | list-status-filter-empty | 200 | 200 | PASS |
| 282 | GET | /api/consultations?status=booked,waiting&scope=all | patient | list-status-comma-list | 200 | 200 | PASS |
| 283 | GET | /api/consultations?from=2026-11-03T09:00:00%2B02:00&to=2026-11-03T10:30:00%2B02:00 | patient | list-from-to-bounds-startsAt | 200 | 200 | PASS |
| 284 | GET | /api/consultations?timezone=Asia/Tokyo&limit=1 | patient | list-timezone-override-honored | 200 | 200 | PASS |
| 285 | GET | /api/consultations?limit=1 | patient | list-default-tz-is-patientTimezone | 200 | 200 | PASS |
| 286 | GET | /api/consultations?scope=past | patient | list-scope-past-descending | 200 | 200 | PASS |
| 287 | GET | /api/consultations?scope=upcoming | patient | list-scope-upcoming-excludes-past | 200 | 200 | PASS |
| 288 | GET | /api/consultations?scope=all | patient | list-scope-all-ascending | 200 | 200 | PASS |
| 289 | GET | /api/consultations?limit=3 | doctor | list-doctor-own-rows-doctor-timezone-default | 200 | 200 | PASS |
| 290 | GET | /api/consultations?limit=100&scope=all | doctor | list-other-doctor-sees-none-of-601 | 200 | 200 | PASS |
| 291 | GET | /api/consultations?scope=all&limit=100 | admin | list-admin-all-both-sides-hydrated-no-complaint | 200 | 200 | PASS |
| 292 | GET | /api/consultations?scope=all&doctorUserId=601&patientUserId=580&limit=100 | admin | list-admin-filter-doctor-and-patient | 200 | 200 | PASS |
| 293 | GET | /api/consultations?scope=all&patientUserId=580&timezone=America/New_York&limit=1 | admin | list-admin-timezone-override | 200 | 200 | PASS |
| 294 | GET | /api/consultations?limit=2 | patient | case2-list-identity-down | 200 | 200 | PASS |
| 295 | GET | /api/consultations/214 | patient | case2-get-identity-down | 200 | 200 | PASS |
| 296 | GET | /api/consultations?limit=2&scope=all | admin | case2-admin-list-identity-down | 200 | 200 | PASS |
| 297 | GET | /api/consultations?limit=2 | patient | case2-list-identity-hang | 200 | 200 | PASS |
| 298 | GET | /api/consultations/214 | patient | case2-get-identity-hang | 200 | 200 | PASS |
| 299 | GET | /api/consultations?limit=2&scope=all | admin | case2-admin-list-identity-hang | 200 | 200 | PASS |
| 300 | GET | /api/consultations?limit=2 | patient | case2-list-identity-slow | 200 | 200 | PASS |
| 301 | GET | /api/consultations/214 | patient | case2-get-identity-slow | 200 | 200 | PASS |
| 302 | GET | /api/consultations?limit=2&scope=all | admin | case2-admin-list-identity-slow | 200 | 200 | PASS |
| 303 | GET | /api/consultations?limit=2 | patient | case2-recovers-when-identity-healthy | 200 | 200 | PASS |
| 304 | check | case2 | owner | cache-primed second call made no extra Identity call | 19 | 19 | PASS |
| 305 | POST | /api/consultations | patient | book-while-identity-down-never-waits | 201 | 201 | PASS |
| 306 | POST | /api/consultations | patient | suspension-fixture-book-09:00 | 201 | 201 | PASS |
| 307 | POST | /api/consultations | patient | suspension-fixture-book-09:30 | 201 | 201 | PASS |
| 308 | POST | /api/consultations | patient | suspension-fixture-book-10:00 | 201 | 201 | PASS |
| 309 | PATCH | /api/consultations/225/cancel | patient | suspension-fixture-cancel-one | 200 | 200 | PASS |
| 310 | PATCH | /api/admin/doctors/603/suspend | admin | suspend-doctor-flags-consultations | 200 | 200 | PASS |
| 311 | check | followup | owner | flagged rows: doctor_suspended, status unchanged (never cancelled) | 2 booked | 2 booked | PASS |
| 312 | check | followup | owner | cancelled and completed rows were not flagged | 0 | 0 | PASS |
| 313 | check | audit | owner | consultation.flagged_for_followup audit rows written (ids only) | 1 | 1 | PASS |
| 314 | POST | /api/consultations | patient | book-suspended-doctor-blocked | 409 DoctorNotBookable | 409 DoctorNotBookable | PASS |
| 315 | PATCH | /api/consultations/223/cancel | doctor | cancel-by-locally-suspended-doctor | 403 Forbidden | 403 Forbidden | PASS |
| 316 | GET | /api/consultations/223 | doctor | suspended-doctor-can-still-read-own | 200 | 200 | PASS |
| 317 | GET | /api/patients/585 | doctor-suspended | patient-profile-suspended-doctor | 403 Forbidden | 403 Forbidden | PASS |
| 318 | GET | /api/consultations?needsAdminFollowup=true&doctorUserId=603 | admin | followup-queue-lists-flagged-rows | 200 | 200 | PASS |
| 319 | GET | /api/consultations?needsAdminFollowup=true&doctorUserId=603&status=cancelled | admin | followup-queue-intersects-status-filter | 200 | 200 | PASS |
| 320 | PATCH | /api/consultations/223/reschedule | admin | reschedule-flagged-row-on-suspended-doctor | 409 DoctorNotBookable | 409 DoctorNotBookable | PASS |
| 321 | PATCH | /api/consultations/223/cancel | admin | admin-cancels-flagged-row | 200 | 200 | PASS |
| 322 | GET | /api/consultations?needsAdminFollowup=true&doctorUserId=603 | admin | followup-queue-drops-cancelled-row | 200 | 200 | PASS |
| 323 | GET | /api/consultations?needsAdminFollowup=false&doctorUserId=603&scope=all&limit=100 | admin | followup-false-filter | 200 | 200 | PASS |
| 324 | POST | /api/consultations | patient | block-fixture-day28-A | 201 | 201 | PASS |
| 325 | POST | /api/consultations | patient | block-fixture-day28-B | 201 | 201 | PASS |
| 326 | POST | /api/consultations | patient | block-fixture-day29 | 201 | 201 | PASS |
| 327 | POST | /api/consultations | patient | block-fixture-day30-custom | 201 | 201 | PASS |
| 328 | PUT | /api/doctors/me/working-hours | doctor | hours-removal-without-confirm-lists-real-ids | 409 ScheduleConflictsUnconfirmed | 409 ScheduleConflictsUnconfirmed | PASS |
| 329 | check | followup | owner | unconfirmed block flagged nothing | 0 | 0 | PASS |
| 330 | PUT | /api/doctors/me/working-hours | doctor | hours-removal-with-confirm-applies | 200 | 200 | PASS |
| 331 | check | followup | owner | confirmed block flags the two day-28 rows schedule_blocked, others untouched, none cancelled | 2 booked | 2 booked | PASS |
| 332 | check | followup | owner | unaffected rows not flagged | 0 | 0 | PASS |
| 333 | check | outbox | owner | schedule_blocked queued to each affected patient | 2 588,589 | 2 588,589 | PASS |
| 334 | check | audit | owner | schedule.conflicts_confirmed audited | 1 | 1 | PASS |
| 335 | GET | /api/consultations/227 | doctor | flagged-row-visible-to-doctor | 200 | 200 | PASS |
| 336 | POST | /api/doctors/me/exceptions | doctor | exception-day-off-unconfirmed | 409 ScheduleConflictsUnconfirmed | 409 ScheduleConflictsUnconfirmed | PASS |
| 337 | POST | /api/doctors/me/exceptions | doctor | exception-day-off-confirmed | 201 | 201 | PASS |
| 338 | check | followup | owner | day_off flagged the day-29 row | schedule_blocked | schedule_blocked | PASS |
| 339 | POST | /api/doctors/me/exceptions | doctor | exception-custom-hours-uncovering-unconfirmed | 409 ScheduleConflictsUnconfirmed | 409 ScheduleConflictsUnconfirmed | PASS |
| 340 | POST | /api/doctors/me/exceptions | doctor | exception-custom-hours-covering-booking-no-conflict | 201 | 201 | PASS |
| 341 | check | followup | owner | covering custom hours flags nothing | false | false | PASS |
| 342 | PATCH | /api/consultations/227/reschedule | patient | reschedule-flagged-row-clears-flag | 200 | 200 | PASS |
| 343 | PATCH | /api/patients/me | patient | setup-profile-590 | 200 | 200 | PASS |
| 344 | GET | /api/patients/590 | doctor | patient-profile-no-relationship | 404 NotFound | 404 NotFound | PASS |
| 345 | GET | /api/patients/590 | doctor | patient-profile-relationship-cancelled | 404 NotFound | 404 NotFound | PASS |
| 346 | GET | /api/patients/590 | doctor | patient-profile-relationship-no_show | 404 NotFound | 404 NotFound | PASS |
| 347 | GET | /api/patients/590 | doctor | patient-profile-relationship-booked | 200 | 200 | PASS |
| 348 | check | audit | owner | related-doctor read audited | 1 | 1 | PASS |
| 349 | GET | /api/patients/590 | doctor | patient-profile-only-cancelled-after-booked-cancelled | 404 NotFound | 404 NotFound | PASS |
| 350 | GET | /api/patients/590 | doctor | patient-profile-relationship-waiting | 200 | 200 | PASS |
| 351 | GET | /api/patients/590 | doctor | patient-profile-relationship-in_progress | 200 | 200 | PASS |
| 352 | GET | /api/patients/590 | doctor | patient-profile-relationship-completed | 200 | 200 | PASS |
| 353 | GET | /api/patients/590 | patient-self | patient-profile-self-590 | 200 | 200 | PASS |
| 354 | POST | /api/consultations | patient | malformed-json-body-no-store | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 355 | check | no-store | owner | malformed JSON on /api/consultations carries Cache-Control: no-store | 1 | 1 | PASS |
| 356 | PATCH | /api/patients/me | patient | malformed-json-patients-no-store | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 357 | check | no-store | owner | malformed JSON on /api/patients carries Cache-Control: no-store | 1 | 1 | PASS |
| 358 | check | request-id | owner | non-UUID incoming X-Request-Id is replaced by a generated UUID | 1 | 1 | PASS |
| 359 | check | headers | owner | helmet header present on consultations responses | 1 | 1 | PASS |
| 360 | check | grants | owner | vcare_app on consultations: select,insert,update yes, delete no | true true true false | true true true false | PASS |
| 361 | check | grants | owner | vcare_app on notification_outbox: select,insert yes, update,delete no | true true false false | true true false false | PASS |
| 362 | check | db | owner | direct overlapping INSERT rejected by excl_consultations_doctor_no_overlap (23P01) | 1 | 1 | PASS |
| 363 | check | db | owner | no live overlapping pair exists in fixtures | 0 | 0 | PASS |
| 364 | check | db | owner | every booked consultation duration equals its type duration | 0 | 0 | PASS |
| 365 | check | privacy | owner | audit metadata holds no complaint or reason marker | 0 | 0 | PASS |
| 366 | check | privacy | owner | outbox payloads hold no complaint or reason marker | 0 | 0 | PASS |
| 367 | check | privacy | owner | audit metadata keys on consultation rows are flat scalars from the allowed set | 0 | 0 | PASS |
| 368 | check | logs | owner | care-api log has no complaint/reason markers, tokens, hydrated names | 0 | 0 | PASS |
| 369 | check | logs | owner | care-api log has no level=error line | 0 | 0 | PASS |
| 370 | check | logs | owner | identity degradation is logged without user data | 1 | 1 | PASS |
| 371 | POST | /api/consultations | patient | ratelimit-fixture-book | 201 | 201 | PASS |
| 372 | check | rate-limit | owner | writes 1..9 in the window pass the limiter (8 validation 400s after one booking) | 1 | 1 | PASS |
| 373 | check | rate-limit | owner | the 10th write (reschedule, shared bucket) is still allowed (400 validation) | 400 | 400 | PASS |
| 374 | PATCH | /api/consultations/238/cancel | patient | write-11th-limited-shared-bucket | 429 RateLimited | 429 RateLimited | PASS |
| 375 | check | rate-limit | owner | Retry-After present on 429 | 1 | 1 | PASS |
| 376 | POST | /api/consultations | patient | write-limit-is-per-user | 201 | 201 | PASS |
| 377 | GET | /api/consultations | patient | reads-not-blocked-by-write-limit | 200 | 200 | PASS |
| 378 | check | rate-limit | owner | admin: 60 writes pass the limiter (own bucket) | 1 | 1 | PASS |
| 379 | PATCH | /api/consultations/238/cancel | admin | admin-write-61st-limited | 429 RateLimited | 429 RateLimited | PASS |
| 380 | check | rate-limit | owner | first 120 reads in the window all 200 | 1 | 1 | PASS |
| 381 | GET | /api/consultations | patient | read-121st-limited | 429 RateLimited | 429 RateLimited | PASS |
| 382 | check | rate-limit | owner | Retry-After present on read 429 | 1 | 1 | PASS |
| 383 | GET | /api/consultations/238 | patient | get-one-non-owner-404-precedes-read-limiter | 404 NotFound | 404 NotFound | PASS (script corrected) |
| 384 | check | audit | owner | 429 reads wrote no consultation.read row | 0 | 0 | PASS |

## Failures / notes

No product failure. One script defect: the last HTTP read row (383) originally expected `429 RateLimited` for `GET /api/consultations/{id}` by a patient who does not own the row; Care answers `404 NotFound` because ownership (`authorize`) runs before the read limiter, which matches the spec's chain (`userGuard -> authorize -> limiter`). The script now asserts the 404 (`get-one-non-owner-404-precedes-read-limiter`); the read limiter itself is proven on the list route (rows 380-382). Earlier script defects fixed during the session: `node -e` treating a negative day offset as an option, `psql ... RETURNING` echoing the command tag into an id, an overlapping owner-SQL fixture, expected literal `f` vs `false`, a UTC-based date window, a UTC instant that is on the Berlin grid, and a wrong outbox payload key list.

Observations (not failures):
- Retrying a cancel with a **new** key returns `409 InvalidTransition` (the spec accepts this); with the same key it replays the original 200.
- Six parallel same-key bookings produced one row; responses were only `201` (original or replay) or `409 Conflict` with `Retry-After: 1`.
- With Redis flushed, a same-key replay is served from the DB row (`uq_consultations_idempotency` + `request_hash`) and a different body gives `422 IdempotencyConflict`.
- Case 2: Identity `down`, `hang` (2 s client timeout) and `slow` (1 s, inside the timeout) all answered `200` for list and get-one; down/hang returned `profileHydrated:false`, `displayName:null`; slow hydrated; booking while Identity was down was unaffected. One batched Identity call per page; the request id was forwarded; page 2 hit the Redis cache.
- Suspension through `PATCH /api/admin/doctors/{id}/suspend` flagged only future `booked` rows (`doctor_suspended`), never cancelled or moved them, returned their ids, blocked new bookings (`DoctorNotBookable`) and doctor cancels (`403 Forbidden`); the suspended doctor can still read own rows but gets `403` on `GET /patients/{id}`. Schedule blocks without `confirmConflicts` listed real ids and flagged nothing; with it the rows were flagged `schedule_blocked` and `schedule_blocked` outbox rows queued; a reschedule cleared the flag.
- Outbox payload keys seen: `startsAt`, `endsAt`, `previousStartsAt`, `byRole`, `recipientRole` only; no text. Audit metadata is flat scalars with no complaint or reason text (cancel and reschedule store `reasonLength` only).
- Admin views never carry `complaintText`; list items carry it for no viewer; `GET /patients/{id}` is `403` for admin with no audit row.
- `GET /api/consultations/waiting-room` and `/calendar` (sessions unit) are not mounted and were not tested.

Not verified: a real Identity (fake only), outbox delivery and reminders (separate unit), the production build, the Redis-down fallback limiter, and the `schedules.test.ts` "query plans" ioredis timeout (the jest suites were not run in this session, so whether it recurs is unknown).
