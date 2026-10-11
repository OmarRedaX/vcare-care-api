---
title: patients — Manual QA (CURL)
owner: care-team
service: care-service
module: patients
status: verified
diataxis: how-to
last_verified: 2026-10-11
tags: [patients, manual-qa, curl, rbac, validation, audit, no-store, rate-limit, clinical-privacy]
related: [patients-spec, patients-tasks, patients-brainstorm, schedules-manual-qa, api, quickstart]
---

# patients — Manual QA (CURL)

_Run: 2026-10-11 • Server: http://127.0.0.1:3041 • Result: 135 pass / 0 fail_

## Environment

The real Care HTTP listener (`npx tsx src/server.ts`, `NODE_ENV=development`, public port 3041, internal 3141) ran against a throwaway database `care_qa_test` created on the docker test stack Postgres (`127.0.0.1:5434`, extensions `btree_gist`, `citext`), migrated with the repo CLI (`src/migrate.ts latest`, then `ensure-app-login`, so the app connected as `care_app`, not the owner). Redis was the docker test stack on `127.0.0.1:6381`, db index 14 (flushed at the start of each script run). Storage was pointed at a dead endpoint (`http://127.0.0.1:9`); the patients slice makes no storage or Identity call. The database was dropped afterwards.

**Tokens.** Identity was not running. `scripts/patients-qa-fake-identity.mjs` (derived from the schedules fake) generated an in-memory Ed25519 keypair, served its public key as a JWKS at `http://127.0.0.1:3022/.well-known/jwks.json` (Care's `IDENTITY_JWKS_URL`) and minted short-lived EdDSA tokens (`iss=vcare-identity`, `aud=[vcare-identity, vcare-care]`, 15 min) for: active patients 301-311, patient tokens with status `pending`/`rejected`/`suspended`, an active patient with `ev=false`, doctors (active, pending, rejected), admin, an expired token, and a `typ=service` token. Care verified them through its normal JWKS path. No key or token is stored or printed.

**Method.** Every call sent a fresh UUID `X-Request-Id`; each row checks status, `success`, `error.code`, `error.requestId` equal to the sent id, a `details` array on errors, the echoed `X-Request-Id` header and `Cache-Control: no-store` (except the two parser-level rows noted below), plus a case-specific shape assertion (the `PatientProfile` key set equals the contract `required` list). Owner SQL was used only to assert rows, audit rows and grants, to soft-delete one row, and to reset fixtures before and after. Clinical-looking values are clearly synthetic markers (`TEST-ALLERGEN-*`, `SENTINEL*`); they appear only in requests and were asserted absent from error bodies, audit metadata and the care-api log. No token or response body is recorded here.

Re-run: start the two processes as in the header of `scripts/curl-test-patients.sh`, then
`CARE_OWNER_DATABASE_URL=postgres://<owner>@127.0.0.1:5434/care_qa_test REDIS_URL=redis://127.0.0.1:6381/14 SERVER_LOG=<care-api log> bash scripts/curl-test-patients.sh` (about 3 minutes, mostly one write-limiter sleep window and the two rate-limit loops). The script refuses a database whose name does not end in `_test`.

## Endpoints covered

`GET /api/patients/me` and `PATCH /api/patients/me`. Roles: patient (active; owner), other patient (non-owner), patient token `pending`/`rejected`/`suspended`, unverified-email patient, doctor (active/pending/rejected), admin, unauthenticated, malformed/expired/wrong-type token. The doctor-facing `/api/patients/{id}` operations are out of scope (not mounted).

## Cases

Rows with method `check` are non-HTTP assertions (owner SQL, response headers, equality of two values); their Path column is the check scope.

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 1 | GET | /api/patients/me | none | unauthenticated | 401 Unauthorized | 401 Unauthorized | PASS |
| 2 | GET | /api/patients/me | patient | malformed-token | 401 Unauthorized | 401 Unauthorized | PASS |
| 3 | GET | /api/patients/me | patient | expired-token | 401 TokenExpired | 401 TokenExpired | PASS |
| 4 | GET | /api/patients/me | service | token-typ-service-not-a-user-token | 401 Unauthorized | 401 Unauthorized | PASS |
| 5 | GET | /api/patients/me | doctor | wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 6 | GET | /api/patients/me | doctor-pending | wrong-role-pending | 403 Forbidden | 403 Forbidden | PASS |
| 7 | GET | /api/patients/me | doctor-rejected | wrong-role-rejected | 403 Forbidden | 403 Forbidden | PASS |
| 8 | GET | /api/patients/me | admin | wrong-role-admin-denied | 403 Forbidden | 403 Forbidden | PASS |
| 9 | GET | /api/patients/me | patient-pending | token-status-pending | 403 Forbidden | 403 Forbidden | PASS |
| 10 | GET | /api/patients/me | patient-rejected | token-status-rejected | 403 Forbidden | 403 Forbidden | PASS |
| 11 | GET | /api/patients/me | patient-suspended | token-status-suspended | 403 Forbidden | 403 Forbidden | PASS |
| 12 | PATCH | /api/patients/me | none | unauthenticated | 401 Unauthorized | 401 Unauthorized | PASS |
| 13 | PATCH | /api/patients/me | patient | malformed-token | 401 Unauthorized | 401 Unauthorized | PASS |
| 14 | PATCH | /api/patients/me | patient | expired-token | 401 TokenExpired | 401 TokenExpired | PASS |
| 15 | PATCH | /api/patients/me | service | token-typ-service-not-a-user-token | 401 Unauthorized | 401 Unauthorized | PASS |
| 16 | PATCH | /api/patients/me | doctor | wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 17 | PATCH | /api/patients/me | doctor-pending | wrong-role-pending | 403 Forbidden | 403 Forbidden | PASS |
| 18 | PATCH | /api/patients/me | doctor-rejected | wrong-role-rejected | 403 Forbidden | 403 Forbidden | PASS |
| 19 | PATCH | /api/patients/me | admin | wrong-role-admin-denied | 403 Forbidden | 403 Forbidden | PASS |
| 20 | PATCH | /api/patients/me | patient-pending | token-status-pending | 403 Forbidden | 403 Forbidden | PASS |
| 21 | PATCH | /api/patients/me | patient-rejected | token-status-rejected | 403 Forbidden | 403 Forbidden | PASS |
| 22 | PATCH | /api/patients/me | patient-suspended | token-status-suspended | 403 Forbidden | 403 Forbidden | PASS |
| 23 | GET | /api/patients/me | admin | spoofed-X-User-Id-X-Role-patient-ignored | 403 Forbidden | 403 Forbidden | PASS |
| 24 | PATCH | /api/patients/me | admin | spoofed-X-Role-patient-ignored | 403 Forbidden | 403 Forbidden | PASS |
| 25 | check | rbac | owner | no profile row created by any denied call | 0 | 0 | PASS |
| 26 | check | audit | owner | denied/unauthenticated calls wrote no patient_profile audit row | 0 | 0 | PASS |
| 27 | GET | /api/patients/me | patient | no-profile-yet | 404 NotFound | 404 NotFound | PASS |
| 28 | check | audit | owner | 404 GET writes no audit row | 0 | 0 | PASS |
| 29 | PATCH | /api/patients/me | patient | create-without-timezone | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 30 | check | db | owner | rejected create writes no row | 0 | 0 | PASS |
| 31 | PATCH | /api/patients/me | patient | empty-object-body | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 32 | PATCH | /api/patients/me | patient | no-body-at-all | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 33 | PATCH | /api/patients/me | patient | create-with-timezone-only | 200 | 200 | PASS |
| 34 | check | audit | owner | create writes one patient_profile.updated audit row (created=true) | 1 | 1 | PASS |
| 35 | check | audit | owner | audit request_id equals the sent X-Request-Id | 1 | 1 | PASS |
| 36 | GET | /api/patients/me | patient | read-back | 200 | 200 | PASS |
| 37 | check | audit | owner | GET 200 writes one patient_profile.read row (metadata patientUserId only) | 1 | 1 | PASS |
| 38 | PATCH | /api/patients/me | patient | partial-update-keeps-untouched | 200 | 200 | PASS |
| 39 | PATCH | /api/patients/me | patient | set-arrays-and-dob | 200 | 200 | PASS |
| 40 | PATCH | /api/patients/me | patient | arrays-replaced-whole | 200 | 200 | PASS |
| 41 | PATCH | /api/patients/me | patient | empty-array-clears | 200 | 200 | PASS |
| 42 | PATCH | /api/patients/me | patient | null-clears-scalars | 200 | 200 | PASS |
| 43 | PATCH | /api/patients/me | patient | set-two-ordered-items | 200 | 200 | PASS |
| 44 | PATCH | /api/patients/me | patient | noop-same-values-200 | 200 | 200 | PASS |
| 45 | check | db | owner | no-op PATCH leaves updated_at unchanged | 2026-10-11 20:12:26.686283+00 | 2026-10-11 20:12:26.686283+00 | PASS |
| 46 | check | audit | owner | no-op PATCH writes no audit row | 7 | 7 | PASS |
| 47 | PATCH | /api/patients/me | patient | reordered-array-is-a-change | 200 | 200 | PASS |
| 48 | check | audit | owner | real change audited with changedFields=allergies | 1 | 1 | PASS |
| 49 | PATCH | /api/patients/me | patient | idempotency-key-ignored-first | 200 | 200 | PASS |
| 50 | PATCH | /api/patients/me | patient | idempotency-key-ignored-diff-body-no-422 | 200 | 200 | PASS |
| 51 | PATCH | /api/patients/me | patient | idempotency-key-same-key-different-body-still-200 | 200 | 200 | PASS |
| 52 | PATCH | /api/patients/me | patient | timezone-change-canonical | 200 | 200 | PASS |
| 53 | PATCH | /api/patients/me | patient | identity-headers-ignored | 200 | 200 | PASS |
| 54 | GET | /api/patients/me | patient-unverified | unverified-email-allowed-reads | 404 NotFound | 404 NotFound | PASS |
| 55 | PATCH | /api/patients/me | patient-unverified | unverified-email-allowed-writes | 200 | 200 | PASS |
| 56 | GET | /api/patients/me | patient | get-final-state | 200 | 200 | PASS |
| 57 | check | db | owner | exactly one live row per patient | 1 | 1 | PASS |
| 58 | check | audit | owner | every write has one audit row: patient 301 update rows == real changes (create plus each real change) | 13 | 13 | PASS |
| 59 | check | audit | owner | audit metadata holds no clinical value | 0 | 0 | PASS |
| 60 | check | audit | owner | audit metadata keys are only created/changedFields/patientUserId | 0 | 0 | PASS |
| 61 | PATCH | /api/patients/me | patient | setup-profile | 200 | 200 | PASS |
| 62 | PATCH | /api/patients/me | patient | unknown-member-userId | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 63 | PATCH | /api/patients/me | patient | unknown-member-id | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 64 | PATCH | /api/patients/me | patient | unknown-member-fullName | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 65 | PATCH | /api/patients/me | patient | unknown-member-diagnosis | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 66 | PATCH | /api/patients/me | patient | timezone-null | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 67 | PATCH | /api/patients/me | patient | allergies-null | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 68 | PATCH | /api/patients/me | patient | chronic-null | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 69 | PATCH | /api/patients/me | patient | timezone-invalid-zone | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 70 | PATCH | /api/patients/me | patient | timezone-not-string | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 71 | PATCH | /api/patients/me | patient | timezone-65-chars | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 72 | PATCH | /api/patients/me | patient | gender-invalid | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 73 | PATCH | /api/patients/me | patient | gender-not-string | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 74 | PATCH | /api/patients/me | patient | blood-type-invalid | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 75 | PATCH | /api/patients/me | patient | blood-type-lowercase | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 76 | PATCH | /api/patients/me | patient | allergies-not-array | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 77 | PATCH | /api/patients/me | patient | allergies-51-items | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 78 | PATCH | /api/patients/me | patient | chronic-51-items | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 79 | PATCH | /api/patients/me | patient | allergy-item-201-chars | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 80 | PATCH | /api/patients/me | patient | allergy-item-empty | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 81 | PATCH | /api/patients/me | patient | allergy-item-blank | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 82 | PATCH | /api/patients/me | patient | allergy-item-not-string | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 83 | PATCH | /api/patients/me | patient | allergy-item-control-char | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 84 | PATCH | /api/patients/me | patient | allergy-duplicate-items | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 85 | PATCH | /api/patients/me | patient | chronic-duplicate-items | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 86 | PATCH | /api/patients/me | patient | chronic-blank-item | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 87 | PATCH | /api/patients/me | patient | dob-impossible-date | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 88 | PATCH | /api/patients/me | patient | dob-wrong-format | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 89 | PATCH | /api/patients/me | patient | dob-with-time | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 90 | PATCH | /api/patients/me | patient | dob-number | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 91 | PATCH | /api/patients/me | patient | dob-in-future | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 92 | PATCH | /api/patients/me | patient | body-is-array | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 93 | PATCH | /api/patients/me | patient | body-is-string | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 94 | check | no-store | owner | scalar-JSON-body 400 carries Cache-Control: no-store (spec 3.1) | 1 | 1 | PASS |
| 95 | PATCH | /api/patients/me | patient | body-is-number | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 96 | PATCH | /api/patients/me | patient | malformed-json | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 97 | check | no-store | owner | malformed-JSON 400 carries Cache-Control: no-store (spec 3.1) | 1 | 1 | PASS |
| 98 | check | db | owner | all 400 cases left the profile untouched | ab4106c0b955501586d8590d0313772e | ab4106c0b955501586d8590d0313772e | PASS |
| 99 | PATCH | /api/patients/me | patient | allergies-exactly-50-ok | 200 | 200 | PASS |
| 100 | PATCH | /api/patients/me | patient | item-exactly-200-chars-ok | 200 | 200 | PASS |
| 101 | PATCH | /api/patients/me | patient | multibyte-200-code-points-ok | 200 | 200 | PASS |
| 102 | PATCH | /api/patients/me | patient | case-differing-items-are-not-duplicates | 200 | 200 | PASS |
| 103 | PATCH | /api/patients/me | patient | dob-today-ok | 200 | 200 | PASS |
| 104 | PATCH | /api/patients/me | patient | dob-leap-day-ok | 200 | 200 | PASS |
| 105 | PATCH | /api/patients/me | patient | dob-non-leap-day-rejected | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 106 | PATCH | /api/patients/me | patient | other-patient-creates-own | 200 | 200 | PASS |
| 107 | GET | /api/patients/me | patient | other-patient-sees-only-own | 200 | 200 | PASS |
| 108 | GET | /api/patients/me | patient | first-patient-unaffected | 200 | 200 | PASS |
| 109 | PATCH | /api/patients/me | patient | body-userId-cannot-redirect-write | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 110 | check | db | owner | patient 301 row not touched by patient 302 attempts | undisclosed | undisclosed | PASS |
| 111 | check | concurrency | owner | six parallel first PATCHes all answer 200 | 200 200 200 200 200 200 | 200 200 200 200 200 200 | PASS |
| 112 | check | concurrency | owner | exactly one live row after the race | 1 | 1 | PASS |
| 113 | check | concurrency | owner | no 500 body in the race (all success envelopes) | 6 | 6 | PASS |
| 114 | check | audit | owner | race: one audit row per real write (rows with created=true == 1) | 1 | 1 | PASS |
| 115 | PATCH | /api/patients/me | patient | kiritimati-local-today-accepted | 200 | 200 | PASS |
| 116 | PATCH | /api/patients/me | patient | kiritimati-local-tomorrow-rejected | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 117 | PATCH | /api/patients/me | patient | create-with-future-dob-rejected-no-row | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 118 | check | db | owner | rejected create-with-future-dob wrote no row | 0 | 0 | PASS |
| 119 | GET | /api/patients/me | patient | soft-deleted-profile-is-404 | 404 NotFound | 404 NotFound | PASS |
| 120 | PATCH | /api/patients/me | patient | new-live-row-after-soft-delete | 200 | 200 | PASS |
| 121 | check | db | owner | soft-deleted row kept, one new live row | 2 1 | 2 1 | PASS |
| 122 | check | grants | owner | vcare_app has no DELETE on patient_profiles | false | false | PASS |
| 123 | check | grants | owner | vcare_app has SELECT, INSERT, UPDATE on patient_profiles | true true true | true true true | PASS |
| 124 | check | logs | owner | care-api log has no clinical fixture strings | 0 | 0 | PASS |
| 125 | check | logs | owner | care-api log has no level=error line | 0 | 0 | PASS |
| 126 | check | rate-limit | owner | first 20 PATCHes in the window all 200 | 1 | 1 | PASS |
| 127 | PATCH | /api/patients/me | patient | write-21st-limited | 429 RateLimited | 429 RateLimited | PASS |
| 128 | check | rate-limit | owner | Retry-After present on 429 | 1 | 1 | PASS |
| 129 | PATCH | /api/patients/me | patient | write-limit-is-per-user | 200 | 200 | PASS |
| 130 | PATCH | /api/patients/me | patient | setup-for-read-limit | 200 | 200 | PASS |
| 131 | check | rate-limit | owner | first 120 GETs in the window all 200 | 1 | 1 | PASS |
| 132 | GET | /api/patients/me | patient | read-121st-limited | 429 RateLimited | 429 RateLimited | PASS |
| 133 | check | rate-limit | owner | Retry-After present on 429 | 1 | 1 | PASS |
| 134 | check | audit | owner | GET audit rows == successful GETs for patient 306 (120) | 120 | 120 | PASS |
| 135 | check | rate-limit | owner | a 429 GET is not audited and PATCH limit does not block reads | 1 | 1 | PASS |

## Failures / notes

No product failure in the final run. The first run (133 pass / 2 fail) found that parser-level 400s (malformed JSON, bare scalar JSON body) lacked `Cache-Control: no-store` because the global body parser answered before the route-level `noStore()`; fixed in `src/app.ts` (noStore for `/api/patients` before the JSON body parser) and re-run on 2026-10-11 with the scalar-body header check enabled for all three body cases (rows 93-97 now pass, including the explicit no-store rows 94 and 97). Earlier script defects (item length off by one, shell `t/f` rendering of grant checks) were QA-script bugs, fixed.

Observations (not failures):
- The unverified-email patient (`ev=false`) can read (404 until created) and write, as the spec requires (only booking needs a verified email).
- Same `Idempotency-Key` with a different body on PATCH is ignored (200, 200), not 422, as the contract declares no idempotency on this route.
- A re-ordered allergy list is a change (audited with `changedFields=allergies`); an identical list, even with a differently-cased timezone spelling, is a no-op (no write, no audit, `updated_at` unchanged).
- `timezone` is stored canonical (`europe/berlin` is stored and returned as `Europe/Berlin`).
- `dateOfBirth` is judged in the effective timezone: the patient's local today in `Pacific/Kiritimati` (UTC+14) is accepted, local tomorrow rejected, a create with a future date writes no row.
- Six parallel first-time PATCHes of one patient all answered 200, left exactly one live row and exactly one `created=true` audit row.
- 20 PATCHes then the 21st returned `429 RateLimited` with `Retry-After`; 120 GETs then the 121st returned 429; the limits are per user (another patient was unaffected); each of the 120 successful GETs wrote exactly one `patient_profile.read` row and the 429 wrote none.
- Audit `metadata` keys across the run were only `created`, `changedFields`, `patientUserId`; no clinical value, no date of birth, no gender. The care-api log for the whole run contained no fixture string, no `Bearer` text and no `level=error` line.
- A soft-deleted profile reads as 404 and does not block a new live row for the same user; `vcare_app` has `SELECT, INSERT, UPDATE` and no `DELETE` on `patient_profiles`.

Not verified: the rollback-on-audit-failure path (unit-tested); behaviour against a real Identity (fake JWKS only); the production build (`dist/`); the Redis-down fallback limiter.
