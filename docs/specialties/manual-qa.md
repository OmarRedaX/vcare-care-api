---
title: specialties — Manual QA (CURL)
owner: care-team
service: care-service
module: specialties
status: passed
diataxis: how-to
last_verified: 2026-10-04
tags: [manual-qa, curl, specialties, catalog, rbac, pagination, keyset, idempotency, rate-limit, audit, compiled-build]
related: [specialties-spec, specialties-tasks, specialties-brainstorm, access-manual-qa, rbac, api]
contracts: [contracts/openapi.yaml]
---

# specialties — Manual QA (CURL)

_Run: 2026-10-04 • Server: http://localhost:3001 (real Identity tokens), http://localhost:3012 (fake-identity tokens),
http://localhost:3011 (compiled build) • Result: 199 pass / 0 fail / 0 skipped (script run 3; run 1 had 2 and run 2 had 1 failure, all
three defects of the script's own assertions, none in the product, see "Notes")_

Expected values come from `contracts/openapi.yaml` (`listSpecialties`, `createSpecialty`, `updateSpecialty`,
`Specialty`, `PaginationMeta`, `ErrorEnvelope`), spec §9.2 (RBAC matrix), §9.5 (manual QA and the compiled-build #8
check), §4 (S-R1 to S-R17) and §13.1 (S1 to S4). Every enveloped response was checked for `success`, `error.code`,
`error.requestId` equal to the sent `X-Request-Id`, and the echoed `X-Request-Id` header. Every success body was
checked for exactly the contract `Specialty` key set.

## Environment

| Component | Where | Notes |
|---|---|---|
| Identity (real, `feature/auth`) + worker | public `:3020`, internal `:3120` | `EMAIL_PROVIDER=capture`; registration codes read from its capture mailbox |
| Care api (source, `tsx`) | public `:3001`, internal `:3101` | `IDENTITY_JWKS_URL` is Identity's JWKS; log captured to a file for the hygiene checks |
| Care api, edge instance (source, `tsx`) | `:3012` | started and stopped by the script; `IDENTITY_JWKS_URL` is the fake identity |
| Fake identity (`scripts/access-qa-fake-identity.ts`) | `127.0.0.1:3021` | mints claim-level tokens (suspended, expired, wrong `aud`, service-typed, unknown `kid`) |
| Care api, **compiled build** | `:3011` | `npm run build`, then `node --env-file=.env dist/server.js`; started and stopped by the script |
| Data | native Postgres `:5432` DB `vcare_care` (app role `care_app`; owner role for assertions), native Redis `:6379` DB 1 | migrations incl. `specialties` + 20-row seed applied |

**QA accounts** are synthetic (`qa.specialties.<role>@example.test`). Patient and doctor were created through
Identity's real `register/start` -> emailed code -> `register/complete`; the admin was registered as a patient and then
promoted in Identity's database. The status variants (patient active, unverified, pending; doctor pending, rejected,
active; admin active, pending) are set in Identity's database right before each real login. Identity refuses to log
in **suspended** accounts, so the suspended principals (patient, doctor, admin) use fake-identity tokens against the
`:3012` instance. That needed one new case, `admin-suspended`, in the dev-only `scripts/access-qa-fake-identity.ts`
(no `src/` change). No token, password, cookie, or email address is recorded here or in any file.

Test data: every run creates its own uniquely named rows (`QA Spec <epoch> ...`) and deactivates them on exit
(the table is never deleted from), so reruns are independent. Catalog after the run: 35 rows, 20 active (the seed).

## Re-run

```bash
# Identity running (+ its worker on the very first run); Care api on :3001 against it.
QA_PASSWORD='<synthetic>' \
IDENTITY_DATABASE_URL='postgres://<identity user>:<pw>@localhost:5432/vcare_identity' \
CARE_LOG_FILE=/path/to/care-3001.log \
  ./scripts/curl-test-specialties.sh     # exits non-zero on any failure; builds/starts/stops :3011 and :3012 itself
```
Needs `psql` and `redis-cli` or `memurai-cli` on `PATH`. Identity limits login to 5/min per IP and email. The script
clears the `rl:specialties-list-*` Redis keys between sections so the per-IP 60/min limiter never skews unrelated
cases. `START_COMPILED=0` / `START_EDGE=0` skip the corresponding sections.

## Cases

The script prints one line per case (`PASS`/`FAIL`, expected, got); the table groups them by area with the counts
from run 3. Role is the token principal.

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 1 | SQL | specialties | owner | seed catalog: the 20 starter slugs present | 20 | 20 | pass |
| 2-9 | GET | /api/specialties | none, patient (active, unverified), doctor (active, pending, rejected), admin | RBAC read matrix, S4 | 401 / 200 x7 with `Specialty` keys | as expected | pass |
| 10-11 | GET | /api/specialties | patient pending, admin pending | non-active account | 403 `Forbidden` | as expected | pass |
| 12-27 | POST | /api/specialties | none, patient, doctor active/pending/rejected, patient pending, admin pending, + `X-Role: admin` spoof | RBAC write matrix | 401 `Unauthorized` / 403 `Forbidden`; no row created | as expected | pass |
| 28-37 | PATCH | /api/specialties/{id} | none, patient, doctor x3, pending patient/admin; patient on `/abc` | RBAC; role is checked before the id | 401 / 403 | as expected | pass |
| 38-39 | POST, GET | /api/specialties | patient (tampered role), bad bearer | forged / malformed token | 401 `Unauthorized` | as expected | pass |
| 2b (14) | GET, POST, PATCH | /api/specialties | suspended patient / doctor / admin (fake identity); unknown-`kid`, expired, wrong-`aud`, service-typed tokens; valid edge patient | suspended principals, token edge cases | 403 `Forbidden`; 401 `Unauthorized`; 401 `TokenExpired`; 200 | as expected | pass |
| POST (41) | POST | /api/specialties | admin | create A with key: 201, `isActive` true, one audit row (actor, `specialty.created`, entity, `{}`) | 201, one row, one audit row | as expected | pass |
| | POST | /api/specialties | admin | replay same key and body: 201 same id, one row, one audit row (S-R14) | 201 same id | as expected | pass |
| | POST | /api/specialties | admin | same key, different body | 422 `IdempotencyConflict` | 422 | pass |
| | POST | /api/specialties | admin | `Idempotency-Key: nope`; no key (optional) twice | 400 `ValidationFailed`; 201 then 409 | as expected | pass |
| | POST | /api/specialties | admin | duplicate slug / name / seeded name (Cardiology): `details[0].field`, no audit row (S-R1, S-R10) | 409 `Conflict` | as expected | pass |
| | POST | /api/specialties | admin | lower-cased name is a different name (D3); 100-char name + 2000-char description boundary | 201 | as expected | pass |
| | POST | /api/specialties | admin | two parallel creates of one slug (S-R17) | one 201, one 409, one row | as expected | pass |
| | POST | /api/specialties | admin | 17 invalid bodies: `{}`, name 1/101 chars/number, slug missing/`Bad_Slug`/`-a`/`a--b`/`a-`/101 chars, description 2001/null, `isActive`, `id`, unknown member, `[]`, malformed JSON | 400 `ValidationFailed`; no row created | as expected | pass |
| GET (33) | GET | /api/specialties | patient | default list: 200, `meta.hasMore` true, `count` 20; `limit=1` | 200 | as expected | pass |
| | GET | /api/specialties | patient, admin, doctor | 16 invalid queries: `limit` 0, 101, 1.5, `1e1`, `05`, ` 5`, `abc`, -1; `cursor` junk/601 chars/numeric sort value/101-char name/tampered; unknown member; `includeInactive` `yes`, `1`, `TRUE`, empty, repeated | 400 `ValidationFailed`, `details[0].field` names the member | as expected | pass |
| | GET | /api/specialties | patient | page through all active rows, `limit=7` and default 20: ids equal the database `(name, id)` order, no duplicate, last page `nextCursor` null; `limit=100` | exact order, each row once | as expected | pass |
| | GET | /api/specialties | patient | cursor past the last row | 200, empty page, `{nextCursor: null, hasMore: false, count: 0}` | as expected | pass |
| PATCH (49) | PATCH | /api/specialties/{id} | admin | rename: 200, audit `changedFields` = `name`, `updated_at` advanced | 200 | as expected | pass |
| | PATCH | /api/specialties/{id} | admin | no-op (S1): same name + slug twice | 200, identical body, `updated_at` and audit count unchanged | as expected | pass |
| | PATCH | /api/specialties/{id} | admin | partly equal: only `description` audited; three-field change audits `description,isActive,slug`, `description: null` clears it | 200 | as expected | pass |
| | GET | /api/specialties | patient, doctor, admin | inactive row: hidden from patient and doctor even with `includeInactive=true`; hidden from admin by default and with `false`; shown to admin with `true`; paged walk of all rows | per S-R6 | as expected | pass |
| | PATCH | /api/specialties/{id} | admin | reactivate; own current slug is not a 409 | 200 | as expected | pass |
| | PATCH | /api/specialties/{id} | admin | slug / name of another row | 409 `Conflict`, row unchanged, no audit row | as expected | pass |
| | PATCH | /api/specialties/{id} | admin | `Idempotency-Key` ignored (same key, different bodies) | 200, 200 | as expected | pass |
| | PATCH | /api/specialties/{id} | admin | 11 invalid bodies: `{}` (field `body`), null `name`/`slug`/`isActive`, `"false"` string, name 1 char, bad slug, description number, `createdAt`, `id`, `[]` | 400 `ValidationFailed` | as expected | pass |
| | PATCH | /api/specialties/{id} | admin | ids `abc`, `0`, `007`, `9007199254740993`, `999999`, `-1`, `1.5`; malformed percent-encoding | 404 `NotFound`; 400 `ValidationFailed` | as expected | pass |
| | DELETE | /api/specialties/{id} | admin | no delete route (S-R3) | 404 `NotFound` | 404 | pass |
| Rate (7) | GET | /api/specialties | patient | 60 GETs from one IP; the 61st; unauthenticated 62nd (limiter runs before the guard) | 60 x 200; 429 `RateLimited` + `Retry-After` (got 60); 429 | as expected | pass |
| | POST | /api/specialties | admin | POST not limited by the GET limiter; after reset GET is 200; Redis keys `rl:specialties-list-ip:*` and `-user:<id>` exist | 400 / 200 / keys present | as expected | pass |
| Compiled (23) | GET, POST, PATCH | /api/specialties | admin, patient | **#8 on `dist/server.js`**: `includeInactive=false` and default omit an inactive row, `true` includes it (admin) and not for a patient; `yes`, `1`, `TRUE`, empty, repeated all 400; `limit` `1e1`, `05`, ` 5`, `1.5`, 0, 101 all 400; `limit=3` gives 3 items; PATCH `isActive:"false"` 400; POST `isActive` member 400; `{}` 400; `/abc` 404; patient POST 403; rename 200 | as in the dev run | identical to the source run | pass |
| Logs (3) | log | care-3001.log | | no token signature, no `Authorization`, no description fixture, no email/password; PATCH log line route `/api/specialties/:id` with the admin's `userId`; every specialties route label is `/api/specialties[/:id]` | 0 / 0 / 0 / 0; labels as stated | as expected | pass |

Database spot checks after the run (owner role): 15 `specialty.created` and 21 `specialty.updated` audit rows exist
(this module's runs only), none for any 409 or no-op request; `unhandled_error` count in the Care log is 0.

## Compiled-build #8 check (spec §9.5)

`npm run build` compiled cleanly. `dist/app/specialties/dto/specialties.request.dto.js` carries
`__metadata("design:type", Boolean)` for `includeInactive` (the condition that made implicit conversion turn
`"false"` into `true` under `tsc`). Running `node dist/server.js` on `:3011` against the same env, all 23 compiled-build
cases behave exactly like the source (`tsx`) server in section 4 and 5: `includeInactive=false` omits the inactive row,
`includeInactive=yes` answers 400, `limit=1e1`/`05` answer 400. Foundation gap #8 is confirmed fixed in the compiled build.

## Notes

- **Product failures: none.** All three failed assertions across runs 1 and 2 were wrong expectations in the script itself,
  fixed before the final run: (1) the `details[0].field` check read the previous request's body; (2) the first
  "past the end" cursor was built as an object, but the real cursor format is the JSON array `[sortValue, id]`
  (`src/lib/http/pagination/cursor.ts`), so the numeric and tampered-cursor 400 cases were also rebuilt as arrays;
  (3) the "past the end" sort value `~~~~` sorts first under the database's ICU-style collation, so `zzzzzzzz` is used
  (shows the cursor order follows the column collation, D3).
- Identity refuses to log in suspended accounts, so suspended principals are covered with fake-identity tokens;
  `403 Forbidden` for all three roles on all three routes.
- The per-user 120/min limit was not driven to 429 by CURL: the per-IP 60/min trips first from one address (and
  `TRUST_PROXY_HOPS=0` ignores `X-Forwarded-For`). The user limiter's key is verified in Redis, and its 429 is covered
  by the integration suite.
- The in-flight `409` + `Retry-After: 1` of `Idempotency-Key` was not reproduced here (needs a slow handler);
  it is covered by the access QA (`idem` router) and the integration suite.
- Rate-limit 429s count against the IP for a minute; run the script at most once a minute (also Identity's login limit).
