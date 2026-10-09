---
title: audit — Manual QA (CURL)
owner: care-team
service: care-service
module: audit
status: ready
diataxis: how-to
last_verified: 2026-10-09
tags: [manual-qa, audit, audit-logs, pagination, keyset, partitions, rbac, rate-limit]
related: [audit-spec, audit-tasks, admin-doctors-manual-qa]
---

# audit — Manual QA (CURL)

_Run: 2026-10-09 • Server: http://127.0.0.1:3041 • Result: 122 pass / 0 fail_ (two consecutive full runs on the same database, both 122 / 0; the table is the second run, which also proves the script is repeatable)

## Environment

The real Care HTTP listener (`npx tsx src/server.ts`, `NODE_ENV=development`, public port 3041, internal 3141) ran against a throwaway database `care_qa_audit` on the local Postgres 18 cluster (`127.0.0.1:5434`, extensions `btree_gist`, `citext`), migrated with the repo CLI (`src/migrate.ts latest`, then `ensure-app-login`, so the API connected as `care_app`, not the owner). Redis was Memurai on `localhost:6379` db index 13 (flushed at the start of each run and at the end). **No worker was run**: this endpoint is read-only, and the script creates the extra monthly partitions itself. The database was dropped and every process stopped at the end of the session.

**Identity.** The endpoint calls Identity only for JWKS. `scripts/admin-doctors-qa-fake-identity.mjs` (port 3022, unchanged) served the JWKS and minted EdDSA user tokens (admin, patient, doctor, expired, an admin whose token carries `status=suspended`, and numbered admins `admin-11..13`, `admin-90`, `admin-91`).
**Object storage.** MinIO was unavailable; this slice makes no storage call (`STORAGE_ENDPOINT=http://127.0.0.1:9`, dummy credentials).

**Fixtures (synthetic, no PII exists in this table).** The script creates monthly partitions for the last ~5 months as the owner (plus `GRANT SELECT` to `vcare_app`), truncates `audit_logs`, and seeds 20 rows with explicit `created_at` through the owner connection: 5 rows sharing one `created_at` (tie group), two rows that differ only in microseconds, rows exactly at, one second before, and 24 h after a boundary instant, rows at 1, 2, 3, 4, 6, 7, 29, 31, 45, 75, and 105 days back (the 31, 45, 75 and 105 day rows sit in different monthly partitions; `audit_logs_default` stays empty), a `service` and a `system` actor (null `actorUserId`), and one metadata object with string/number/boolean/null scalars. One more row is written by the real write path (`POST /api/specialties`) and read back. Metadata values are ids, statuses and counters plus a marker string (`SYNTH-META-7731`) used to prove the log scan.

Every call sent a fresh UUID `X-Request-Id`; every row checked that it was echoed and that `Cache-Control: no-store` was present. Error rows checked HTTP status, `success=false`, `error.code`, a string `error.message`, a `details` array, and `error.requestId` equal to the sent id, and where relevant `details[0].field` / `issue`. Success rows checked `success=true` plus case-specific assertions: the nine `AuditLogEntry` keys exactly (and no more), `actorRole` enum, `requestId` UUID-or-null, `createdAt` ISO millisecond UTC, `meta` keys exactly `nextCursor, hasMore, count`, ordering, and the exact id sequence compared with an owner-side SQL query. No token, cursor or response body is recorded here.

Re-run: start the fake Identity, then `src/server.ts` as in the header of `scripts/curl-test-audit.sh`, then
`CARE_OWNER_DATABASE_URL=postgres://<owner>@127.0.0.1:5434/care_qa_audit CARE_URL=http://127.0.0.1:3041 FAKE_IDENTITY_URL=http://127.0.0.1:3022 REDIS_URL=redis://localhost:6379/13 SERVER_LOG=<care-api log> bash scripts/curl-test-audit.sh` (about 1 minute). The script refuses a database whose name does not end in `_test` or contain `_qa`; the rate-limit section expects a flushed Redis db (the script flushes `REDIS_URL` itself).

## Endpoints covered

`GET /api/audit-logs` (`listAuditLogs`): default window, `limit` bounds, keyset paging with ties and microsecond-only differences, the frozen `to` window, every filter (`actorUserId`, `action`, `entityType`, `entityId`, `from`, `to`) alone and combined, cross-field rules, ISO-8601/offset parsing, cursor tampering, unknown/duplicated keys, 401/403 matrix, privacy (no audit row, no clinical keys, log scan), real write-path round trip, and the 120/min limiter.

## Cases

Rows with method `check` are non-HTTP assertions (owner SQL, header checks, equality of walked id lists with the SQL order). For `check` rows `Expected` / `Got` are the compared values.

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 1 | check | `audit_logs` | owner | seeded rows, none in audit_logs_default | 0 | 0 | PASS |
| 2 | check | `audit_logs` | owner | seeded rows (20) | 20 | 20 | PASS |
| 3 | check | `audit_logs` | owner | old rows live in >= 3 distinct monthly partitions | 1 | 1 | PASS |
| 4 | GET | `/api/audit-logs` | none | no token | 401 Unauthorized | 401 Unauthorized | PASS |
| 5 | GET | `/api/audit-logs` | admin | expired token | 401 TokenExpired | 401 TokenExpired | PASS |
| 6 | GET | `/api/audit-logs` | none | garbage bearer | 401 Unauthorized | 401 Unauthorized | PASS |
| 7 | GET | `/api/audit-logs` | patient | wrong role | 403 Forbidden | 403 Forbidden | PASS |
| 8 | GET | `/api/audit-logs` | doctor | wrong role | 403 Forbidden | 403 Forbidden | PASS |
| 9 | GET | `/api/audit-logs` | admin-suspended | admin token with status=suspended | 403 Forbidden | 403 Forbidden | PASS |
| 10 | GET | `/api/audit-logs?actorUserId=11` | patient | wrong role with filters; no data | 403 Forbidden | 403 Forbidden | PASS |
| 11 | check | `/api/audit-logs` | patient | spoofed X-Role: admin header ignored | 403 | 403 | PASS |
| 12 | GET | `/api/audit-logs` | admin | default: last 30 days, newest first, contract shape, no-store, request id echoed | 200 | 200 | PASS |
| 13 | GET | `/api/audit-logs?limit=100` | admin | default window excludes rows older than 30 days (29d in, 31d out) | 200 | 200 | PASS |
| 14 | check | `/api/audit-logs` | admin | valid incoming X-Request-Id adopted/echoed | 1 | 1 | PASS |
| 15 | check | `/api/audit-logs` | admin | invalid X-Request-Id regenerated (not echoed verbatim) | 1 | 1 | PASS |
| 16 | check | `/api/audit-logs` | admin | Cache-Control no-store on 200 | 1 | 1 | PASS |
| 17 | GET | `/api/audit-logs?limit=1` | admin | limit=1 | 200 | 200 | PASS |
| 18 | GET | `/api/audit-logs?limit=100` | admin | limit=100 | 200 | 200 | PASS |
| 19 | GET | `/api/audit-logs?limit=0` | admin | limit=0 rejected | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 20 | GET | `/api/audit-logs?limit=101` | admin | limit=101 rejected | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 21 | GET | `/api/audit-logs?limit=-1` | admin | limit=-1 rejected | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 22 | GET | `/api/audit-logs?limit=1.5` | admin | limit=1.5 rejected | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 23 | GET | `/api/audit-logs?limit=abc` | admin | limit=abc rejected | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 24 | GET | `/api/audit-logs?limit=` | admin | limit= rejected | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 25 | check | `/api/audit-logs?limit=2` | admin | walk every page via nextCursor == SQL order (no gap, no duplicate) | 136,135,134,133,132,131,137,143,139,138,144,145,142,140,141,146 | 136,135,134,133,132,131,137,143,139,138,144,145,142,140,141,146 | PASS |
| 26 | check | `/api/audit-logs?limit=2` | admin | walk used ceil(n/2) pages (8) | 1 | 1 | PASS |
| 27 | check | `/api/audit-logs?limit=2` | admin | walked ids unique | 1 | 1 | PASS |
| 28 | check | `/api/audit-logs?limit=2&action=qa.tie` | admin | tie group (5 equal created_at) paged 2/2/1, id DESC, complete | 135,134,133,132,131;3 | 135,134,133,132,131;3 | PASS |
| 29 | check | `/api/audit-logs?limit=1&action=qa.micro` | admin | microsecond-only differing rows: no skip/repeat across pages | 139,138;2 | 139,138;2 | PASS |
| 30 | check | `/api/audit-logs?action=qa.micro` | admin | microsecond rows ordered by full-precision created_at | 1 | 1 | PASS |
| 31 | check | `/api/audit-logs` | admin | last page: 200, count=1, hasMore=false, nextCursor=null | 1 | 1 | PASS |
| 32 | check | `/api/audit-logs` | admin | cursor payload has t (6 fraction digits), id and frozen to | 1 | 1 | PASS |
| 33 | check | `/api/audit-logs` | admin | page 2 after a later insert (no to): new row absent | 1 | 1 | PASS |
| 34 | GET | `/api/audit-logs?limit=1` | admin | fresh page 1 now shows the new row | 200 | 200 | PASS |
| 35 | GET | `/api/audit-logs?actorUserId=12&limit=100` | admin | actorUserId=12 only that actor | 200 | 200 | PASS |
| 36 | GET | `/api/audit-logs?actorUserId=999999` | admin | actorUserId with no rows -> empty 200 | 200 | 200 | PASS |
| 37 | GET | `/api/audit-logs?action=qa.svc` | admin | action exact; includes service actor with actorUserId null | 200 | 200 | PASS |
| 38 | GET | `/api/audit-logs?action=QA.SVC` | admin | action is case-sensitive | 200 | 200 | PASS |
| 39 | GET | `/api/audit-logs?action=qa%25` | admin | action with % is literal (no LIKE) | 200 | 200 | PASS |
| 40 | GET | `/api/audit-logs?action=qa._ic` | admin | action with _ is literal | 200 | 200 | PASS |
| 41 | GET | `/api/audit-logs?action=qa%27%20OR%201%3D1--` | admin | SQL metacharacters in action are inert | 200 | 200 | PASS |
| 42 | GET | `/api/audit-logs?entityType=qa_one&limit=100` | admin | entityType alone allowed | 200 | 200 | PASS |
| 43 | GET | `/api/audit-logs?entityType=qa_one&entityId=701` | admin | entityType+entityId pair | 200 | 200 | PASS |
| 44 | GET | `/api/audit-logs?entityType=qa_two&entityId=701` | admin | entityType/entityId mismatched pair -> empty | 200 | 200 | PASS |
| 45 | GET | `/api/audit-logs?entityId=701` | admin | entityId without entityType | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 46 | GET | `/api/audit-logs?actorUserId=0` | admin | actorUserId=0 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 47 | GET | `/api/audit-logs?actorUserId=007` | admin | actorUserId=007 (non strict integer) | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 48 | GET | `/api/audit-logs?actorUserId=1e3` | admin | actorUserId=1e3 (non strict integer) | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 49 | GET | `/api/audit-logs?actorUserId=1.5` | admin | actorUserId=1.5 (non strict integer) | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 50 | GET | `/api/audit-logs?actorUserId=%2B1` | admin | actorUserId=+1 (non strict integer) | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 51 | GET | `/api/audit-logs?actorUserId=abc` | admin | actorUserId=abc (non strict integer) | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 52 | GET | `/api/audit-logs?actorUserId=` | admin | actorUserId=-1 (non strict integer) | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 53 | GET | `/api/audit-logs?entityType=qa_one&entityId=0` | admin | entityId=0 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 54 | GET | `/api/audit-logs?action=` | admin | empty action | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 55 | GET | `/api/audit-logs?entityType=` | admin | empty entityType | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 56 | GET | `/api/audit-logs?action=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` | admin | action 65 chars | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 57 | GET | `/api/audit-logs?action=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` | admin | action 64 chars accepted | 200 | 200 | PASS |
| 58 | GET | `/api/audit-logs?action=a%00b` | admin | action with NUL byte | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 59 | GET | `/api/audit-logs?action=qa.a&action=qa.b` | admin | duplicated key (array) | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 60 | GET | `/api/audit-logs?foo=1` | admin | unknown query key foo | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 61 | GET | `/api/audit-logs?requestId=9bae211f-4788-40e7-8d76-c3de7695fceb` | admin | unknown key requestId | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 62 | GET | `/api/audit-logs?metadata.x=1` | admin | unknown key metadata.x (no metadata filtering) | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 63 | GET | `/api/audit-logs?actorUserId=11&foo=1&limit=0` | admin | several invalid keys at once, no 500 | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 64 | GET | `/api/audit-logs?actorUserId=12&entityType=qa_one&entityId=701&action=qa.a&from=2026-10-07T02:01:40.825Z&to=2026-10-09T14:01:40.969` | admin | combination of all filters = intersection | 200 | 200 | PASS |
| 65 | GET | `/api/audit-logs?actorUserId=12&entityType=qa_one&entityId=701&action=qa.a&from=2026-10-07T02:01:41.687Z&to=2026-10-08T02:01:41.946` | admin | combination, window excludes the row -> empty | 200 | 200 | PASS |
| 66 | GET | `/api/audit-logs?actorUserId=12&entityType=qa_one&entityId=701&action=qa.b` | admin | combination, conflicting action -> empty | 200 | 200 | PASS |
| 67 | check | `/api/audit-logs?limit=1&entityType=qa_one&entityId=701` | admin | paging with a filter yields the rest (2 pages) | 136,137;2 | 136,137;2 | PASS |
| 68 | GET | `/api/audit-logs?limit=100&action=qa.svc&cursor=<cursor>` | admin | cursor reused with a different filter: only rows matching the new filter (position, not grant) | 200 | 200 | PASS |
| 69 | GET | `/api/audit-logs?from=2026-09-29T14:01:10.000Z&to=2026-09-30T14:01:10.000Z&limit=100` | admin | from inclusive, to exclusive: row at exactly from in, row at exactly to out | 200 | 200 | PASS |
| 70 | GET | `/api/audit-logs?from=2026-09-29T14:01:10.000Z&to=2026-09-29T14:01:10.000Z` | admin | from == to -> empty 200 | 200 | 200 | PASS |
| 71 | GET | `/api/audit-logs?from=2026-10-09T14:01:45.345Z&to=2026-10-09T13:01:45.463Z` | admin | from > to | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 72 | GET | `/api/audit-logs?from=2026-10-10T14:01:45.953Z` | admin | only from, later than now | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 73 | GET | `/api/audit-logs?from=2026-09-29T14:01:10.000Z&limit=100` | admin | from alone (to defaults to now) | 200 | 200 | PASS |
| 74 | GET | `/api/audit-logs?to=2026-09-30T14:01:10.000Z&limit=100` | admin | to alone (from = to - 30 days) | 200 | 200 | PASS |
| 75 | GET | `/api/audit-logs?from=2026-09-29T14:01:10.000Z&to=2026-09-30T14:01:10.000Z&limit=100` | admin | from offset form Z: same instant -> same result | 200 | 200 | PASS |
| 76 | GET | `/api/audit-logs?from=2026-09-29T16:01:10%2B02:00&to=2026-09-30T14:01:10.000Z&limit=100` | admin | from offset form : same instant -> same result | 200 | 200 | PASS |
| 77 | GET | `/api/audit-logs?from=2026-09-29T09:01:10-05:00&to=2026-09-30T14:01:10.000Z&limit=100` | admin | from offset form : same instant -> same result | 200 | 200 | PASS |
| 78 | GET | `/api/audit-logs?from=2026-09-29T16:01:10+02:00&to=2026-09-30T14:01:10.000Z` | admin | raw + offset (decoded to space) | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 79 | GET | `/api/audit-logs?to=2026-10-01` | admin | to=2026-10-01 rejected | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 80 | GET | `/api/audit-logs?to=2026-10-01T00:00:00` | admin | to=2026-10-01T00:00:00 rejected | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 81 | GET | `/api/audit-logs?to=2026-10-01T00:00:00%2B0100` | admin | to=2026-10-01T00:00:00%2B0100 rejected | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 82 | GET | `/api/audit-logs?to=2026-10-01t00:00:00z` | admin | to=2026-10-01t00:00:00z rejected | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 83 | GET | `/api/audit-logs?to=2026-10-01%2000:00:00Z` | admin | to=2026-10-01%2000:00:00Z rejected | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 84 | GET | `/api/audit-logs?to=2026-02-30T00:00:00Z` | admin | to=2026-02-30T00:00:00Z rejected | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 85 | GET | `/api/audit-logs?to=2026-10-01T24:00:00Z` | admin | to=2026-10-01T24:00:00Z rejected | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 86 | GET | `/api/audit-logs?to=2026-10-01T00:00:60Z` | admin | to=2026-10-01T00:00:60Z rejected | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 87 | GET | `/api/audit-logs?to=0000-01-01T00:00:00Z` | admin | to=0000-01-01T00:00:00Z rejected | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 88 | GET | `/api/audit-logs?to=1969-12-31T23:59:59Z` | admin | to=1969-12-31T23:59:59Z rejected | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 89 | GET | `/api/audit-logs?to=10000-01-01T00:00:00Z` | admin | to=10000-01-01T00:00:00Z rejected | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 90 | GET | `/api/audit-logs?to=1760000000` | admin | to=1760000000 rejected | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 91 | GET | `/api/audit-logs?from=2026-10-01T00:00:00.123456789Z&to=2026-10-09T14:01:53.603Z` | admin | nanosecond fraction accepted (truncated to ms) | 200 | 200 | PASS |
| 92 | GET | `/api/audit-logs?from=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` | admin | from longer than 40 chars | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 93 | GET | `/api/audit-logs?from=1970-01-01T00:00:00Z&to=9999-12-31T23:59:59Z&limit=100` | admin | 1970..9999 window accepted (no span cap); all rows reachable | 200 | 200 | PASS |
| 94 | check | `/api/audit-logs?limit=7&from=1970..to=9999` | admin | whole-table window paged: complete, ordered | 136,135,134,133,132,131,137,143,139,138,144,145,142,140,141,146,147,148,149,150 | 136,135,134,133,132,131,137,143,139,138,144,145,142,140,141,146,147,148,149,150 | PASS |
| 95 | GET | `/api/audit-logs?from=2026-06-11T14:01:56.479Z&to=2026-10-09T14:01:56.618Z&limit=100` | admin | window spanning several monthly partitions (105d back) | 200 | 200 | PASS |
| 96 | GET | `/api/audit-logs?from=2026-06-21T14:01:57.280Z&to=2026-07-01T14:01:57.529Z` | admin | narrow old window returns only the 105d row | 200 | 200 | PASS |
| 97 | GET | `/api/audit-logs?action=qa.old&from=2026-06-11T14:01:56.479Z&limit=2` | admin | old action page 1 of 2 | 200 | 200 | PASS |
| 98 | check | `/api/audit-logs?action=qa.old&from=-120d&limit=1` | admin | paging across partitions: 3 old rows in order | 148,149,150;3 | 148,149,150;3 | PASS |
| 99 | GET | `/api/audit-logs?cursor=notacursor` | admin | tampered cursor (random) | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 100 | GET | `/api/audit-logs?cursor=<cursor>` | admin | tampered cursor (base64-json-no-mac) | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 101 | GET | `/api/audit-logs?cursor=<cursor>` | admin | tampered cursor (flipped-mac) | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 102 | GET | `/api/audit-logs?cursor=<cursor>` | admin | tampered cursor (edited-payload-old-mac) | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 103 | GET | `/api/audit-logs?cursor=<cursor>` | admin | tampered cursor (flipped-payload-byte) | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 104 | GET | `/api/audit-logs?cursor=<cursor>` | admin | tampered cursor (empty-mac) | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 105 | GET | `/api/audit-logs?cursor=.` | admin | tampered cursor (dot-only) | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 106 | GET | `/api/audit-logs?cursor=<cursor>` | admin | tampered cursor (over-1024-chars) | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 107 | GET | `/api/audit-logs?cursor=%00%ff` | admin | tampered cursor (url-encoded-garbage) | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 108 | GET | `/api/audit-logs?cursor=` | admin | empty cursor | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 109 | check | `/api/audit-logs?cursor=<valid>` | admin | untampered cursor still accepted | 200 | 200 | PASS |
| 110 | GET | `/api/audit-logs?cursor=<cursor>` | admin | explicit to wins over cursor.to | 200 | 200 | PASS |
| 111 | check | `audit_logs` | owner | reads write no audit row (R9) | 20 | 20 | PASS |
| 112 | GET | `/api/audit-logs?action=qa.a` | admin | metadata passthrough verbatim (types preserved) | 200 | 200 | PASS |
| 113 | check | `/api/audit-logs` | admin | no password/token/secret/clinical key names in body | 1 | 1 | PASS |
| 114 | check | `/api/specialties` | admin | create specialty (seeds a real audit row) | 201 | 201 | PASS |
| 115 | GET | `/api/audit-logs?entityType=specialty&entityId=25` | admin | real audit row visible: action specialty.created, actor, request id | 200 | 200 | PASS |
| 116 | check | `server log` | none | no metadata marker / cursor / filter value in log | 0 | 0 | PASS |
| 117 | check | `server log` | none | audit-logs requests logged with route label, no 5xx | 1 | 1 | PASS |
| 118 | check | `/api/audit-logs?limit=1` | admin-90 | first 120 requests in the window succeed | 120 | 120 | PASS |
| 119 | GET | `/api/audit-logs?limit=1` | admin-90 | 121st request | 429 RateLimited | 429 RateLimited | PASS |
| 120 | check | `/api/audit-logs` | admin-90 | 429 carries Retry-After | 1 | 1 | PASS |
| 121 | GET | `/api/audit-logs?limit=1` | admin-91 | a second admin is unaffected | 200 | 200 | PASS |
| 122 | GET | `/api/audit-logs` | patient | denied role still 403 (not rate limited) | 403 Forbidden | 403 Forbidden | PASS |

## Failures / notes

- No real failures. Three failures seen while developing the script were wrong expectations in the script, not product defects, and were fixed before the two recorded runs: (1) assertions compared `metadata` key order, but the column is `jsonb` and Postgres normalises key order (values and types are returned verbatim); (2) the over-1024-character cursor is rejected by the shared DTO length validator, so `details[0].issue` is the validator text (`cursor must be shorter than or equal to 1024 characters`), not `is invalid` (field `cursor`, `400 ValidationFailed`, as the spec requires); (3) boundary instants were first computed from the test-time clock instead of the seeded rows.
- Rate limit: 120 requests by one admin passed, the 121st answered `429 RateLimited` with `Retry-After`, a second admin was unaffected, and the denied role stayed `403`.
- Cross-partition window: rows 31, 45, 75 and 105 days back sit in different monthly partitions and were returned in order by one request and by a cursor walk; `audit_logs_default` was empty.

## Not verified here

- **EXPLAIN / partition pruning and index use** with bound parameters (spec 9.4): only a manual plan of the equivalent window (literal now() bounds) showed monthly partitions outside the window absent; the structural assertions stay with the integration test.
- **Verification-queue cursor** presented to this route (spec 9.3 tamper list): no queue cursor was minted in this run; a random string, a no-MAC payload, a flipped MAC, a flipped payload byte, an edited payload with the old MAC, an empty MAC, a dot-only value and an over-long value were covered.
- **Rotated `SERVICE_CLIENT_SECRET`** invalidating open cursors: the secret was not rotated mid-run.
- **Redis down** behaviour of the limiter (fail-open) and the `statement_timeout` path (500 without leaking filter values): not exercised.
- **`audit-partitions` worker loop** creating future partitions: no worker was run; the partitions were created by the script as the owner.
- **Latency budget** (p95 < 200 ms at ~3 M rows): not measured; the table held about 25 rows.
- The log scan covers the API log of this run only (no cursor, filter value, metadata marker or bearer token found; no 5xx logged).
