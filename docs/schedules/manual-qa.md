---
title: schedules — Manual QA (CURL)
owner: care-team
service: care-service
module: schedules
status: verified
diataxis: how-to
last_verified: 2026-10-09
tags: [schedules, manual-qa, curl, rbac, validation, idempotency, rate-limit, dst, consultation-types, working-hours, exceptions]
related: [schedules-spec, schedules-tasks, schedules-brainstorm, doctors-manual-qa, api, quickstart]
---

# schedules — Manual QA (CURL)

_Run: 2026-10-09 • Server: http://127.0.0.1:3031 • Result: 220 pass / 0 fail_

## Environment

The real Care HTTP listener (`npx tsx src/server.ts`, `NODE_ENV=development`, public port 3031, internal 3131) ran against a throwaway database `care_qa_test` created on the local Postgres 18 cluster (`127.0.0.1:5434`, extensions `btree_gist`, `citext`), migrated with the repo CLI (`src/migrate.ts latest` then `ensure-app-login`, so the app connected as `care_app`, not the owner). Redis was Memurai on `localhost:6379` db index 13 (flushed at the start of each script run). `ALLOWED_CURRENCIES=EGP,USD` was set so that a currency that is allowed but differs from the profile currency (`USD` vs `EGP`) can be told apart from a currency that is not allowed at all (`GBP`).

**Tokens.** Identity was not running. `scripts/schedules-qa-fake-identity.mjs` (derived from the doctors QA fake) generated an in-memory Ed25519 keypair, served its public key as a JWKS at `http://127.0.0.1:3021/.well-known/jwks.json` (Care's `IDENTITY_JWKS_URL` pointed at it) and minted short-lived EdDSA user tokens on demand (`iss=vcare-identity`, `aud=[vcare-identity, vcare-care]`, `typ=user`, `ev=true`, 15 min) for: patient 101, admin 1, doctor tokens with status `pending` (202) and `rejected` (203), an expired doctor token, and `active` doctors 201, 204-211. Care verified them through its normal JWKS path. No key or token is stored or printed.

**Object storage.** MinIO was unavailable. The schedules slice makes no storage call; Care boots and serves every case with `STORAGE_ENDPOINT=http://127.0.0.1:9` (nothing listening) and dummy credentials, and `/api/health/ready` stays 200.

**Fixtures.** One draft doctor profile per doctor was created through the real `POST /api/doctors/apply` route (EGP; timezone Africa/Cairo, Europe/Berlin for 206, Pacific/Kiritimati for 211). Owner SQL was used only to approve a profile (`isBookable` check), to set and clear local suspension, to assert audit and soft-delete rows, and to reset the fixture rows before and after the run. Doctors are split over several user ids so that no one doctor trips the 30 writes/min limiter except in the deliberate rate-limit cases (207); the script also sleeps one window if a doctor nears the limit. Every call sent a fresh UUID `X-Request-Id`; the response header was compared for each case. Every error row checked HTTP status, `success=false`, `error.code`, `error.message`, a `details` array and `error.requestId` equal to the sent id; every success row checked `success=true` plus a case-specific shape assertion (e.g. weekdays sorted, `24:00` round trip, no extra fields). No token or response body is recorded here. Clinical text does not exist in this module; free text used (`SYNTHETIC-REASON-4417`, `Synthetic Visit ...`) is synthetic.

Re-run: start the two processes as in the header of `scripts/curl-test-schedules.sh`, then
`CARE_OWNER_DATABASE_URL=postgres://<owner>@127.0.0.1:5434/care_qa_test REDIS_URL=redis://localhost:6379/13 SERVER_LOG=<care-api log> bash scripts/curl-test-schedules.sh` (about 4 minutes, mostly the two rate-limit loops and one window sleep). The script refuses a database whose name does not end in `_test`.

## Endpoints covered

All eight schedules operations (contract C1-C6) plus the doctors `isBookable` flip: `GET/PUT /api/doctors/me/working-hours`, `GET/POST /api/doctors/me/exceptions`, `DELETE /api/doctors/me/exceptions/{id}` (with `confirmConflicts`), `GET/POST /api/doctors/me/consultation-types`, `PATCH /api/doctors/me/consultation-types/{id}`, and `GET /api/doctors/me` (`isBookable`). Roles: doctor (owner), other doctor (non-owner), active doctor without a profile, doctor token `pending`/`rejected`, patient, admin, unauthenticated, expired token, locally suspended doctor.

## Cases

Rows with method `check` are non-HTTP assertions (owner SQL, response headers, equality of two responses). `Expected`/`Got` for those rows are the compared values.

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 1 | GET | /api/doctors/me/working-hours | none | unauthenticated | 401 Unauthorized | 401 Unauthorized | PASS |
| 2 | GET | /api/doctors/me/working-hours | patient | wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 3 | GET | /api/doctors/me/working-hours | admin | wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 4 | GET | /api/doctors/me/working-hours | doctor-pending | token-status-pending | 403 Forbidden | 403 Forbidden | PASS |
| 5 | GET | /api/doctors/me/working-hours | doctor-rejected | token-status-rejected | 403 Forbidden | 403 Forbidden | PASS |
| 6 | GET | /api/doctors/me/working-hours | doctor-no-profile | active-doctor-without-profile | 404 NotFound | 404 NotFound | PASS |
| 7 | PUT | /api/doctors/me/working-hours | none | unauthenticated | 401 Unauthorized | 401 Unauthorized | PASS |
| 8 | PUT | /api/doctors/me/working-hours | patient | wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 9 | PUT | /api/doctors/me/working-hours | admin | wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 10 | PUT | /api/doctors/me/working-hours | doctor-pending | token-status-pending | 403 Forbidden | 403 Forbidden | PASS |
| 11 | PUT | /api/doctors/me/working-hours | doctor-rejected | token-status-rejected | 403 Forbidden | 403 Forbidden | PASS |
| 12 | PUT | /api/doctors/me/working-hours | doctor-no-profile | active-doctor-without-profile | 404 NotFound | 404 NotFound | PASS |
| 13 | GET | /api/doctors/me/exceptions | none | unauthenticated | 401 Unauthorized | 401 Unauthorized | PASS |
| 14 | GET | /api/doctors/me/exceptions | patient | wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 15 | GET | /api/doctors/me/exceptions | admin | wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 16 | GET | /api/doctors/me/exceptions | doctor-pending | token-status-pending | 403 Forbidden | 403 Forbidden | PASS |
| 17 | GET | /api/doctors/me/exceptions | doctor-rejected | token-status-rejected | 403 Forbidden | 403 Forbidden | PASS |
| 18 | GET | /api/doctors/me/exceptions | doctor-no-profile | active-doctor-without-profile | 404 NotFound | 404 NotFound | PASS |
| 19 | POST | /api/doctors/me/exceptions | none | unauthenticated | 401 Unauthorized | 401 Unauthorized | PASS |
| 20 | POST | /api/doctors/me/exceptions | patient | wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 21 | POST | /api/doctors/me/exceptions | admin | wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 22 | POST | /api/doctors/me/exceptions | doctor-pending | token-status-pending | 403 Forbidden | 403 Forbidden | PASS |
| 23 | POST | /api/doctors/me/exceptions | doctor-rejected | token-status-rejected | 403 Forbidden | 403 Forbidden | PASS |
| 24 | POST | /api/doctors/me/exceptions | doctor-no-profile | active-doctor-without-profile | 404 NotFound | 404 NotFound | PASS |
| 25 | DELETE | /api/doctors/me/exceptions/1 | none | unauthenticated | 401 Unauthorized | 401 Unauthorized | PASS |
| 26 | DELETE | /api/doctors/me/exceptions/1 | patient | wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 27 | DELETE | /api/doctors/me/exceptions/1 | admin | wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 28 | DELETE | /api/doctors/me/exceptions/1 | doctor-pending | token-status-pending | 403 Forbidden | 403 Forbidden | PASS |
| 29 | DELETE | /api/doctors/me/exceptions/1 | doctor-rejected | token-status-rejected | 403 Forbidden | 403 Forbidden | PASS |
| 30 | DELETE | /api/doctors/me/exceptions/1 | doctor-no-profile | active-doctor-without-profile | 404 NotFound | 404 NotFound | PASS |
| 31 | GET | /api/doctors/me/consultation-types | none | unauthenticated | 401 Unauthorized | 401 Unauthorized | PASS |
| 32 | GET | /api/doctors/me/consultation-types | patient | wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 33 | GET | /api/doctors/me/consultation-types | admin | wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 34 | GET | /api/doctors/me/consultation-types | doctor-pending | token-status-pending | 403 Forbidden | 403 Forbidden | PASS |
| 35 | GET | /api/doctors/me/consultation-types | doctor-rejected | token-status-rejected | 403 Forbidden | 403 Forbidden | PASS |
| 36 | GET | /api/doctors/me/consultation-types | doctor-no-profile | active-doctor-without-profile | 404 NotFound | 404 NotFound | PASS |
| 37 | POST | /api/doctors/me/consultation-types | none | unauthenticated | 401 Unauthorized | 401 Unauthorized | PASS |
| 38 | POST | /api/doctors/me/consultation-types | patient | wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 39 | POST | /api/doctors/me/consultation-types | admin | wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 40 | POST | /api/doctors/me/consultation-types | doctor-pending | token-status-pending | 403 Forbidden | 403 Forbidden | PASS |
| 41 | POST | /api/doctors/me/consultation-types | doctor-rejected | token-status-rejected | 403 Forbidden | 403 Forbidden | PASS |
| 42 | POST | /api/doctors/me/consultation-types | doctor-no-profile | active-doctor-without-profile | 404 NotFound | 404 NotFound | PASS |
| 43 | PATCH | /api/doctors/me/consultation-types/1 | none | unauthenticated | 401 Unauthorized | 401 Unauthorized | PASS |
| 44 | PATCH | /api/doctors/me/consultation-types/1 | patient | wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 45 | PATCH | /api/doctors/me/consultation-types/1 | admin | wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 46 | PATCH | /api/doctors/me/consultation-types/1 | doctor-pending | token-status-pending | 403 Forbidden | 403 Forbidden | PASS |
| 47 | PATCH | /api/doctors/me/consultation-types/1 | doctor-rejected | token-status-rejected | 403 Forbidden | 403 Forbidden | PASS |
| 48 | PATCH | /api/doctors/me/consultation-types/1 | doctor-no-profile | active-doctor-without-profile | 404 NotFound | 404 NotFound | PASS |
| 49 | GET | /api/doctors/me/working-hours | doctor | expired-token | 401 TokenExpired | 401 TokenExpired | PASS |
| 50 | GET | /api/doctors/me/working-hours | patient | spoofed-X-User-Id-ignored | 403 Forbidden | 403 Forbidden | PASS |
| 51 | GET | /api/doctors/me/working-hours | doctor | empty-set | 200 | 200 | PASS |
| 52 | PUT | /api/doctors/me/working-hours | doctor | split-shift-and-24:00-sorted-output | 200 | 200 | PASS |
| 53 | GET | /api/doctors/me/working-hours | doctor | read-back-equals-put | 200 | 200 | PASS |
| 54 | PUT | /api/doctors/me/working-hours | doctor | identical-set-is-noop | 200 | 200 | PASS |
| 55 | check | /api/doctors/me/working-hours | doctor | no-op PUT writes no audit row | 35 | 35 | PASS |
| 56 | PUT | /api/doctors/me/working-hours | doctor | idempotency-key-ignored-first | 200 | 200 | PASS |
| 57 | PUT | /api/doctors/me/working-hours | doctor | idempotency-key-ignored-different-body-no-422 | 200 | 200 | PASS |
| 58 | PUT | /api/doctors/me/working-hours | doctor | touching-intervals-allowed | 200 | 200 | PASS |
| 59 | PUT | /api/doctors/me/working-hours | doctor | confirmConflicts-true-accepted-no-conflicts | 200 | 200 | PASS |
| 60 | PUT | /api/doctors/me/working-hours | doctor | duplicate-weekday | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 61 | PUT | /api/doctors/me/working-hours | doctor | weekday-8 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 62 | PUT | /api/doctors/me/working-hours | doctor | weekday-0 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 63 | PUT | /api/doctors/me/working-hours | doctor | overlapping-intervals | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 64 | PUT | /api/doctors/me/working-hours | doctor | end-equals-start | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 65 | PUT | /api/doctors/me/working-hours | doctor | end-before-start | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 66 | PUT | /api/doctors/me/working-hours | doctor | 24:00-as-start | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 67 | PUT | /api/doctors/me/working-hours | doctor | bad-time-format | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 68 | PUT | /api/doctors/me/working-hours | doctor | time-25:00 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 69 | PUT | /api/doctors/me/working-hours | doctor | seven-intervals-one-day | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 70 | PUT | /api/doctors/me/working-hours | doctor | empty-intervals-array | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 71 | PUT | /api/doctors/me/working-hours | doctor | eight-day-entries | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 72 | PUT | /api/doctors/me/working-hours | doctor | unknown-member | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 73 | PUT | /api/doctors/me/working-hours | doctor | days-missing | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 74 | PUT | /api/doctors/me/working-hours | doctor | weekday-as-string | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 75 | PUT | /api/doctors/me/working-hours | doctor | confirmConflicts-not-boolean | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 76 | PUT | /api/doctors/me/working-hours | doctor | days-null | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 77 | GET | /api/doctors/me/working-hours | doctor | unchanged-after-400s | 200 | 200 | PASS |
| 78 | PUT | /api/doctors/me/working-hours | doctor | empty-days-clears-all | 200 | 200 | PASS |
| 79 | GET | /api/doctors/me/exceptions | doctor | empty-list | 200 | 200 | PASS |
| 80 | POST | /api/doctors/me/exceptions | doctor | day-off-single-date | 201 | 201 | PASS |
| 81 | POST | /api/doctors/me/exceptions | doctor | duplicate-date-409 | 409 Conflict | 409 Conflict | PASS |
| 82 | POST | /api/doctors/me/exceptions | doctor | day-off-range-3-dates | 201 | 201 | PASS |
| 83 | POST | /api/doctors/me/exceptions | doctor | range-overlapping-existing-409-whole-request | 409 Conflict | 409 Conflict | PASS |
| 84 | GET | /api/doctors/me/exceptions | doctor | nothing-created-by-rejected-range | 200 | 200 | PASS |
| 85 | POST | /api/doctors/me/exceptions | doctor | custom-hours-one-date | 201 | 201 | PASS |
| 86 | POST | /api/doctors/me/exceptions | doctor | custom-hours-with-endDate | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 87 | POST | /api/doctors/me/exceptions | doctor | custom-hours-missing-times | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 88 | POST | /api/doctors/me/exceptions | doctor | custom-hours-end-not-after-start | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 89 | POST | /api/doctors/me/exceptions | doctor | day-off-with-times | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 90 | POST | /api/doctors/me/exceptions | doctor | endDate-before-date | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 91 | POST | /api/doctors/me/exceptions | doctor | range-61-dates | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 92 | POST | /api/doctors/me/exceptions | doctor | range-60-dates-allowed | 201 | 201 | PASS |
| 93 | POST | /api/doctors/me/exceptions | doctor | past-date-3-days-ago | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 94 | POST | /api/doctors/me/exceptions | doctor | yesterday | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 95 | POST | /api/doctors/me/exceptions | doctor | range-starting-in-past | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 96 | POST | /api/doctors/me/exceptions | doctor | today-allowed | 201 | 201 | PASS |
| 97 | POST | /api/doctors/me/exceptions | doctor | impossible-calendar-date | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 98 | POST | /api/doctors/me/exceptions | doctor | malformed-date | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 99 | POST | /api/doctors/me/exceptions | doctor | reason-501-chars | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 100 | POST | /api/doctors/me/exceptions | doctor | reason-null | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 101 | POST | /api/doctors/me/exceptions | doctor | unknown-type | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 102 | POST | /api/doctors/me/exceptions | doctor | unknown-member-doctorId | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 103 | POST | /api/doctors/me/exceptions | doctor | confirmConflicts-not-boolean | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 104 | POST | /api/doctors/me/exceptions | doctor | confirmConflicts-true-accepted | 201 | 201 | PASS |
| 105 | POST | /api/doctors/me/exceptions | doctor | idempotent-first | 201 | 201 | PASS |
| 106 | POST | /api/doctors/me/exceptions | doctor | idempotent-replay-same-status-and-body | 201 | 201 | PASS |
| 107 | check | /api/doctors/me/exceptions | doctor | replay body equals original | equal | equal | PASS |
| 108 | POST | /api/doctors/me/exceptions | doctor | idempotent-conflict-different-body | 422 IdempotencyConflict | 422 IdempotencyConflict | PASS |
| 109 | POST | /api/doctors/me/exceptions | doctor | idempotency-key-not-uuid | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 110 | GET | /api/doctors/me/exceptions?fromDate=2027-01-17&toDate=2027-01-17 | doctor | replay-created-exactly-one-row | 200 | 200 | PASS |
| 111 | GET | /api/doctors/me/exceptions?limit=2 | doctor | page-1-limit-2 | 200 | 200 | PASS |
| 112 | GET | /api/doctors/me/exceptions?limit=2&cursor=WyIyMDI2LTEwLTE0IiwzMDld | doctor | page-2-via-cursor | 200 | 200 | PASS |
| 113 | GET | /api/doctors/me/exceptions?fromDate=2026-10-19&toDate=2026-10-21 | doctor | date-window-filter | 200 | 200 | PASS |
| 114 | GET | /api/doctors/me/exceptions?fromDate=2026-10-21&toDate=2026-10-19 | doctor | fromDate-after-toDate | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 115 | GET | /api/doctors/me/exceptions?fromDate=2099-13-40 | doctor | bad-fromDate | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 116 | GET | /api/doctors/me/exceptions?limit=0 | doctor | limit-0 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 117 | GET | /api/doctors/me/exceptions?limit=101 | doctor | limit-101 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 118 | GET | /api/doctors/me/exceptions?cursor=not-a-cursor | doctor | malformed-cursor | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 119 | GET | /api/doctors/me/exceptions?fromDate=2026-10-04&limit=100 | doctor | earlier-fromDate-includes-today | 200 | 200 | PASS |
| 120 | GET | /api/doctors/me/exceptions | doctor | non-owner-sees-only-own | 200 | 200 | PASS |
| 121 | DELETE | /api/doctors/me/exceptions/309 | doctor | non-owner-delete-is-404 | 404 NotFound | 404 NotFound | PASS |
| 122 | DELETE | /api/doctors/me/exceptions/309?confirmConflicts=maybe | doctor | confirmConflicts-not-boolean | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 123 | DELETE | /api/doctors/me/exceptions/309 | doctor | delete-day-off | 204 | 204 | PASS |
| 124 | DELETE | /api/doctors/me/exceptions/309 | doctor | repeat-delete-already-deleted | 404 NotFound | 404 NotFound | PASS |
| 125 | DELETE | /api/doctors/me/exceptions/abc | doctor | non-numeric-id | 404 NotFound | 404 NotFound | PASS |
| 126 | DELETE | /api/doctors/me/exceptions/0 | doctor | id-zero | 404 NotFound | 404 NotFound | PASS |
| 127 | DELETE | /api/doctors/me/exceptions/99999999 | doctor | absent-id | 404 NotFound | 404 NotFound | PASS |
| 128 | DELETE | /api/doctors/me/exceptions/315?confirmConflicts=true | doctor | delete-custom-hours-confirm-true | 204 | 204 | PASS |
| 129 | GET | /api/doctors/me/exceptions?fromDate=2026-10-14&toDate=2026-10-14 | doctor | deleted-row-no-longer-listed | 200 | 200 | PASS |
| 130 | POST | /api/doctors/me/exceptions | doctor | date-reusable-after-soft-delete | 201 | 201 | PASS |
| 131 | check | /api/doctors/me/exceptions | doctor | soft delete keeps the row (deleted_at set) | 1 | 1 | PASS |
| 132 | PUT | /api/doctors/me/working-hours | doctor | weekly-hours-split-at-gap-minute | 200 | 200 | PASS |
| 133 | GET | /api/doctors/me/working-hours | doctor | dst-hours-roundtrip-wall-clock | 200 | 200 | PASS |
| 134 | POST | /api/doctors/me/exceptions | doctor | custom-hours-inside-spring-forward-gap | 201 | 201 | PASS |
| 135 | POST | /api/doctors/me/exceptions | doctor | custom-hours-in-autumn-repeated-hour | 201 | 201 | PASS |
| 136 | POST | /api/doctors/me/exceptions | doctor | day-off-range-across-autumn-transition | 201 | 201 | PASS |
| 137 | GET | /api/doctors/me/exceptions?fromDate=2026-10-25&toDate=2026-10-25 | doctor | dst-exception-listed-on-its-local-date | 200 | 200 | PASS |
| 138 | POST | /api/doctors/me/exceptions | doctor | local-today-in-UTC+14-accepted | 201 | 201 | PASS |
| 139 | POST | /api/doctors/me/exceptions | doctor | local-yesterday-in-UTC+14-rejected | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 140 | GET | /api/doctors/me/consultation-types | doctor | empty-list | 200 | 200 | PASS |
| 141 | GET | /api/doctors/me | doctor | isBookable-false-before-any-type | 200 | 200 | PASS |
| 142 | POST | /api/doctors/me/consultation-types | doctor | create-type | 201 | 201 | PASS |
| 143 | POST | /api/doctors/me/consultation-types | doctor | duplicate-name-409 | 409 Conflict | 409 Conflict | PASS |
| 144 | POST | /api/doctors/me/consultation-types | doctor | price-zero-allowed | 201 | 201 | PASS |
| 145 | POST | /api/doctors/me/consultation-types | doctor | price-max-and-duration-240-allowed | 201 | 201 | PASS |
| 146 | POST | /api/doctors/me/consultation-types | doctor | name-1-char | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 147 | POST | /api/doctors/me/consultation-types | doctor | name-whitespace-only | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 148 | POST | /api/doctors/me/consultation-types | doctor | name-101-chars | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 149 | POST | /api/doctors/me/consultation-types | doctor | name-control-character | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 150 | POST | /api/doctors/me/consultation-types | doctor | duration-4 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 151 | POST | /api/doctors/me/consultation-types | doctor | duration-241 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 152 | POST | /api/doctors/me/consultation-types | doctor | duration-fractional | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 153 | POST | /api/doctors/me/consultation-types | doctor | duration-string | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 154 | POST | /api/doctors/me/consultation-types | doctor | price-negative | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 155 | POST | /api/doctors/me/consultation-types | doctor | price-over-int32 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 156 | POST | /api/doctors/me/consultation-types | doctor | currency-allowed-but-not-profile-currency-USD | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 157 | POST | /api/doctors/me/consultation-types | doctor | currency-not-allowed-GBP | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 158 | POST | /api/doctors/me/consultation-types | doctor | currency-lowercase | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 159 | POST | /api/doctors/me/consultation-types | doctor | currency-missing | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 160 | POST | /api/doctors/me/consultation-types | doctor | unknown-member-isActive | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 161 | POST | /api/doctors/me/consultation-types | doctor | idempotent-first | 201 | 201 | PASS |
| 162 | POST | /api/doctors/me/consultation-types | doctor | idempotent-replay | 201 | 201 | PASS |
| 163 | check | /api/doctors/me/consultation-types | doctor | replay body equals original | equal | equal | PASS |
| 164 | POST | /api/doctors/me/consultation-types | doctor | idempotent-conflict-different-body | 422 IdempotencyConflict | 422 IdempotencyConflict | PASS |
| 165 | GET | /api/doctors/me/consultation-types | doctor | list-has-exactly-one-idempotent-row | 200 | 200 | PASS |
| 166 | GET | /api/doctors/me/consultation-types?limit=2 | doctor | page-1-limit-2 | 200 | 200 | PASS |
| 167 | GET | /api/doctors/me/consultation-types?limit=2&cursor=WzYzLDYzXQ | doctor | page-2-via-cursor | 200 | 200 | PASS |
| 168 | GET | /api/doctors/me/consultation-types?limit=0 | doctor | limit-0 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 169 | GET | /api/doctors/me/consultation-types?limit=101 | doctor | limit-101 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 170 | GET | /api/doctors/me/consultation-types?cursor=garbage | doctor | malformed-cursor | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 171 | GET | /api/doctors/me/consultation-types?isActive=maybe | doctor | isActive-not-boolean | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 172 | PATCH | /api/doctors/me/consultation-types/61 | doctor | change-price | 200 | 200 | PASS |
| 173 | PATCH | /api/doctors/me/consultation-types/61 | doctor | rename-and-duration | 200 | 200 | PASS |
| 174 | PATCH | /api/doctors/me/consultation-types/61 | doctor | noop-same-values | 200 | 200 | PASS |
| 175 | PATCH | /api/doctors/me/consultation-types/61 | doctor | currency-same-as-profile | 200 | 200 | PASS |
| 176 | PATCH | /api/doctors/me/consultation-types/61 | doctor | currency-USD-mismatch | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 177 | PATCH | /api/doctors/me/consultation-types/61 | doctor | empty-body | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 178 | PATCH | /api/doctors/me/consultation-types/61 | doctor | null-member | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 179 | PATCH | /api/doctors/me/consultation-types/61 | doctor | isActive-as-string | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 180 | PATCH | /api/doctors/me/consultation-types/61 | doctor | unknown-member | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 181 | PATCH | /api/doctors/me/consultation-types/61 | doctor | duplicate-name-409 | 409 Conflict | 409 Conflict | PASS |
| 182 | PATCH | /api/doctors/me/consultation-types/61 | doctor | non-owner-patch | 404 NotFound | 404 NotFound | PASS |
| 183 | PATCH | /api/doctors/me/consultation-types/99999999 | doctor | absent-id | 404 NotFound | 404 NotFound | PASS |
| 184 | PATCH | /api/doctors/me/consultation-types/abc | doctor | non-numeric-id | 404 NotFound | 404 NotFound | PASS |
| 185 | GET | /api/doctors/me/consultation-types | doctor | non-owner-list-excludes-foreign-types | 200 | 200 | PASS |
| 186 | GET | /api/doctors/me | doctor | isBookable-true-with-active-type | 200 | 200 | PASS |
| 187 | GET | /api/doctors/me | doctor | isBookable-false-after-deactivating-last-active-type | 200 | 200 | PASS |
| 188 | GET | /api/doctors/me/consultation-types?isActive=false | doctor | filter-inactive | 200 | 200 | PASS |
| 189 | GET | /api/doctors/me/consultation-types?isActive=true | doctor | filter-active-empty | 200 | 200 | PASS |
| 190 | PATCH | /api/doctors/me/consultation-types/61 | doctor | reactivate | 200 | 200 | PASS |
| 191 | GET | /api/doctors/me | doctor | isBookable-true-after-reactivation | 200 | 200 | PASS |
| 192 | check | /api/doctors/me/consultation-types | doctor | twenty live types created | 20 | 20 | PASS |
| 193 | POST | /api/doctors/me/consultation-types | doctor | 21st-type-409 | 409 Conflict | 409 Conflict | PASS |
| 194 | PATCH | /api/doctors/me/consultation-types/66 | doctor | deactivate-one-of-20 | 200 | 200 | PASS |
| 195 | POST | /api/doctors/me/consultation-types | doctor | 21st-still-409-inactive-types-count | 409 Conflict | 409 Conflict | PASS |
| 196 | GET | /api/doctors/me/consultation-types?limit=10 | doctor | cap-doctor-page-1 | 200 | 200 | PASS |
| 197 | GET | /api/doctors/me/consultation-types?limit=10&cursor=Wzc1LDc1XQ | doctor | cap-doctor-page-2-last | 200 | 200 | PASS |
| 198 | check | audit-logs | owner | hours_replaced audit rows exist for doctor 201 | 1 | 1 | PASS |
| 199 | check | audit-logs | owner | one consultation_type.created audit row per created type (doctor 208) | 20 | 20 | PASS |
| 200 | check | audit-logs | owner | free text never in audit metadata | 0 | 0 | PASS |
| 201 | check | server-log | observer | free text never in the care-api log | 0 | 0 | PASS |
| 202 | check | /api/doctors/me/working-hours | doctor | two concurrent PUTs both answer 200 | 200 200 | 200 200 | PASS |
| 203 | check | /api/doctors/me/working-hours | doctor | live set is exactly one request set (2 or 3 weekdays, no mix) | 1 | 1 | PASS |
| 204 | GET | /api/doctors/me/working-hours | doctor | locally-suspended | 403 Forbidden | 403 Forbidden | PASS |
| 205 | PUT | /api/doctors/me/working-hours | doctor | locally-suspended | 403 Forbidden | 403 Forbidden | PASS |
| 206 | GET | /api/doctors/me/exceptions | doctor | locally-suspended | 403 Forbidden | 403 Forbidden | PASS |
| 207 | POST | /api/doctors/me/exceptions | doctor | locally-suspended | 403 Forbidden | 403 Forbidden | PASS |
| 208 | DELETE | /api/doctors/me/exceptions/1 | doctor | locally-suspended | 403 Forbidden | 403 Forbidden | PASS |
| 209 | GET | /api/doctors/me/consultation-types | doctor | locally-suspended | 403 Forbidden | 403 Forbidden | PASS |
| 210 | POST | /api/doctors/me/consultation-types | doctor | locally-suspended | 403 Forbidden | 403 Forbidden | PASS |
| 211 | PATCH | /api/doctors/me/consultation-types/1 | doctor | locally-suspended | 403 Forbidden | 403 Forbidden | PASS |
| 212 | GET | /api/doctors/me/working-hours | doctor | reinstated-readable-again | 200 | 200 | PASS |
| 213 | check | /api/doctors/me/working-hours | doctor | first 120 reads in the window all 200 | 1 | 1 | PASS |
| 214 | GET | /api/doctors/me/working-hours | doctor | read-121st-limited | 429 RateLimited | 429 RateLimited | PASS |
| 215 | check | /api/doctors/me/working-hours | doctor | Retry-After present on 429 | 1 | 1 | PASS |
| 216 | check | /api/doctors/me/working-hours | doctor | first 30 writes in the window all 200 | 1 | 1 | PASS |
| 217 | PUT | /api/doctors/me/working-hours | doctor | write-31st-limited | 429 RateLimited | 429 RateLimited | PASS |
| 218 | check | /api/doctors/me/working-hours | doctor | Retry-After present on 429 | 1 | 1 | PASS |
| 219 | POST | /api/doctors/me/exceptions | doctor | write-limit-covers-exceptions | 429 RateLimited | 429 RateLimited | PASS |
| 220 | POST | /api/doctors/me/consultation-types | doctor | write-limit-covers-types | 429 RateLimited | 429 RateLimited | PASS |

## Failures / notes

No product failure. The first four execution attempts exposed defects in the QA script only (fixed, not product bugs): a CRLF in `psql` output breaking a loop, a file-append race between two background curls, and audit-row counts that accumulated across runs.

Observations (not failures):
- The default `ScheduleImpactProvider` never reports affected consultations (the `consultations` module does not exist yet), so `409 ScheduleConflictsUnconfirmed` and the `schedule.conflicts_confirmed` audit row cannot be provoked over HTTP. Only the acceptance of `confirmConflicts=true` (PUT, POST, DELETE) and the strict `confirmConflicts` boolean (400 on a non-boolean) were verified here.
- Working-hours PUT and the other undeclared-idempotency writes ignore `Idempotency-Key` as the spec says (same key with a different body is 200, not 422).
- DST: weekly hours and exceptions are stored as doctor-local wall clock, so spring-forward gap times (02:15-03:45) and the autumn repeated hour (02:30-02:45) are accepted and listed on their local date. The resolution of those instants is `pkg/slots` territory (unit-tested) and has no HTTP surface in this slice; it was not exercised through slots endpoints (none exist yet).
- Validation `details[].issue` strings from class-validator defaults repeat the constraint text (for example `currency must match /^[A-Z]{3}$/ regular expression`); they never echo the submitted value.
- Care log (info level) for the whole run contained no `SYNTHETIC-REASON`, type name or token text, and no `level=error` line.

Not verified: the in-flight duplicate `Idempotency-Key` path (`409 Conflict` + `Retry-After: 1`, needs a deterministic race); the Redis-down fallback limiter; behaviour on a real Identity (fake JWKS only); the production build (`dist/`); the 5 ms `resolveOpenIntervals` budget (unit-level `test.failing`, see tasks.md).
