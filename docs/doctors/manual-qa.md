---
title: doctors — Manual QA (CURL)
owner: care-team
service: care-service
module: doctors
status: verified
diataxis: how-to
last_verified: 2026-10-07
tags: [doctors, manual-qa, curl, rbac, validation, idempotency]
related: [doctors-spec, doctors-tasks, api, quickstart]
---

# Doctors — Manual QA (CURL)

_Run: 2026-10-07 • Server: http://127.0.0.1:3015 • Result: 38 pass / 0 fail_

## Environment

The real Care HTTP listener ran against disposable `care_test` Postgres (`5434`) and Redis (`6381`, database 9), with migrations already applied. `scripts/doctors-qa-fake-identity.mjs` served an in-memory EdDSA JWKS and short-lived synthetic patient, pending/active/rejected doctor, and admin tokens. Every HTTP case used `curl.exe`, a bearer token where appropriate, and a fresh UUID `X-Request-Id`. The QA fixture specialties and doctor profiles were removed after the run. No token or response body was saved in this report.

The reusable `scripts/curl-test-doctors.sh` expresses the same matrix for POSIX shells. Git Bash could not initialize in this Windows sandbox (`CreateFileMapping` access denied), so this recorded run used an equivalent temporary PowerShell driver that invoked `curl.exe` for every request. The shell script itself was not executed here.

## Cases

Each success row checked `success: true`, the required contract response fields, and the echoed request ID. Each error row checked HTTP status, `success: false`, `error.code`, `error.message`, `error.details`, `error.requestId`, and the echoed header. `own` means the `DoctorProfileOwn` field set; `application` means the `VerificationApplication` field set. The replay comparison used the full `data` object.

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|---|---|---|---|---|---|---|
| 1 | POST | /api/doctors/apply | none | unauthenticated | 401 Unauthorized | 401 Unauthorized | PASS |
| 2 | POST | /api/doctors/apply | patient | wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 3 | POST | /api/doctors/apply | admin | wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 4 | GET | /api/doctors/me | none | unauthenticated | 401 Unauthorized | 401 Unauthorized | PASS |
| 5 | GET | /api/doctors/me | patient | wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 6 | GET | /api/doctors/me | admin | wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 7 | PATCH | /api/doctors/me | none | unauthenticated | 401 Unauthorized | 401 Unauthorized | PASS |
| 8 | PATCH | /api/doctors/me | patient | wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 9 | PATCH | /api/doctors/me | admin | wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 10 | GET | /api/doctors/me/application | none | unauthenticated | 401 Unauthorized | 401 Unauthorized | PASS |
| 11 | GET | /api/doctors/me/application | patient | wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 12 | GET | /api/doctors/me/application | admin | wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 13 | GET | /api/doctors/me | doctor | expired | 401 TokenExpired | 401 TokenExpired | PASS |
| 14 | GET | /api/doctors/me | doctor | absent-other-doctor | 404 NotFound | 404 NotFound | PASS |
| 15 | GET | /api/doctors/me/application | doctor | absent-other-application | 404 NotFound | 404 NotFound | PASS |
| 16 | PATCH | /api/doctors/me | doctor | absent-profile | 404 NotFound | 404 NotFound | PASS |
| 17 | POST | /api/doctors/apply | doctor | create-draft | 201 own | 201 | PASS |
| 18 | GET | /api/doctors/me | doctor | own-profile | 200 own | 200 | PASS |
| 19 | GET | /api/doctors/me/application | doctor | own-application | 200 application | 200 | PASS |
| 20 | GET | /api/doctors/me | doctor | non-owner-isolation | 404 NotFound | 404 NotFound | PASS |
| 21 | POST | /api/doctors/apply | doctor | replace-draft | 200 own | 200 | PASS |
| 22 | PATCH | /api/doctors/me | doctor | update-headline | 200 own | 200 | PASS |
| 23 | PATCH | /api/doctors/me | doctor | empty-body | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 24 | PATCH | /api/doctors/me | doctor | invalid-timezone | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 25 | PATCH | /api/doctors/me | doctor | unknown-property | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 26 | POST | /api/doctors/apply | doctor | submit-needs-documents | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 27 | POST | /api/doctors/apply | doctor | unknown-specialty | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 28 | POST | /api/doctors/apply | doctor | currency-not-allowed | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 29 | POST | /api/doctors/apply | doctor | body-userId-forbidden | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 30 | POST | /api/doctors/apply | doctor | idempotent-first | 201 own | 201 | PASS |
| 31 | POST | /api/doctors/apply | doctor | idempotent-replay | 201 own | 201 | PASS |
| 32 | POST | /api/doctors/apply | doctor | replay-data-equal | equal | equal | PASS |
| 33 | POST | /api/doctors/apply | doctor | idempotent-conflict | 422 IdempotencyConflict | 422 IdempotencyConflict | PASS |
| 34 | POST | /api/doctors/apply | doctor | rejected-doctor-can-apply | 201 own | 201 | PASS |
| 35 | PATCH | /api/doctors/me | doctor | locally-suspended-blocked | 403 Forbidden | 403 Forbidden | PASS |
| 36 | GET | /api/doctors/me | doctor | locally-suspended-readable | 200 own | 200 | PASS |
| 37 | POST | /api/doctors/apply | doctor | submitted-conflict | 409 Conflict | 409 Conflict | PASS |
| 38 | PATCH | /api/doctors/me | doctor | rate-limit | 429 RateLimited | 429 RateLimited | PASS |

## Failures / notes

- No application failures found in 37 HTTP cases and one replay-data comparison (38 checks total).
- Pagination is not applicable: this doctors slice has no list endpoint. `GET /api/doctors` belongs to the later availability module.
- The `submit=true` path currently requires documents and returned `400 ValidationFailed`, as specified for this slice. Document uploads and admin review belong to the verification module.
- The `429` check used the rejected doctor's separate write limit after 20 requests in the one-minute window.
- The local suspension check changed only a synthetic test profile through the owner connection, then restored it. `PATCH /api/doctors/me` returned `403 Forbidden`, while `GET /api/doctors/me` stayed readable.
- The first harness attempt pointed Care at the wrong fake JWKS port and produced only `401` responses. After correcting the port and restarting Care, readiness reported `identityJwks: up`; the 38-case run above is the valid result.

## Re-run

1. Start the disposable test Postgres and Redis services and apply migrations to `care_test`.
2. Start `FAKE_IDENTITY_PORT=3021 node scripts/doctors-qa-fake-identity.mjs`.
3. Start Care with `DATABASE_URL` for `care_app` on `care_test`, `REDIS_URL` for the test Redis, and `IDENTITY_JWKS_URL=http://127.0.0.1:3021/.well-known/jwks.json`. Verify `/api/health/ready` reports `identityJwks: up`.
4. Set `CARE_OWNER_DATABASE_URL` to the disposable `care_test` owner URL. Optionally set `CARE_URL` and `FAKE_IDENTITY_URL`; then run `bash scripts/curl-test-doctors.sh`. The script checks its database name, removes its synthetic fixtures, and prints pass/fail counts.
5. Stop Care and the fake Identity process.
