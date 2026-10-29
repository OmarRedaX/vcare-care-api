---
title: help-articles — Manual QA (CURL)
owner: care-team
service: care-service
module: help-articles
status: passed
diataxis: how-to
last_verified: 2026-10-29
tags: [manual-qa, curl, help-articles, help-center, rbac, pagination, keyset, idempotency, rate-limit, audit, compiled-build, redis-down]
related: [help-articles-spec, help-articles-tasks, help-articles-brainstorm, adr-0027-help-articles-shape-and-access, specialties-manual-qa, access-manual-qa, rbac, api]
contracts: [contracts/openapi.yaml]
---

# help-articles — Manual QA (CURL)

_Run: 2026-10-29 • Server: http://127.0.0.1:3051 (compiled build, Redis up) and the same build with Redis unreachable • Result: Redis-up run 352 pass / 0 fail / 0 skipped; Redis-down smoke 13 pass / 0 fail / 0 skipped (total 365 pass / 0 fail)_

Expected values come from `contracts/openapi.yaml` (`listHelpArticles`, `getHelpArticle`, `createHelpArticle`, `updateHelpArticle`,
`deleteHelpArticle`, `HelpArticle`, `HelpArticleSummary`, `PaginationMeta`, `ErrorEnvelope`), spec §3.1 (routes), §4 (HA-R1 to
HA-R24), §6 (error codes) and §9.5 (manual QA scope). Every response was checked for its status, `success`, `error.code`,
`error.requestId` equal to the sent `X-Request-Id`, the echoed `X-Request-Id` header, `error.details` being an array, and
`Cache-Control: private, no-cache` (success, 4xx and 429 alike). Every success body was checked for exactly the contract key set
(`HelpArticle` for create/get/patch, `HelpArticleSummary` for list items, never `body` or `createdAt` in a list). List and page
contents were compared with an independent oracle: owner SQL over the same table with the spec's sort order.

## Environment

| Component | Where | Notes |
|---|---|---|
| Care api, **compiled build** | `127.0.0.1:3051` (internal `3151`) | `npm run build`, then `node dist/server.js`, `NODE_ENV=development`, `LOG_LEVEL=info`; role `care_app` on Postgres 18 `:5499` `care_test` (migrated incl. `help_articles`); Redis `:6380` DB 14 |
| Care api, Redis down | same build, `127.0.0.1:3051` | second start with `REDIS_URL=redis://127.0.0.1:6399/14` (nothing listens); boot logged `redis_unavailable`, `/api/health/ready` answered `200` with `"status":"degraded"`; only one Care server ran at a time |
| Fake identity | `127.0.0.1:3021` | `scripts/access-qa-fake-identity.ts`: JWKS plus minted tokens. help-articles has no Identity dependency, so the JWKS is all Care needs |
| Principals (synthetic) | `patient-101`, `patient-102` (read-limit bucket), `doctor-201` (active), `doctor-pending`, `doctor-rejected`, `doctor-suspended`, `patient-pending`, `patient-suspended`, `admin-1` (writes), `admin-9001` (write-limit bucket), `admin-pending`, `admin-suspended`, plus `expired`, `tampered`, `wrong-aud`, `alg-none`, `typ-service` | tokens exist only in memory; none is printed or written |
| Fixtures | every article is titled `QA-HA-<run>-...`, bodies carry a synthetic marker string; 45 extra rows for paging are inserted by the owner (timestamp ties, microsecond offsets) | the script hard-deletes its own rows at start and on exit; `audit_logs` rows are append-only and remain |

Repeat (Git Bash; `psql`, `curl`, `node` required; start the fake identity first, then the Care server, see the header of the script):
```bash
CARE_OWNER_DATABASE_URL=<owner url of a *_test db> REDIS_URL=<same Redis as the server> CARE_LOG_FILE=<server stdout file> \
  [QA_TABLE_FILE=<tsv path>] bash scripts/curl-test-help-articles.sh        # Redis-up run (about 4 minutes)
CARE_OWNER_DATABASE_URL=<owner url> bash scripts/curl-test-help-articles.sh   # Redis-down run: REDIS_URL unset, the server's Redis unreachable
```

## Coverage summary

| Area | Result |
|---|---|
| 401 on all five routes (none, expired -> `TokenExpired`, tampered, wrong `aud`, `alg:none`, service-typed token, garbage, Basic scheme) | pass |
| 403 for patient and doctor (active, pending, rejected) on `POST`/`PATCH`/`DELETE`, role checked before the id (`PATCH /abc` -> 403); spoofed `X-Role`/`X-User-Id` ignored | pass |
| Account states: doctor pending/rejected can read; patient pending/suspended, admin pending/suspended, doctor suspended -> 403 on reads; admin pending/suspended -> 403 on writes | pass |
| Visibility: patient and doctor see only published articles of their own audience; draft, other-audience, deleted and unknown ids are `404` with an identical error body; admins see drafts, never deleted rows; admin and non-admin lists equal the SQL oracle | pass |
| Query validation (compiled build): `limit` 0/101/1.5/abc/1e1/05/-1/empty, bad `category`/`audience`, `isPublished` yes/1/TRUE/empty/repeated, unknown member, bad/forged/cross-kind/over-long cursors -> `400 ValidationFailed` | pass |
| Pagination, both default sorts: patient (`published_at DESC, id DESC`) and admin (`updated_at DESC, id DESC`) page 1, page 2, last page equal the oracle with no duplicates and no gaps over rows sharing a timestamp; a cursor survives the deletion of its own row; a cursor never widens the filter | pass |
| Create: shapes, verbatim body (HTML, newline, tab, astral, accent), unicode title untrimmed, 50,000-char body accepted, 50,001 rejected, 100 kb request cap, title/body/enum/unknown-member/null/malformed-JSON validation | pass |
| Duplicate live `(audience, title)` -> `409 Conflict` (`details[0].field = "title"`), same title in the other audience and a case-different title -> 201; two parallel POSTs -> exactly one 201 and one 409 | pass |
| Idempotency (`POST` only): same key + body -> original 201 replayed (one row, one audit row); same key + different body -> `422 IdempotencyConflict`; non-UUID key -> 400; no key twice -> 409; `PATCH`/`DELETE` ignore the header | pass |
| PATCH: partial update, publish -> unpublish -> re-publish keeps the first `publishedAt`, category + audience change on a published article, no-op (no `updated_at` change, no audit), partly-equal audits only the changed names, own title is not a 409, resulting `(audience, title)` collision -> 409, `{}` / `null` / unknown / server-derived members -> 400 | pass |
| DELETE: 204 with empty body, soft delete (row stays, `deleted_at` set), 404 for admin/patient/doctor afterwards, second DELETE 404, title reusable | pass |
| Audit: one row per create / effective update / delete, actor `admin` 1, `request_id` = the sent id, metadata keys only `isPublishedBefore`, `isPublishedAfter`, `changedFields`; no article text; reads write none | pass |
| `Cache-Control: private, no-cache` on 200/201/204/400/401/403/404/409/422/429 | pass |
| Rate limits (Redis up): 121st read by one user -> 429 with `Retry-After`; 21st write (7 DELETE + 7 PATCH + 6 POST, then any verb) -> 429; reads and writes are separate buckets; another user is unaffected | pass |
| Log hygiene (server stdout): no token signature, no `Authorization`, no body marker, no fixture title, route labels are patterns, no error-level line, no 5xx | pass |
| Redis down: CRUD works, ready probe `200 degraded`, idempotency middleware steps aside (`idempotency_skipped` logged; same key twice -> 201 then 409 from the unique index), limiter falls back (`rate_limiter_degraded` logged) | pass (13) |
| Same key twice in parallel -> in-flight `409` + `Retry-After: 1` | not observed: the run took the replay path (201 + 201); the in-flight lock is covered by the integration suite and the access QA |

## Failures / notes
- **No product failure.** No 5xx at any point; the server log of the Redis-up runs holds no error-level line.
- **Script defects fixed during the runs (not product defects):** (1) the 50,000-char `PATCH` body was passed on the command line and exceeded the Windows argument limit, it now goes through a file; (2) the parallel-POST status files were concatenated without a newline; (3) the audit-metadata leak check matched the field names `body,title` that `changedFields` legitimately lists, it now searches for article text only; (4) `audit_logs` is append-only, so "no audit row from rejected calls" is now a delta from the start of the run; (5) fixture cleanup missed a leading-space title (it now matches `%QA-HA-%`). The final Redis-up run (352/0/0) and the Redis-down run (13/0/0) used the final script apart from one cosmetic line (the request label of the in-flight case).
- **Compiled build matters:** `isPublished=yes|1|TRUE|` (and the repeated parameter) is `400` on the compiled build (the `design:type` condition of foundation fix #8). Point the script at `node dist/server.js`, not at `tsx`.
- **Idempotency in-flight case** (`409` + `Retry-After: 1`) cannot be forced reliably with two CURLs against a 20 ms handler; the two parallel same-key requests are accepted either way (201 + 201 replay here). The deterministic proof is `tests/integration/help-articles-writes`.
- **Rate limit with Redis down** was not driven to 429 (the fallback limiter is per instance and cannot be reset from the script); the `rate_limiter_degraded` warning and normal service were observed.
- **Cleanup:** `help_articles` is empty after each run; the append-only `audit_logs` keeps the rows of every run (entity type `help_article`, all admin actions of QA). No `notification_outbox` row is touched.
- Platform deltas for `/system-design`: none.

## Cases

Redis-up run. The numbering is the script sequence; `check` rows assert on the database, Redis, the server log, or the last response body.

### 1. Authentication (401): all five routes

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 1 | GET | /api/help-articles | none | no token: GET list | 401 Unauthorized | 401 Unauthorized | PASS |
| 2 | GET | /api/help-articles/1 | none | no token: GET by id | 401 Unauthorized | 401 Unauthorized | PASS |
| 3 | POST | /api/help-articles | none | no token: POST | 401 Unauthorized | 401 Unauthorized | PASS |
| 4 | PATCH | /api/help-articles/1 | none | no token: PATCH | 401 Unauthorized | 401 Unauthorized | PASS |
| 5 | DELETE | /api/help-articles/1 | none | no token: DELETE | 401 Unauthorized | 401 Unauthorized | PASS |
| 6 | GET | /api/help-articles | expired token | expired token: GET list -> TokenExpired | 401 TokenExpired | 401 TokenExpired | PASS |
| 7 | POST | /api/help-articles | expired token | expired token: POST -> TokenExpired | 401 TokenExpired | 401 TokenExpired | PASS |
| 8 | GET | /api/help-articles | tampered token | tampered signature -> 401 | 401 Unauthorized | 401 Unauthorized | PASS |
| 9 | GET | /api/help-articles | wrong-aud token | wrong audience -> 401 | 401 Unauthorized | 401 Unauthorized | PASS |
| 10 | GET | /api/help-articles | alg-none token | alg none -> 401 | 401 Unauthorized | 401 Unauthorized | PASS |
| 11 | GET | /api/help-articles | service-typed token | service-typed token on a user route -> 401 | 401 Unauthorized | 401 Unauthorized | PASS |
| 12 | GET | /api/help-articles | garbage token | garbage bearer -> 401 | 401 Unauthorized | 401 Unauthorized | PASS |
| 13 | GET | /api/help-articles | none | Basic scheme instead of Bearer -> 401 | 401 Unauthorized | 401 Unauthorized | PASS |

### 2. Authorization: roles and account states

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 14 | POST | /api/help-articles | patient | patient POST -> 403 | 403 Forbidden | 403 Forbidden | PASS |
| 15 | POST | /api/help-articles | doctor | doctor POST -> 403 | 403 Forbidden | 403 Forbidden | PASS |
| 16 | PATCH | /api/help-articles/1 | patient | patient PATCH any id -> 403 | 403 Forbidden | 403 Forbidden | PASS |
| 17 | PATCH | /api/help-articles/abc | patient | patient PATCH id=abc -> 403 (role before id parsing) | 403 Forbidden | 403 Forbidden | PASS |
| 18 | PATCH | /api/help-articles/1 | doctor | doctor PATCH -> 403 | 403 Forbidden | 403 Forbidden | PASS |
| 19 | DELETE | /api/help-articles/1 | patient | patient DELETE -> 403 | 403 Forbidden | 403 Forbidden | PASS |
| 20 | DELETE | /api/help-articles/1 | doctor | doctor DELETE -> 403 | 403 Forbidden | 403 Forbidden | PASS |
| 21 | DELETE | /api/help-articles/abc | doctor | doctor DELETE id=abc -> 403 | 403 Forbidden | 403 Forbidden | PASS |
| 22 | POST | /api/help-articles | patient | patient token + spoofed X-Role/X-User-Id headers: POST -> 403 | 403 Forbidden | 403 Forbidden | PASS |
| 23 | DELETE | /api/help-articles/1 | patient | patient token + spoofed headers: DELETE -> 403 | 403 Forbidden | 403 Forbidden | PASS |
| 24 | POST | /api/help-articles | doctor (pending) | doctor pending POST -> 403 | 403 Forbidden | 403 Forbidden | PASS |
| 25 | PATCH | /api/help-articles/1 | doctor (rejected) | doctor rejected PATCH -> 403 | 403 Forbidden | 403 Forbidden | PASS |
| 26 | POST | /api/help-articles | admin (pending) | admin pending (not active) POST -> 403 | 403 Forbidden | 403 Forbidden | PASS |
| 27 | POST | /api/help-articles | admin (suspended) | admin suspended POST -> 403 | 403 Forbidden | 403 Forbidden | PASS |
| 28 | GET | /api/help-articles | admin (pending) | admin pending list -> 403 | 403 Forbidden | 403 Forbidden | PASS |
| 29 | GET | /api/help-articles | admin (suspended) | admin suspended list -> 403 | 403 Forbidden | 403 Forbidden | PASS |
| 30 | DELETE | /api/help-articles/1 | admin (pending) | admin pending DELETE -> 403 | 403 Forbidden | 403 Forbidden | PASS |
| 31 | GET | /api/help-articles | patient (pending) | patient pending list -> 403 | 403 Forbidden | 403 Forbidden | PASS |
| 32 | GET | /api/help-articles/1 | patient (pending) | patient pending get -> 403 | 403 Forbidden | 403 Forbidden | PASS |
| 33 | GET | /api/help-articles | patient (suspended) | patient suspended list -> 403 | 403 Forbidden | 403 Forbidden | PASS |
| 34 | GET | /api/help-articles | doctor (suspended) | doctor suspended list -> 403 | 403 Forbidden | 403 Forbidden | PASS |
| 35 | GET | /api/help-articles/1 | doctor (suspended) | doctor suspended get -> 403 | 403 Forbidden | 403 Forbidden | PASS |
| 36 | check | (row count) | - | no help_articles row was written by any rejected call | 0 | 0 | PASS |
| 37 | check | (audit delta since the start of this run) | - | no help_article audit row from rejected calls | 0 | 0 | PASS |

### 3. Create (admin): happy paths, shapes, audit

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 38 | POST | /api/help-articles | admin | admin POST published patient article -> 201 | 201 ok | 201 ok | PASS |
| 39 | check | (keys) | - | 201 data keys are exactly the contract HelpArticle required list | audience,body,category,createdAt,id,isPublished,publishedAt,title,updatedAt | audience,body,category,createdAt,id,isPublished,publishedAt,title,updatedAt | PASS |
| 40 | POST | /api/help-articles | admin | isPublished=true -> isPublished true | true | true | PASS |
| 41 | check | (publishedAt) | - | publishedAt is set when created published | 1 | 1 | PASS |
| 42 | check | (content-type) | - | Content-Type is JSON | application/json; charset=utf-8 | application/json; charset=utf-8 | PASS |
| 43 | check | (count) | - | audit row written for the create (exactly 1 for this id) | 1 | 1 | PASS |
| 44 | check | (audit) | - | audit row: action\|actor\|role\|request_id | help_article.created\|1\|admin\|39240165-2206-4aab-97f3-03e77c7f2f3c | help_article.created\|1\|admin\|39240165-2206-4aab-97f3-03e77c7f2f3c | PASS |
| 45 | check | (metadata) | - | audit metadata is exactly isPublishedBefore=null, isPublishedAfter=true | {"isPublishedAfter": true, "isPublishedBefore": null} | {"isPublishedAfter": true, "isPublishedBefore": null} | PASS |
| 46 | GET | /api/help-articles/201 | admin | GET the created article as admin | 200 ok | 200 ok | PASS |
| 47 | check | (verbatim) | - | body is returned byte for byte (HTML, newlines, tab, astral, accent) | identical | identical | PASS |
| 48 | POST | /api/help-articles | admin | admin POST draft patient article (cancellation-policy) | 201 ok | 201 ok | PASS |
| 49 | POST | /api/help-articles | admin | draft publishedAt is null | null | null | PASS |
| 50 | POST | /api/help-articles | admin | admin POST published doctor article (platform-rules) | 201 ok | 201 ok | PASS |
| 51 | POST | /api/help-articles | admin | admin POST draft doctor article | 201 ok | 201 ok | PASS |
| 52 | POST | /api/help-articles | admin | admin POST published patient article (preparing-for-consultation) | 201 ok | 201 ok | PASS |
| 53 | POST | /api/help-articles | admin | admin POST a published patient article destined for deletion | 201 ok | 201 ok | PASS |
| 54 | POST | /api/help-articles | admin | title of exactly 3 characters is accepted | 201 ok | 201 ok | PASS |
| 55 | POST | /api/help-articles | admin | unicode title with leading spaces (not trimmed) accepted | 201 ok | 201 ok | PASS |
| 56 | POST | /api/help-articles | admin | title returned untrimmed |   QA-HA-<run>-spaces  |   QA-HA-<run>-spaces  | PASS |
| 57 | check | (audit delta) | - | creates wrote one audit row each (8 articles) | 8 | 8 | PASS |

### 3b. Create: duplicates and validation

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 58 | POST | /api/help-articles | admin | duplicate (audience,title) -> 409 Conflict | 409 Conflict | 409 Conflict | PASS |
| 59 | POST | /api/help-articles | admin | 409 details[0].field = title | [{"field":"title","issue":"is already in use for this audience"}] | [{"field":"title","issue":"is already in use for this audience"}] | PASS |
| 60 | check | (audit delta) | - | 409 left no audit row | 0 | 0 | PASS |
| 61 | check | (rows with that title) | - | 409 left no extra article row | 1 | 1 | PASS |
| 62 | POST | /api/help-articles | admin | same title in the OTHER audience -> 201 | 201 ok | 201 ok | PASS |
| 63 | POST | /api/help-articles | admin | title differing only by case -> 201 (case-sensitive uniqueness) | 201 ok | 201 ok | PASS |
| 64 | POST | /api/help-articles | admin | title of 2 chars -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 65 | POST | /api/help-articles | admin |   details[0].field | title | title | PASS |
| 66 | POST | /api/help-articles | admin | title of 201 chars -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 67 | POST | /api/help-articles | admin | title with newline -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 68 | POST | /api/help-articles | admin | title with BEL control char -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 69 | POST | /api/help-articles | admin | title with tab -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 70 | POST | /api/help-articles | admin | title not a string -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 71 | POST | /api/help-articles | admin | title missing -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 72 | POST | /api/help-articles | admin | body empty -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 73 | POST | /api/help-articles | admin | body missing -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 74 | POST | /api/help-articles | admin | body with NUL -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 75 | POST | /api/help-articles | admin | category not in enum -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 76 | POST | /api/help-articles | admin | audience 'admin' -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 77 | POST | /api/help-articles | admin | audience missing -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 78 | POST | /api/help-articles | admin | isPublished missing (no default) -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 79 | POST | /api/help-articles | admin | isPublished as string 'true' -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 80 | POST | /api/help-articles | admin | isPublished null -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 81 | POST | /api/help-articles | admin | unknown member id -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 82 | POST | /api/help-articles | admin | unknown member publishedAt -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 83 | POST | /api/help-articles | admin | unknown member createdBy -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 84 | POST | /api/help-articles | admin | JSON array body -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 85 | POST | /api/help-articles | admin | JSON null body -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 86 | POST | /api/help-articles | admin | malformed JSON -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 87 | POST | /api/help-articles | admin | empty body -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 88 | check | (rows named QA-HA-<run>-v) | - | no article created by the 400 cases | 0 | 0 | PASS |

### 3c. Create: body size boundaries (50,000 accepted, 50,001 rejected, 100 kb request cap)

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 89 | POST | /api/help-articles | admin | body of exactly 50,000 chars -> 201 | 201 ok | 201 ok | PASS |
| 90 | check | (char_length(body)) | - | stored length is 50000 | 50000 | 50000 | PASS |
| 91 | GET | /api/help-articles/212 | admin | GET it back: body length 50000 | 200 ok | 200 ok | PASS |
| 92 | check | (length) | - | returned body length | 50000 | 50000 | PASS |
| 93 | POST | /api/help-articles | admin | body of 50,001 chars -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 94 | POST | /api/help-articles | admin |   details[0].field | body | body | PASS |
| 95 | POST | /api/help-articles | admin | 24,000 astral chars (96 KB, code points counted not UTF-16 units) -> 201 | 201 ok | 201 ok | PASS |
| 96 | POST | /api/help-articles | admin | 30,000 astral chars = 120 KB request > 100 kb parser limit -> 400 ValidationFailed | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 97 | POST | /api/help-articles | admin |   details[0].issue (HA-D13) | must not exceed 100kb | must not exceed 100kb | PASS |
| 98 | PATCH | /api/help-articles/212 | admin | PATCH body to 50,000 chars -> 200 | 200 ok | 200 ok | PASS |
| 99 | PATCH | /api/help-articles/212 | admin | PATCH body to 50,001 chars -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |

### 4. Create: idempotency (POST only)

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 100 | POST | /api/help-articles | admin | POST with Idempotency-Key -> 201 | 201 ok | 201 ok | PASS |
| 101 | POST | /api/help-articles | admin | same key + same body -> original 201 replayed | 201 ok | 201 ok | PASS |
| 102 | check | (id) | - | replay returns the same id | 214 | 214 | PASS |
| 103 | check | (body) | - | replay body identical to the original | {"success":true,"data":{"id":214,"title":"QA-HA-<run>-idem","body":"Synthetic idem body","category":"how-it-works","audience":"doctor","isPublished":false,"publishedAt":null,"createdAt":"2026-10-29T16:05:23.393Z","updatedAt":"2026-10-29T16:05:23.393Z"}} | {"success":true,"data":{"id":214,"title":"QA-HA-<run>-idem","body":"Synthetic idem bo | PASS |
| 104 | check | (rows) | - | exactly one row for that title | 1 | 1 | PASS |
| 105 | check | (audit delta) | - | exactly one audit row for the replayed create | 1 | 1 | PASS |
| 106 | POST | /api/help-articles | admin | same key + different body -> 422 IdempotencyConflict | 422 IdempotencyConflict | 422 IdempotencyConflict | PASS |
| 107 | POST | /api/help-articles | admin | Idempotency-Key not a UUID -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 108 | POST | /api/help-articles | admin | no key, same body again -> 409 Conflict (unique title) | 409 Conflict | 409 Conflict | PASS |
| 109 | POST | /api/help-articles | admin | a NEW key, same body (title taken) -> 409 Conflict | 409 Conflict | 409 Conflict | PASS |
| 110 | POST | /api/help-articles | admin | replay of that 409 (same key, same body) -> 409 again | 409 Conflict | 409 Conflict | PASS |
| 111 | POST | /api/help-articles | admin | POST with another fresh key -> 201 | 201 ok | 201 ok | PASS |
| 112 | PATCH | /api/help-articles/217 | admin | PATCH with an Idempotency-Key is accepted and ignored (not declared on PATCH) | 200 ok | 200 ok | PASS |
| 113 | DELETE | /api/help-articles/217 | admin | DELETE with an Idempotency-Key header is ignored | 204 ok | 204 ok | PASS |

### 4b. Create: concurrency (two parallel POSTs of one (audience,title), different keys)

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 114 | check | (statuses) | - | parallel POSTs: exactly one 201 and one 409 | 201 409 | 201 409 | PASS |
| 115 | check | (rows) | - | parallel POSTs: exactly one row | 1 | 1 | PASS |

### 4c. Create: two parallel POSTs with the SAME Idempotency-Key and body (in-flight lock or replay)

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 116 | POST | /api/help-articles | admin | same key twice in parallel: 201+201 (replay) or 201+409 with Retry-After: 1 (replayed (first finished before the second arrived)) | 201 201 \| 201 409+Retry-After | 201 201 | PASS |
| 117 | check | (rows) | - | never two rows for the title | 1 | 1 | PASS |

### 5. Delete (soft) then 404 for everyone; title reuse

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 118 | DELETE | /api/help-articles/206 | admin | admin DELETE F6 -> 204, empty body | 204 ok | 204 ok | PASS |
| 119 | check | (deleted_at set) | - | row still exists with deleted_at set (soft delete) | t | t | PASS |
| 120 | check | (audit) | - | audit: help_article.deleted by admin 1 | help_article.deleted\|1\|admin | help_article.deleted\|1\|admin | PASS |
| 121 | check | (metadata) | - | audit metadata isPublishedBefore=true, isPublishedAfter=null | {"isPublishedAfter": null, "isPublishedBefore": true} | {"isPublishedAfter": null, "isPublishedBefore": true} | PASS |
| 122 | check | (audit delta) | - | delete wrote exactly one audit row | 1 | 1 | PASS |
| 123 | GET | /api/help-articles/206 | admin | admin GET the deleted article -> 404 | 404 NotFound | 404 NotFound | PASS |
| 124 | GET | /api/help-articles/206 | patient | patient GET the deleted article -> 404 | 404 NotFound | 404 NotFound | PASS |
| 125 | GET | /api/help-articles/206 | doctor | doctor GET the deleted article -> 404 | 404 NotFound | 404 NotFound | PASS |
| 126 | PATCH | /api/help-articles/206 | admin | admin PATCH the deleted article -> 404 | 404 NotFound | 404 NotFound | PASS |
| 127 | DELETE | /api/help-articles/206 | admin | second DELETE of the same article -> 404 | 404 NotFound | 404 NotFound | PASS |
| 128 | POST | /api/help-articles | admin | title of the deleted article is reusable -> 201 | 201 ok | 201 ok | PASS |
| 129 | check | (id differs) | - | the new article has a new id | 1 | 1 | PASS |
| 130 | DELETE | /api/help-articles/999999 | admin | DELETE unknown id -> 404 | 404 NotFound | 404 NotFound | PASS |
| 131 | DELETE | /api/help-articles/abc | admin | admin DELETE non-canonical id 'abc' -> 404 | 404 NotFound | 404 NotFound | PASS |
| 132 | DELETE | /api/help-articles/0 | admin | admin DELETE non-canonical id '0' -> 404 | 404 NotFound | 404 NotFound | PASS |
| 133 | DELETE | /api/help-articles/007 | admin | admin DELETE non-canonical id '007' -> 404 | 404 NotFound | 404 NotFound | PASS |
| 134 | DELETE | /api/help-articles/-1 | admin | admin DELETE non-canonical id '-1' -> 404 | 404 NotFound | 404 NotFound | PASS |
| 135 | DELETE | /api/help-articles/1.5 | admin | admin DELETE non-canonical id '1.5' -> 404 | 404 NotFound | 404 NotFound | PASS |
| 136 | DELETE | /api/help-articles/9007199254740993 | admin | admin DELETE non-canonical id '9007199254740993' -> 404 | 404 NotFound | 404 NotFound | PASS |

### 6. Update (PATCH): partial, publish/unpublish, no-op, category and audience change

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 137 | PATCH | /api/help-articles/202 | admin | PATCH title + body of the draft F2 -> 200 | 200 ok | 200 ok | PASS |
| 138 | PATCH | /api/help-articles/202 | admin | title changed | QA-HA-<run>-pat-draft-v2 | QA-HA-<run>-pat-draft-v2 | PASS |
| 139 | PATCH | /api/help-articles/202 | admin | still a draft | false | false | PASS |
| 140 | check | (updated_at) | - | updated_at moved forward | 1 | 1 | PASS |
| 141 | check | (audit) | - | audit: updated by admin 1 with the request id | help_article.updated\|1\|admin\|180a3754-6790-4f14-914d-2cb30a2725fc | help_article.updated\|1\|admin\|180a3754-6790-4f14-914d-2cb30a2725fc | PASS |
| 142 | check | (metadata) | - | audit metadata: sorted changedFields, no title or body | {"changedFields": "body,title", "isPublishedAfter": false, "isPublishedBefore": false} | {"changedFields": "body,title", "isPublishedAfter": false, "isPublishedBefore": false} | PASS |
| 143 | check | (audit delta) | - | exactly one audit row for the update | 1 | 1 | PASS |
| 144 | PATCH | /api/help-articles/202 | admin | publish the draft F2 -> publishedAt set | 200 ok | 200 ok | PASS |
| 145 | check | (publishedAt) | - | publishedAt is set on first publish | 1 | 1 | PASS |
| 146 | PATCH | /api/help-articles/202 | admin | audit-visible isPublished | true | true | PASS |
| 147 | check | (metadata) | - | audit changedFields = isPublished, before false after true | {"changedFields": "isPublished", "isPublishedAfter": true, "isPublishedBefore": false} | {"changedFields": "isPublished", "isPublishedAfter": true, "isPublishedBefore": false} | PASS |
| 148 | PATCH | /api/help-articles/202 | admin | unpublish F2 -> publishedAt kept | 200 ok | 200 ok | PASS |
| 149 | PATCH | /api/help-articles/202 | admin | isPublished false | false | false | PASS |
| 150 | PATCH | /api/help-articles/202 | admin | publishedAt unchanged after unpublish | 2026-10-29T16:05:50.710Z | 2026-10-29T16:05:50.710Z | PASS |
| 151 | PATCH | /api/help-articles/202 | admin | re-publish F2 -> original publishedAt kept | 200 ok | 200 ok | PASS |
| 152 | PATCH | /api/help-articles/202 | admin | publishedAt unchanged after re-publish | 2026-10-29T16:05:50.710Z | 2026-10-29T16:05:50.710Z | PASS |
| 153 | GET | /api/help-articles/202 | patient | patient can now read F2 by id | 200 ok | 200 ok | PASS |
| 154 | PATCH | /api/help-articles/202 | admin | unpublish again, patient gets 404 immediately | 200 ok | 200 ok | PASS |
| 155 | GET | /api/help-articles/202 | patient | patient GET unpublished F2 -> 404 | 404 NotFound | 404 NotFound | PASS |
| 156 | PATCH | /api/help-articles/202 | admin | re-publish F2 for the later list cases | 200 ok | 200 ok | PASS |

### 6b. PATCH: no-op, partial equal, category and audience change

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 157 | PATCH | /api/help-articles/210 | admin | rename F9 (doctor copy of the same title) away first | 200 ok | 200 ok | PASS |
| 158 | PATCH | /api/help-articles/201 | admin | no-op PATCH (every value equals stored) -> 200 | 200 ok | 200 ok | PASS |
| 159 | check | (audit delta) | - | no-op wrote no audit row | 0 | 0 | PASS |
| 160 | check | (updated_at) | - | no-op left updated_at unchanged | 2026-10-29 19:04:37.640628+03 | 2026-10-29 19:04:37.640628+03 | PASS |
| 161 | PATCH | /api/help-articles/201 | admin | partly equal PATCH (title same, category changes) -> 200 | 200 ok | 200 ok | PASS |
| 162 | PATCH | /api/help-articles/201 | admin | category changed | platform-rules | platform-rules | PASS |
| 163 | check | (metadata) | - | audit changedFields lists only category | {"changedFields": "category", "isPublishedAfter": true, "isPublishedBefore": true} | {"changedFields": "category", "isPublishedAfter": true, "isPublishedBefore": true} | PASS |
| 164 | check | (updated_at) | - | updated_at moved on the real change | 1 | 1 | PASS |
| 165 | PATCH | /api/help-articles/201 | admin | own current title in the PATCH is not a 409 against itself -> 200 (no-op) | 200 ok | 200 ok | PASS |
| 166 | PATCH | /api/help-articles/201 | admin | PATCH category AND audience of a PUBLISHED article in one call (no unpublish) -> 200 | 200 ok | 200 ok | PASS |
| 167 | PATCH | /api/help-articles/201 | admin | audience now doctor | doctor | doctor | PASS |
| 168 | PATCH | /api/help-articles/201 | admin | still published | true | true | PASS |
| 169 | check | (metadata) | - | audit changedFields = audience,category | {"changedFields": "audience,category", "isPublishedAfter": true, "isPublishedBefore": true} | {"changedFields": "audience,category", "isPublishedAfter": true, "isPublishedBefore": true | PASS |
| 170 | GET | /api/help-articles/201 | patient | patient no longer sees F1 -> 404 | 404 NotFound | 404 NotFound | PASS |
| 171 | GET | /api/help-articles/201 | doctor | doctor now sees F1 -> 200 | 200 ok | 200 ok | PASS |
| 172 | PATCH | /api/help-articles/201 | admin | move F1 back to the patient audience and category | 200 ok | 200 ok | PASS |
| 173 | GET | /api/help-articles/201 | patient | patient sees F1 again -> 200 | 200 ok | 200 ok | PASS |
| 174 | PATCH | /api/help-articles/205 | admin | PATCH title to one taken in the same audience -> 409 Conflict | 409 Conflict | 409 Conflict | PASS |
| 175 | PATCH | /api/help-articles/205 | admin | 409 details | [{"field":"title","issue":"is already in use for this audience"}] | [{"field":"title","issue":"is already in use for this audience"}] | PASS |
| 176 | check | (title of F5) | - | the 409 PATCH changed nothing | QA-HA-<run>-pat-prep | QA-HA-<run>-pat-prep | PASS |
| 177 | PATCH | /api/help-articles/210 | admin | give F9 (doctor) the title of F1 (patient): allowed, different audience | 200 ok | 200 ok | PASS |
| 178 | PATCH | /api/help-articles/201 | admin | moving F1 to the doctor audience now collides on the RESULTING (audience,title) -> 409 | 409 Conflict | 409 Conflict | PASS |
| 179 | check | (audience) | - | the colliding move left F1 in the patient audience | patient | patient | PASS |
| 180 | check | (audit delta) | - | only the F9 rename (200) wrote an audit row, the 409 wrote none | 1 | 1 | PASS |
| 181 | PATCH | /api/help-articles/210 | admin | rename F9 away again | 200 ok | 200 ok | PASS |

### 6c. PATCH: validation and ids

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 182 | PATCH | /api/help-articles/201 | admin | PATCH {} -> 400 'must contain at least one property' | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 183 | PATCH | /api/help-articles/201 | admin |   details | [{"field":"body","issue":"must contain at least one property"}] | [{"field":"body","issue":"must contain at least one property"}] | PASS |
| 184 | PATCH | /api/help-articles/201 | admin | PATCH title:null -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 185 | PATCH | /api/help-articles/201 | admin | PATCH isPublished:'true' -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 186 | PATCH | /api/help-articles/201 | admin | PATCH publishedAt (server-derived) -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 187 | PATCH | /api/help-articles/201 | admin | PATCH id member -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 188 | PATCH | /api/help-articles/201 | admin | PATCH createdAt member -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 189 | PATCH | /api/help-articles/201 | admin | PATCH title 2 chars -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 190 | PATCH | /api/help-articles/201 | admin | PATCH title with newline -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 191 | PATCH | /api/help-articles/201 | admin | PATCH body '' -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 192 | PATCH | /api/help-articles/201 | admin | PATCH body with NUL escape -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 193 | PATCH | /api/help-articles/201 | admin | PATCH category 'other' -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 194 | PATCH | /api/help-articles/201 | admin | PATCH audience 'admin' -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 195 | PATCH | /api/help-articles/201 | admin | PATCH malformed JSON -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 196 | PATCH | /api/help-articles/999999 | admin | PATCH unknown id -> 404 | 404 NotFound | 404 NotFound | PASS |
| 197 | PATCH | /api/help-articles/abc | admin | admin PATCH non-canonical id 'abc' -> 404 | 404 NotFound | 404 NotFound | PASS |
| 198 | PATCH | /api/help-articles/0 | admin | admin PATCH non-canonical id '0' -> 404 | 404 NotFound | 404 NotFound | PASS |
| 199 | PATCH | /api/help-articles/007 | admin | admin PATCH non-canonical id '007' -> 404 | 404 NotFound | 404 NotFound | PASS |
| 200 | PATCH | /api/help-articles/-1 | admin | admin PATCH non-canonical id '-1' -> 404 | 404 NotFound | 404 NotFound | PASS |
| 201 | PATCH | /api/help-articles/1.5 | admin | admin PATCH non-canonical id '1.5' -> 404 | 404 NotFound | 404 NotFound | PASS |
| 202 | PATCH | /api/help-articles/9007199254740993 | admin | admin PATCH non-canonical id '9007199254740993' -> 404 | 404 NotFound | 404 NotFound | PASS |

### 7. Reads: visibility per role (oracle = owner SQL)

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 203 | GET | /api/help-articles | patient | patient list -> 200 | 200 ok | 200 ok | PASS |
| 204 | check | (ids) | - | patient sees exactly the published patient articles, published_at DESC, id DESC | 202,205,201 | 202,205,201 | PASS |
| 205 | check | (keys) | - | list item keys: no body, no createdAt | audience,category,id,isPublished,publishedAt,title,updatedAt | audience,category,id,isPublished,publishedAt,title,updatedAt | PASS |
| 206 | GET | /api/help-articles | patient | meta shape (nextCursor,hasMore,count) | {"nextCursor":null,"hasMore":false,"count":3} | {"nextCursor":null,"hasMore":false,"count":3} | PASS |
| 207 | GET | /api/help-articles | doctor | doctor (active) list -> 200 | 200 ok | 200 ok | PASS |
| 208 | check | (ids) | - | doctor sees exactly the published doctor articles | 203 | 203 | PASS |
| 209 | GET | /api/help-articles | doctor (pending) | doctor pending list -> 200 (onboarding) | 200 ok | 200 ok | PASS |
| 210 | check | (ids) | - | pending doctor sees the same ids | 203 | 203 | PASS |
| 211 | GET | /api/help-articles | doctor (rejected) | doctor rejected list -> 200 | 200 ok | 200 ok | PASS |
| 212 | check | (ids) | - | rejected doctor sees the same ids | 203 | 203 | PASS |
| 213 | GET | /api/help-articles | admin | admin list -> 200 (drafts included, both audiences) | 200 ok | 200 ok | PASS |
| 214 | check | (ids) | - | admin sees all live rows, updated_at DESC, id DESC | 210,201,202,221,220,218,214,211,208,207,205,204,203 | 210,201,202,221,220,218,214,211,208,207,205,204,203 | PASS |
| 215 | check | (keys) | - | admin list items also have no body | audience,category,id,isPublished,publishedAt,title,updatedAt | audience,category,id,isPublished,publishedAt,title,updatedAt | PASS |
| 216 | check | (contains F6) | - | the deleted article is absent from the admin list | 0 | 0 | PASS |
| 217 | check | (contains F4) | - | the draft IS in the admin list | 1 | 1 | PASS |
| 218 | check | (contains F4) | - | the doctor draft F4 is NOT in the doctor list | 0 | 0 | PASS |
| 219 | check | (contains F3) | - | the published doctor article F3 is NOT in the patient list | 0 | 0 | PASS |
| 220 | GET | /api/help-articles?audience=doctor&isPublished=false | patient | patient list with audience=doctor&isPublished=false ignored (HA-D10) | 200 ok | 200 ok | PASS |
| 221 | check | (ids) | - | same ids as the plain patient list | 202,205,201 | 202,205,201 | PASS |
| 222 | GET | /api/help-articles?audience=patient&isPublished=false | doctor | doctor list with audience=patient&isPublished=false ignored | 200 ok | 200 ok | PASS |
| 223 | check | (ids) | - | same ids as the plain doctor list | 203 | 203 | PASS |
| 224 | GET | /api/help-articles?category=preparing-for-consultation | patient | patient category filter | 200 ok | 200 ok | PASS |
| 225 | check | (ids) | - | only the preparing-for-consultation patient article | 205 | 205 | PASS |
| 226 | GET | /api/help-articles?audience=doctor | admin | admin audience=doctor filter | 200 ok | 200 ok | PASS |
| 227 | check | (ids) | - | admin audience=doctor oracle | 210,214,208,207,204,203 | 210,214,208,207,204,203 | PASS |
| 228 | GET | /api/help-articles?isPublished=false | admin | admin isPublished=false filter (drafts only) | 200 ok | 200 ok | PASS |
| 229 | check | (ids) | - | admin drafts oracle | 210,221,220,218,214,211,208,207,204 | 210,221,220,218,214,211,208,207,204 | PASS |
| 230 | GET | /api/help-articles?isPublished=true&audience=patient&category=preparing-for-consultation | admin | admin isPublished=true&audience=patient&category filter | 200 ok | 200 ok | PASS |
| 231 | check | (ids) | - | combined admin filters | 205 | 205 | PASS |
| 232 | GET | /api/help-articles?category=platform-rules&audience=patient&isPublished=false | admin | admin filter with no match -> empty page | 200 ok | 200 ok | PASS |
| 233 | GET | /api/help-articles?category=platform-rules&audience=patient&isPublished=false | admin | empty page meta | {"nextCursor":null,"hasMore":false,"count":0} | {"nextCursor":null,"hasMore":false,"count":0} | PASS |
| 234 | GET | /api/help-articles?category=platform-rules&audience=patient&isPublished=false | admin | empty page data | [] | [] | PASS |
| 235 | GET | /api/help-articles/205 | patient | patient GET published own-audience F5 -> 200 | 200 ok | 200 ok | PASS |
| 236 | check | (keys) | - | detail keys (body included) | audience,body,category,createdAt,id,isPublished,publishedAt,title,updatedAt | audience,body,category,createdAt,id,isPublished,publishedAt,title,updatedAt | PASS |
| 237 | GET | /api/help-articles/204 | patient | patient GET unpublished doctor draft F4 -> 404 | 404 NotFound | 404 NotFound | PASS |
| 238 | GET | /api/help-articles/203 | patient | patient GET other-audience published F3 -> 404 | 404 NotFound | 404 NotFound | PASS |
| 239 | check | (code\|message\|details) | - | other-audience 404 body identical to the draft 404 | NotFound\|Resource not found\|[] | NotFound\|Resource not found\|[] | PASS |
| 240 | GET | /api/help-articles/999999 | patient | patient GET unknown id -> 404 | 404 NotFound | 404 NotFound | PASS |
| 241 | check | (code\|message\|details) | - | unknown-id 404 body identical to the hidden-article 404 | NotFound\|Resource not found\|[] | NotFound\|Resource not found\|[] | PASS |
| 242 | GET | /api/help-articles/203 | doctor | doctor GET published doctor article F3 -> 200 | 200 ok | 200 ok | PASS |
| 243 | GET | /api/help-articles/205 | doctor | doctor GET patient article F5 -> 404 | 404 NotFound | 404 NotFound | PASS |
| 244 | GET | /api/help-articles/204 | doctor | doctor GET own-audience draft F4 -> 404 | 404 NotFound | 404 NotFound | PASS |
| 245 | GET | /api/help-articles/203 | doctor (pending) | pending doctor GET F3 -> 200 | 200 ok | 200 ok | PASS |
| 246 | GET | /api/help-articles/203 | doctor (rejected) | rejected doctor GET F3 -> 200 | 200 ok | 200 ok | PASS |
| 247 | GET | /api/help-articles/204 | doctor (pending) | pending doctor GET draft F4 -> 404 | 404 NotFound | 404 NotFound | PASS |
| 248 | GET | /api/help-articles/204 | admin | admin GET draft F4 -> 200 | 200 ok | 200 ok | PASS |
| 249 | GET | /api/help-articles/205 | admin | admin GET patient published F5 -> 200 | 200 ok | 200 ok | PASS |
| 250 | GET | /api/help-articles/abc | admin | admin GET id 'abc' -> 404 | 404 NotFound | 404 NotFound | PASS |
| 251 | GET | /api/help-articles/0 | admin | admin GET id '0' -> 404 | 404 NotFound | 404 NotFound | PASS |
| 252 | GET | /api/help-articles/007 | admin | admin GET id '007' -> 404 | 404 NotFound | 404 NotFound | PASS |
| 253 | GET | /api/help-articles/-1 | admin | admin GET id '-1' -> 404 | 404 NotFound | 404 NotFound | PASS |
| 254 | GET | /api/help-articles/1.5 | admin | admin GET id '1.5' -> 404 | 404 NotFound | 404 NotFound | PASS |
| 255 | GET | /api/help-articles/9007199254740993 | admin | admin GET id '9007199254740993' -> 404 | 404 NotFound | 404 NotFound | PASS |
| 256 | GET | /api/help-articles/999999 | admin | admin GET id '999999' -> 404 | 404 NotFound | 404 NotFound | PASS |
| 257 | GET | /api/help-articles/abc | patient | patient GET id 'abc' -> 404 | 404 NotFound | 404 NotFound | PASS |
| 258 | check | (audit delta) | - | reads wrote no audit row (HA-R14) | 0 | 0 | PASS |

### 7b. Reads: query validation (the compiled build converts nothing implicitly)

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 259 | GET | /api/help-articles?limit=0 | patient | patient list ?limit=0 -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 260 | GET | /api/help-articles?limit=101 | patient | patient list ?limit=101 -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 261 | GET | /api/help-articles?limit=1.5 | patient | patient list ?limit=1.5 -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 262 | GET | /api/help-articles?limit=abc | patient | patient list ?limit=abc -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 263 | GET | /api/help-articles?limit=1e1 | patient | patient list ?limit=1e1 -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 264 | GET | /api/help-articles?limit=05 | patient | patient list ?limit=05 -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 265 | GET | /api/help-articles?limit=-1 | patient | patient list ?limit=-1 -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 266 | GET | /api/help-articles?limit= | patient | patient list ?limit= -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 267 | GET | /api/help-articles?category=other | patient | patient list ?category=other -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 268 | GET | /api/help-articles?category= | patient | patient list ?category= -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 269 | GET | /api/help-articles?audience=admin | patient | patient list ?audience=admin -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 270 | GET | /api/help-articles?audience=Patient | patient | patient list ?audience=Patient -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 271 | GET | /api/help-articles?isPublished=yes | patient | patient list ?isPublished=yes -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 272 | GET | /api/help-articles?isPublished=1 | patient | patient list ?isPublished=1 -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 273 | GET | /api/help-articles?isPublished=TRUE | patient | patient list ?isPublished=TRUE -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 274 | GET | /api/help-articles?isPublished= | patient | patient list ?isPublished= -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 275 | GET | /api/help-articles?unknown=1 | patient | patient list ?unknown=1 -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 276 | GET | /api/help-articles?cursor=<c> | patient | patient list ?cursor= -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 277 | GET | /api/help-articles?cursor=<c> | patient | patient list ?cursor=garbage -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 278 | GET | /api/help-articles?isPublished=yes | admin | admin list ?isPublished=yes -> 400 (compiled-build #8 check) | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 279 | GET | /api/help-articles?isPublished=true&isPublished=false | admin | isPublished repeated -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 280 | GET | /api/help-articles?isPublished=true | admin | admin list ?isPublished=true -> 200 | 200 ok | 200 ok | PASS |
| 281 | GET | /api/help-articles?isPublished=false | admin | admin list ?isPublished=false -> 200 | 200 ok | 200 ok | PASS |
| 282 | GET | /api/help-articles?limit=1 | patient | limit=1 -> one row, hasMore | 200 ok | 200 ok | PASS |
| 283 | GET | /api/help-articles?limit=1 | patient | meta.count 1 and hasMore | {"nextCursor":"WyJwdWJsaXNoZWQ6MjAyNi0xMC0yOVQxNjowNTo1MC43MTA1ODNaIiwyMDJd","hasMore":true,"count":1} | {"nextCursor":"WyJwdWJsaXNoZWQ6MjAyNi0xMC0yOVQxNjowNTo1MC43MTA1ODNaIiwyMDJd","hasMore":tru | PASS |
| 284 | GET | /api/help-articles?limit=100 | patient | limit=100 -> 200 | 200 ok | 200 ok | PASS |
| 285 | GET | /api/help-articles?cursor=<c> | patient | valid base64url of a non-array cursor -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 286 | GET | /api/help-articles?cursor=<c> | patient |   cursor error detail | [{"field":"cursor","issue":"is invalid"}] | [{"field":"cursor","issue":"is invalid"}] | PASS |
| 287 | GET | /api/help-articles?cursor=<c> | patient | numeric sort value cursor -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 288 | GET | /api/help-articles?cursor=<c> | patient | id 0 cursor -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 289 | GET | /api/help-articles?cursor=<c> | patient | millisecond-only timestamp cursor -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 290 | GET | /api/help-articles?cursor=<c> | patient | impossible date cursor -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 291 | GET | /api/help-articles?cursor=<c> | patient | cursor without a kind prefix -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 292 | GET | /api/help-articles?cursor=<c> | patient | admin-kind cursor given to a patient -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 293 | GET | /api/help-articles?cursor=<c> | admin | patient-kind cursor given to an admin -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 294 | GET | /api/help-articles?cursor=<c> | patient | cursor longer than 1024 chars -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 295 | GET | /api/help-articles?cursor=<c> | patient | NUL inside the cursor sort value -> 400 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 296 | GET | /api/help-articles?cursor=<c> | patient | well-formed forged cursor is accepted as a POSITION only (no widening): patient still sees only own audience | 200 ok | 200 ok | PASS |
| 297 | check | (ids subset of oracle) | - | forged cursor returns only patient-visible ids | 202,205,201 | 202,205,201 | PASS |

### 8. Pagination: page 2 and last page on both default sorts (45 seeded rows with timestamp ties)

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 298 | GET | /api/help-articles | patient | patient page 1 (default limit 20) | 200 ok | 200 ok | PASS |
| 299 | GET | /api/help-articles | patient | page 1 count 20 / hasMore true | 20 | 20 | PASS |
| 300 | GET | /api/help-articles | patient | hasMore | true | true | PASS |
| 301 | check | (cursor) | - | nextCursor is an opaque non-empty string | 1 | 1 | PASS |
| 302 | GET | /api/help-articles?cursor=<c> | patient | patient PAGE 2 with the page-1 cursor | 200 ok | 200 ok | PASS |
| 303 | GET | /api/help-articles?cursor=<c> | patient | page 2 count 20 | 20 | 20 | PASS |
| 304 | GET | /api/help-articles?cursor=<c> | patient | page 2 hasMore true | true | true | PASS |
| 305 | check | (overlap) | - | page 2 does not overlap page 1 | 0 | 0 | PASS |
| 306 | check | (ids) | - | patient: paging through returns every visible row exactly once in published_at DESC, id DESC order | 202,205,201,266,265,264,263,262,261,260,259,258,257,256,255,254,253,252,251,250,249,248,247,246,245,244,243,242,241,240,239,238,237,236,235,234,233,232,231,230,229,228,227,226,225,224,223,222 | 202,205,201,266,265,264,263,262,261,260,259,258,257,256,255,254,253,252,251,250,249,248,24 | PASS |
| 307 | check | (last page) | - | patient: page sizes 20,20,N,... then the last page has hasMore=false and nextCursor null | false\|null | false\|null | PASS |
| 308 | check | (counts) | - | patient: 48 visible rows are served as pages of 20 | 20,20,8 | 20,20,8 | PASS |
| 309 | check | (ids) | - | admin: paging returns every live row exactly once in updated_at DESC, id DESC order | 210,201,202,221,220,218,214,211,208,207,205,204,203,266,265,264,263,262,261,260,259,258,257,256,255,254,253,252,251,250,249,248,247,246,245,244,243,242,241,240,239,238,237,236,235,234,233,232,231,230,229,228,227,226,225,224,223,222 | 210,201,202,221,220,218,214,211,208,207,205,204,203,266,265,264,263,262,261,260,259,258,25 | PASS |
| 310 | check | (last) | - | admin: last page hasMore=false | false | false | PASS |
| 311 | check | (counts) | - | admin: page sizes follow 20 per page | 20,20,18 | 20,20,18 | PASS |
| 312 | GET | /api/help-articles?limit=7 | patient | limit=7 pages: first page | 200 ok | 200 ok | PASS |
| 313 | GET | /api/help-articles?limit=7&cursor=<c> | patient | limit=7 pages: second page | 200 ok | 200 ok | PASS |
| 314 | check | (ids) | - | limit=7: the two pages are the first 14 oracle ids | 202,205,201,266,265,264,263,262,261,260,259,258,257,256 | 202,205,201,266,265,264,263,262,261,260,259,258,257,256 | PASS |
| 315 | GET | /api/help-articles?limit=100 | patient | limit=100 returns all patient-visible rows in one page | 200 ok | 200 ok | PASS |
| 316 | check | (ids) | - | limit=100: one page, hasMore false | 202,205,201,266,265,264,263,262,261,260,259,258,257,256,255,254,253,252,251,250,249,248,247,246,245,244,243,242,241,240,239,238,237,236,235,234,233,232,231,230,229,228,227,226,225,224,223,222 | 202,205,201,266,265,264,263,262,261,260,259,258,257,256,255,254,253,252,251,250,249,248,24 | PASS |
| 317 | GET | /api/help-articles?limit=100 | patient | limit=100: hasMore false | false | false | PASS |
| 318 | GET | /api/help-articles?category=how-it-works&cursor=<c> | patient | page-1 cursor + category=how-it-works: the filter is re-applied (cursor is a position, never a grant) | 200 ok | 200 ok | PASS |
| 319 | check | (ids) | - | ids = how-it-works rows after the cursor position | 249,248,247,246,245,244,243,242,241,240,239,238,237,236,235,234,233,232,231,230 | 249,248,247,246,245,244,243,242,241,240,239,238,237,236,235,234,233,232,231,230 | PASS |
| 320 | GET | /api/help-articles?category=preparing-for-consultation&cursor=<c> | patient | page-1 cursor + category=preparing-for-consultation | 200 ok | 200 ok | PASS |
| 321 | check | (ids) | - | ids = preparing rows after the position (F5 is newer than the seeded rows, so none) |  |  | PASS |
| 322 | GET | /api/help-articles | patient | page-1 cursor again (limit=20) | 200 ok | 200 ok | PASS |
| 323 | GET | /api/help-articles?cursor=<c> | patient | page 2 with a cursor whose row was deleted in between -> still 200 (position, not grant) | 200 ok | 200 ok | PASS |
| 324 | check | (ids) | - | page 2 equals the rows after that position | 249,248,247,246,245,244,243,242,241,240,239,238,237,236,235,234,233,232,231,230 | 249,248,247,246,245,244,243,242,241,240,239,238,237,236,235,234,233,232,231,230 | PASS |

### 9. Audit completeness and privacy

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 325 | check | (non-admin actors) | - | every audit row of this run: entity_type help_article, actor admin 1 | 0 | 0 | PASS |
| 326 | check | (other keys) | - | no audit metadata key other than isPublishedBefore/After and changedFields | 0 | 0 | PASS |
| 327 | check | (leaks) | - | no audit metadata contains article text (marker, fixture title, body words); field NAMES in changedFields are allowed | 0 | 0 | PASS |
| 328 | check | (null request ids) | - | every audit row has a request_id | 0 | 0 | PASS |
| 329 | check | (actions) | - | audit actions used are exactly created/updated/deleted | help_article.created,help_article.deleted,help_article.updated | help_article.created,help_article.deleted,help_article.updated | PASS |
| 330 | check | (has_table_privilege) | - | vcare_app cannot hard-delete help_articles (no DELETE grant) | f | f | PASS |

### 10. Rate limits: reads 120/min per user, writes 20/min per user (one shared bucket)

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 331 | check | (429 count in the first 120) | - | patient-102: requests 1..120 are not 429 | 0 | 0 | PASS |
| 332 | check | (121st status) | - | patient-102: the 121st read in a minute -> 429 | 429 | 429 | PASS |
| 333 | check | (key) | - | Redis holds the read bucket | 1 | 1 | PASS |
| 334 | check | (envelope) | - | 429 body: success=false, RateLimited, requestId = sent id | 429\|false\|RateLimited\|057a23d9-792f-4b17-a82f-29ca3b2d1a45 | 429\|false\|RateLimited\|057a23d9-792f-4b17-a82f-29ca3b2d1a45 | PASS |
| 335 | check | (Retry-After) | - | 429 carries Retry-After >= 1 | 1 | 1 | PASS |
| 336 | check | (header) | - | 429 carries Cache-Control: private, no-cache | private, no-cache | private, no-cache | PASS |
| 337 | check | (header) | - | 429 echoes X-Request-Id | 057a23d9-792f-4b17-a82f-29ca3b2d1a45 | 057a23d9-792f-4b17-a82f-29ca3b2d1a45 | PASS |
| 338 | check | (status) | - | another user (patient-101) is not limited by patient-102's bucket | 200 | 200 | PASS |
| 339 | check | (429 count) | - | admin-9001: 7 DELETE + 7 PATCH + 6 POST (404/404/400) = 20 writes, none 429 | 0 | 0 | PASS |
| 340 | check | (status) | - | 21st write (any verb, one shared bucket) in a minute -> 429 | 429 | 429 | PASS |
| 341 | check | (code) | - | 429 on write is the RateLimited envelope | RateLimited | RateLimited | PASS |
| 342 | check | (status) | - | admin-9001 reads use a separate bucket -> still 200 | 200 | 200 | PASS |
| 343 | check | (status) | - | POST by the exhausted admin -> 429 (not 201) | 429 | 429 | PASS |
| 344 | check | (rows) | - | no article was created by the limited POST | 0 | 0 | PASS |

### 11. Server log hygiene

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 345 | check | (leaked signatures) | - | no bearer token signature appears in the log | 0 | 0 | PASS |
| 346 | check | (matches) | - | no Authorization header value in the log | 0 | 0 | PASS |
| 347 | check | (matches) | - | no article body marker in the log | 0 | 0 | PASS |
| 348 | check | (matches) | - | no fixture title in the log | 0 | 0 | PASS |
| 349 | check | (concrete ids) | - | request_completed route labels are the patterns, never a concrete id | 0 | 0 | PASS |
| 350 | check | (lines) | - | route label /api/help-articles/:id is used | 1 | 1 | PASS |
| 351 | check | (error lines) | - | no error-level log line | 0 | 0 | PASS |
| 352 | check | (5xx) | - | no 5xx request_completed | 0 | 0 | PASS |

## Cases, Redis-down smoke run

Server with Redis unreachable; `REDIS_URL` unset in the script.

### Redis-down smoke (server cannot reach Redis): CRUD works, idempotency and rate-limit step aside

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 1 | GET | /api/help-articles | none | no token: GET list | 401 Unauthorized | 401 Unauthorized | PASS |
| 2 | GET | /api/help-articles | patient | patient list (empty table) | 200 ok | 200 ok | PASS |
| 3 | POST | /api/help-articles | admin | admin creates a published patient article | 201 ok | 201 ok | PASS |
| 4 | GET | /api/help-articles/267 | patient | patient reads it by id | 200 ok | 200 ok | PASS |
| 5 | GET | /api/help-articles | patient | patient list shows it | 200 ok | 200 ok | PASS |
| 6 | check | (patient list contains the created id) | - | list ids | 267 | 267 | PASS |
| 7 | POST | /api/help-articles | admin | duplicate title -> 409 Conflict (DB unique index; no Redis involved) | 409 Conflict | 409 Conflict | PASS |
| 8 | check | (POST x2 same key) | - | idempotency with Redis down steps aside (no 5xx) | 201 409 | 201 409 | PASS |
| 9 | PATCH | /api/help-articles/267 | admin | patch title | 200 ok | 200 ok | PASS |
| 10 | PATCH | /api/help-articles/267 | admin | patch no-op | 200 ok | 200 ok | PASS |
| 11 | DELETE | /api/help-articles/267 | admin | delete | 204 ok | 204 ok | PASS |
| 12 | GET | /api/help-articles/267 | admin | get after delete -> 404 | 404 NotFound | 404 NotFound | PASS |
| 13 | POST | /api/help-articles | patient | patient write -> 403 | 403 Forbidden | 403 Forbidden | PASS |
