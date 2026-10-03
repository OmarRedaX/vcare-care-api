---
title: access — Manual QA (CURL)
owner: care-team
service: care-service
module: access
status: passed
diataxis: how-to
last_verified: 2026-10-03
tags: [manual-qa, curl, access, auth, jwks, user-guard, rbac, authorize, audit, audit-logs, idempotency, redis-breaker, health, logging]
related: [access-spec, access-tasks, access-brainstorm, rbac, resilience, integration, runbook, quickstart, foundation-manual-qa, adr-0006-health-split-redis-tier-2, adr-0009-audit-logs-monthly-partitions, adr-0018-db-role-split-explicit-grants-partition-function]
contracts: [contracts/openapi.yaml]
---

# access — Manual QA (CURL)

_Run: 2026-10-03 • Server: http://localhost:3001 (real Identity tokens) + http://localhost:3011 (edge tokens) •
Result: 167 pass / 0 fail (143 scripted + 12 JWKS-outage + 7 Redis-stall + 5 log/worker checks) •
Re-run after the code-review fixes: 143 / 143 scripted + 3 checks (see "Re-run after fix-review")_

`access` adds no business route. Spec §3.1 says it is exercised through **test-only routers**. The dev-only harness
`scripts/access-qa-server.ts` mounts them on the real public app, never in `src/routes.ts` and never in the contract.
Expected values come from `contracts/openapi.yaml` (`ErrorEnvelope`, `ErrorCode`, `HealthStatus` with
`checks.identityJwks` = C1), from spec §3.3.6 (guard outcomes), §3.4.3 (authorize step order), §3.5 (audit write),
§9.3 (router policies) and §12 (fixes #5 #6 #10 #11), and from CLAUDE.md → API conventions (idempotency). Each
enveloped response was also checked for `success`, `error.code`, `error.requestId` equal to the sent
`X-Request-Id`, and the echoed `X-Request-Id` header.

## Environment

| Component | Where | How it was started |
|---|---|---|
| Identity (real, `feature/auth`) | public `:3020`, internal `:3120` | `cd ../vcare-identity-api && PORT=3020 INTERNAL_PORT=3120 npx tsx --env-file-if-exists=.env src/server.ts` |
| Identity worker (first run only) | — | `npx tsx --env-file-if-exists=.env src/worker.ts`. Delivers registration codes to `.local/mail/outbox.jsonl` (`EMAIL_PROVIDER=capture`). Stopped after the accounts existed. |
| Care access harness (real tokens) | `:3001` | `npx tsx --env-file-if-exists=.env scripts/access-qa-server.ts > <log>`. `IDENTITY_JWKS_URL` = Identity's JWKS. |
| Fake identity (edge-token mint + JWKS) | `127.0.0.1:3021` | `FAKE_IDENTITY_PORT=3021 npx tsx scripts/access-qa-fake-identity.ts` |
| Care access harness (edge tokens) | `:3011` | `PORT=3011 IDENTITY_JWKS_URL=http://127.0.0.1:3021/.well-known/jwks.json npx tsx --env-file-if-exists=.env scripts/access-qa-server.ts` |
| Care data | native Postgres 18 `:5432` DB `vcare_care` (app role `care_app`; owner for the `audit_logs` checks); native Redis `:6379` DB 1 | `.env` |

**QA accounts** are fully synthetic (`qa.access.<role>@example.test`). The patient and doctor were created through
Identity's real `register/start` → emailed code → `register/complete` flow. The admin was registered the same way
and then promoted (`UPDATE users SET role='admin'`, as in Identity's runbook "Create an admin account"). Real
tokens come from `POST /api/auth/login`. The status and email variants (unverified patient, pending patient,
rejected and active doctor) are set in Identity's database right before each login. That is QA-only and writes no
`user_status_changes` row. This run's Identity user ids were patient 1, doctor 2, admin 3. Real Identity cannot
issue claim-level edge cases (expired, wrong `aud`/`iss`/`typ`, missing claims, `alg: none`, HS256, suspended status).
Those tokens are minted by the fake identity with fresh in-memory Ed25519 keys, and the second harness verifies them.
No token, password, cookie, or email address is recorded here or in any file.

**Harness change (dev-only, `scripts/`):** `scripts/access-qa-server.ts` now also mounts `buildAuditTestRouter`,
`buildParamRouter`, `buildNestedRouter`, `buildIdempotencyRouter` and `buildRateLimitRouter("qa-limited", 3, 1000)`.
Before this change only `buildAccessTestRouter` was mounted, so audit, #5, #6 and #11 could not be reached by
CURL. No `src/` file changed.

## Re-run

```bash
# Identity running (see Environment); its worker too on the very first run (creates the QA accounts).
npx tsx --env-file-if-exists=.env scripts/access-qa-server.ts > /tmp/care-3001.log 2>&1 &
QA_PASSWORD='<synthetic>' \
IDENTITY_DATABASE_URL='postgres://<identity user>:<pw>@localhost:5432/vcare_identity' \
CARE_LOG_FILE=/tmp/care-3001.log \
  ./scripts/curl-test-access.sh     # starts/stops the fake identity + edge harness itself (START_EDGE=1)
```
The script exits non-zero on any failure. It includes a 61 s wait so that the per-minute JWKS demand-fetch gate is
open before the rotation cases (skip it with `SKIP_JWKS_GATE_CASES=1`). Identity limits login to 5/min per
IP+email, so wait about a minute between runs. The JWKS outage (O-cases) and the Redis stall (R-cases) were driven
by hand. Their steps are below.

## Cases

### Scripted — `scripts/curl-test-access.sh` (final run against the restarted harness: 143 pass / 0 fail)
"(edge)" = the `:3011` harness with fake-JWKS tokens. "Role" is the token principal.

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| A1 | GET | `/api/__test/access/any` | none | no Authorization header | 401 Unauthorized | 401 Unauthorized | pass |
| A2 | GET | `/api/__test/access/any` | none | Basic scheme | 401 Unauthorized | 401 Unauthorized | pass |
| A3 | GET | `/api/__test/access/any` | none | Bearer with empty token | 401 Unauthorized | 401 Unauthorized | pass |
| A4 | GET | `/api/__test/access/any` | none | Bearer with two tokens | 401 Unauthorized | 401 Unauthorized | pass |
| A5 | GET | `/api/__test/access/any` | none | malformed JWT (not-a-jwt) | 401 Unauthorized | 401 Unauthorized | pass |
| A6 | GET | `/api/__test/access/any` | none | malformed JWT (a.b.c) | 401 Unauthorized | 401 Unauthorized | pass |
| A7 | GET | `/api/__test/access/admin` | patient (tampered→admin) | tampered real token (role→admin) | 401 Unauthorized | 401 Unauthorized | pass |
| A8 | GET | `/api/__test/access/any` | none | real token + 4100 chars (over 4096) | 401 Unauthorized | 401 Unauthorized | pass |
| A9 | GET | `/api/__test/access/any` | patient | real patient token | 200 patient | 200 patient | pass |
| A10 | GET | `/api/__test/access/any` | doctor | real active doctor token | 200 doctor | 200 doctor | pass |
| A11 | GET | `/api/__test/access/any` | admin | real admin token | 200 admin | 200 admin | pass |
| A12 | GET | `/api/__test/access/any` | patient | lower-case 'bearer' scheme accepted | 200 patient | 200 patient | pass |
| A13 | GET | `/api/__test/access/any` | patient | X-User-Id / X-Role headers ignored | 200 patient | 200 patient | pass |
| A14 | GET | `/api/__test/access/admin` | patient | X-Role: admin does not unlock admin route | 403 Forbidden | 403 Forbidden | pass |
| A15 | GET | `/api/__test/access/any` | patient (foreign key) | token from a foreign key (kid unknown to Identity) | 401 Unauthorized | 401 Unauthorized | pass |
| A16 | GET | `/api/__test/access/any` | none | invalid X-Request-Id replaced by a generated UUID | 401 + uuid | 401 uuid | pass |
| A17 | GET | `/api/__test/access/any` | patient | any: unverified patient (no email gate) | 200 patient | 200 patient | pass |
| A18 | GET | `/api/__test/access/any` | patient | any: pending patient | 403 Forbidden | 403 Forbidden | pass |
| A19 | GET | `/api/__test/access/any` | doctor | any: pending doctor (active required) | 403 Forbidden | 403 Forbidden | pass |
| A20 | GET | `/api/__test/access/any` | doctor | any: rejected doctor | 403 Forbidden | 403 Forbidden | pass |
| A21 | GET | `/api/__test/access/admin` | none | admin: no token | 401 Unauthorized | 401 Unauthorized | pass |
| A22 | GET | `/api/__test/access/admin` | patient | admin: patient | 403 Forbidden | 403 Forbidden | pass |
| A23 | GET | `/api/__test/access/admin` | doctor | admin: active doctor | 403 Forbidden | 403 Forbidden | pass |
| A24 | GET | `/api/__test/access/admin` | admin | admin: admin | 200 admin | 200 admin | pass |
| A25 | GET | `/api/__test/access/onboarding` | none | onboarding: no token | 401 Unauthorized | 401 Unauthorized | pass |
| A26 | GET | `/api/__test/access/onboarding` | doctor | onboarding: pending doctor | 200 doctor | 200 doctor | pass |
| A27 | GET | `/api/__test/access/onboarding` | doctor | onboarding: rejected doctor | 200 doctor | 200 doctor | pass |
| A28 | GET | `/api/__test/access/onboarding` | doctor | onboarding: active doctor | 200 doctor | 200 doctor | pass |
| A29 | GET | `/api/__test/access/onboarding` | patient | onboarding: patient | 403 Forbidden | 403 Forbidden | pass |
| A30 | GET | `/api/__test/access/onboarding` | admin | onboarding: admin | 403 Forbidden | 403 Forbidden | pass |
| A31 | POST | `/api/__test/access/verified` | none | verified: no token | 401 Unauthorized | 401 Unauthorized | pass |
| A32 | POST | `/api/__test/access/verified` | patient | verified: verified patient | 201 patient | 201 patient | pass |
| A33 | POST | `/api/__test/access/verified` | patient | verified: unverified patient | 403 EmailNotVerified | 403 EmailNotVerified | pass |
| A34 | POST | `/api/__test/access/verified` | patient | verified: pending patient (status before email) | 403 Forbidden | 403 Forbidden | pass |
| A35 | POST | `/api/__test/access/verified` | doctor | verified: active doctor | 403 Forbidden | 403 Forbidden | pass |
| A36 | POST | `/api/__test/access/verified` | admin | verified: admin | 403 Forbidden | 403 Forbidden | pass |
| A37 | GET | `/api/__test/access/owned/1` | none | owned/1: no token | 401 Unauthorized | 401 Unauthorized | pass |
| A38 | GET | `/api/__test/access/owned/1` | patient | owned/1: patient non-owner → 404 | 404 NotFound | 404 NotFound | pass |
| A39 | GET | `/api/__test/access/owned/1` | doctor | owned/1: doctor non-owner → 403 | 403 Forbidden | 403 Forbidden | pass |
| A40 | GET | `/api/__test/access/owned/1` | admin | owned/1: admin (role not listed) | 403 Forbidden | 403 Forbidden | pass |
| A41 | GET | `/api/__test/access/owned/999` | patient | owned/999: unknown id | 404 NotFound | 404 NotFound | pass |
| A42 | GET | `/api/__test/access/owned/abc` | patient | owned/abc: non-numeric id | 404 NotFound | 404 NotFound | pass |
| A43 | GET | `/api/__test/access/owned/1` | patient | owned/1: pending patient → 403 before ownership | 403 Forbidden | 403 Forbidden | pass |
| A44 | GET | `/api/__test/access/checked` | doctor | checked: active doctor (not blocked) | 200 doctor | 200 doctor | pass |
| A45 | GET | `/api/__test/access/checked` | admin | checked: admin | 200 admin | 200 admin | pass |
| A46 | GET | `/api/__test/access/checked` | patient | checked: patient | 403 Forbidden | 403 Forbidden | pass |
| A47 | GET | `/api/__test/access/checked` | doctor | checked: pending doctor | 403 Forbidden | 403 Forbidden | pass |
| A48 | GET | `/api/__test/access/does-not-exist` | admin | unknown test route (fail closed → 404) | 404 NotFound | 404 NotFound | pass |
| A49 | GET | `/api/__test/access/any (edge)` | patient (minted) | rotation: token signed by a newly published kid | 200 patient | 200 patient | pass |
| A50 | GET | `/.well-known/jwks.json` | — | rotation: exactly one extra JWKS fetch | +1 | +1 | pass |
| A51 | GET | `/api/__test/access/any (edge)` | patient (minted) | unknown kid within the minute (gated) | 401 Unauthorized | 401 Unauthorized | pass |
| A52 | GET | `/.well-known/jwks.json` | — | unknown kid within the minute: no extra JWKS fetch | +0 | +0 | pass |
| A53 | GET | `/api/__test/access/any (edge)` | patient (minted) | expired (exp 10 min ago) | 401 TokenExpired | 401 TokenExpired | pass |
| A54 | GET | `/api/__test/access/any (edge)` | patient (minted) | expired 20 s ago (within 30 s tolerance) | 200 patient | 200 patient | pass |
| A55 | GET | `/api/__test/access/any (edge)` | patient (minted) | expired AND bad signature → Unauthorized | 401 Unauthorized | 401 Unauthorized | pass |
| A56 | GET | `/api/__test/access/any (edge)` | patient (minted) | nbf 120 s in the future | 401 Unauthorized | 401 Unauthorized | pass |
| A57 | GET | `/api/__test/access/any (edge)` | patient (minted) | nbf 20 s in the future (tolerance) | 200 patient | 200 patient | pass |
| A58 | GET | `/api/__test/access/any (edge)` | patient (minted) | edge token: wrong-aud | 401 Unauthorized | 401 Unauthorized | pass |
| A59 | GET | `/api/__test/access/any (edge)` | patient (minted) | edge token: wrong-iss | 401 Unauthorized | 401 Unauthorized | pass |
| A60 | GET | `/api/__test/access/any (edge)` | patient (minted) | edge token: typ-service | 401 Unauthorized | 401 Unauthorized | pass |
| A61 | GET | `/api/__test/access/any (edge)` | patient (minted) | edge token: no-sub | 401 Unauthorized | 401 Unauthorized | pass |
| A62 | GET | `/api/__test/access/any (edge)` | patient (minted) | edge token: no-exp | 401 Unauthorized | 401 Unauthorized | pass |
| A63 | GET | `/api/__test/access/any (edge)` | patient (minted) | edge token: no-iat | 401 Unauthorized | 401 Unauthorized | pass |
| A64 | GET | `/api/__test/access/any (edge)` | patient (minted) | edge token: no-jti | 401 Unauthorized | 401 Unauthorized | pass |
| A65 | GET | `/api/__test/access/any (edge)` | patient (minted) | edge token: sub-zero | 401 Unauthorized | 401 Unauthorized | pass |
| A66 | GET | `/api/__test/access/any (edge)` | patient (minted) | edge token: sub-nonnumeric | 401 Unauthorized | 401 Unauthorized | pass |
| A67 | GET | `/api/__test/access/any (edge)` | patient (minted) | edge token: sub-unsafe | 401 Unauthorized | 401 Unauthorized | pass |
| A68 | GET | `/api/__test/access/any (edge)` | patient (minted) | edge token: role-bogus | 401 Unauthorized | 401 Unauthorized | pass |
| A69 | GET | `/api/__test/access/any (edge)` | patient (minted) | edge token: status-bogus | 401 Unauthorized | 401 Unauthorized | pass |
| A70 | GET | `/api/__test/access/any (edge)` | patient (minted) | edge token: ev-string | 401 Unauthorized | 401 Unauthorized | pass |
| A71 | GET | `/api/__test/access/any (edge)` | patient (minted) | edge token: jti-too-long | 401 Unauthorized | 401 Unauthorized | pass |
| A72 | GET | `/api/__test/access/any (edge)` | patient (minted) | edge token: no-kid | 401 Unauthorized | 401 Unauthorized | pass |
| A73 | GET | `/api/__test/access/any (edge)` | patient (minted) | edge token: tampered | 401 Unauthorized | 401 Unauthorized | pass |
| A74 | GET | `/api/__test/access/any (edge)` | patient (minted) | edge token: alg-none | 401 Unauthorized | 401 Unauthorized | pass |
| A75 | GET | `/api/__test/access/any (edge)` | patient (minted) | edge token: hs256 | 401 Unauthorized | 401 Unauthorized | pass |
| A76 | GET | `/api/__test/access/any (edge)` | patient (minted) | edge token: oversize | 401 Unauthorized | 401 Unauthorized | pass |
| A77 | GET | `/api/__test/access/any (edge)` | patient | any: suspended patient | 403 Forbidden | 403 Forbidden | pass |
| A78 | GET | `/api/__test/access/any (edge)` | admin | any: pending admin | 403 Forbidden | 403 Forbidden | pass |
| A79 | GET | `/api/__test/access/onboarding (edge)` | doctor | onboarding: suspended doctor | 403 Forbidden | 403 Forbidden | pass |
| A80 | POST | `/api/__test/access/verified (edge)` | patient | verified: suspended patient → Forbidden | 403 Forbidden | 403 Forbidden | pass |
| A81 | GET | `/api/__test/access/owned/1 (edge)` | patient | owned/1: owner patient 101 | 200 patient | 200 patient | pass |
| A82 | GET | `/api/__test/access/owned/2 (edge)` | patient | owned/2: patient 101 non-owner → 404 | 404 NotFound | 404 NotFound | pass |
| A83 | GET | `/api/__test/access/owned/1 (edge)` | doctor | owned/1: owner doctor 101 | 200 doctor | 200 doctor | pass |
| A84 | GET | `/api/__test/access/owned/2 (edge)` | doctor | owned/2: doctor 101 non-owner → 403 | 403 Forbidden | 403 Forbidden | pass |
| A85 | GET | `/api/__test/access/owned/1 (edge)` | patient | owned/1: body ownerUserId=101 from patient 102 still 404 | 404 NotFound | 404 NotFound | pass |
| A86 | GET | `/api/__test/access/owned/1 (edge)` | patient | owned/1: suspended patient → 403 before ownership | 403 Forbidden | 403 Forbidden | pass |
| A87 | GET | `/api/__test/access/checked (edge)` | doctor | checked: doctor 9001 (blocked check) | 403 Forbidden | 403 Forbidden | pass |
| A88 | GET | `/api/__test/access/checked (edge)` | admin | checked: admin 9001 (check not applicable) | 200 admin | 200 admin | pass |
| A89 | GET | `/api/__test/access/checked (edge)` | doctor | checked: doctor 201 | 200 doctor | 200 doctor | pass |
| A90 | POST | `/api/__test/audit` | none | audit: no token | 401 Unauthorized | 401 Unauthorized | pass |
| A91 | POST | `/api/__test/audit` | patient | audit: patient | 403 Forbidden | 403 Forbidden | pass |
| A92 | POST | `/api/__test/audit` | admin | audit: admin commit → 201 | 201 recorded=true | 201 recorded=true | pass |
| A93 | SQL | `audit_logs` (owner) | admin | audit row: actor_user_id / actor_role / action / entity_type / entity_id / metadata / partition | 3 / admin / test.performed / test_entity / 1 / {"reason": "synthetic"} / audit_logs_y2026m10 | identical | pass |
| A94 | SQL | `audit_logs` | — | audit: exactly one row for the request id | 1 | 1 | pass |
| A95 | POST | `/api/__test/audit` | admin | audit: rollback (fail=true) → 500 | 500 InternalError | 500 InternalError | pass |
| A96 | SQL | `audit_logs` | — | audit: rollback leaves no row | 0 | 0 | pass |
| A97 | POST | `/api/__test/audit` | admin | audit: clinical key in metadata → 500 | 500 InternalError | 500 InternalError | pass |
| A98 | SQL | `audit_logs` | — | audit: invalid metadata leaves no row | 0 | 0 | pass |
| A99 | SQL | `audit_logs` | — | audit: no clinical fixture in any row | 0 | 0 | pass |
| A100 | GET | `/api/__test/params/%E0%A4%A` | patient | params/%E0%A4%A with token → 400 ValidationFailed (path) | 400 ValidationFailed path | 400 ValidationFailed path | pass |
| A101 | GET | `/api/__test/params/%E0%A4%A` | none | params/%E0%A4%A without token → handled 4xx, never 500 | 400 or 401 (never 500) | 400 ValidationFailed | pass |
| A102 | GET | `/api/__test/params/ok-value` | patient | params/ok-value with patient token | 200 | 200 | pass |
| A103 | — | `grep CARE_LOG_FILE` | — | #5 logs: no raw value, no unhandled_error | 0/0 | 0/0 | pass |
| A104 | GET | `/api/__test/nested/inner/boom/42` | none | nested/inner/boom/42 → 500 InternalError | 500 InternalError | 500 InternalError | pass |
| A105 | GET | `/api/__test/nested/guarded/boom/42` | admin | nested/guarded/boom/42 admin → 500 | 500 InternalError | 500 InternalError | pass |
| A106 | GET | `/api/__test/nested/guarded/boom/42` | patient | nested/guarded/boom/42 patient → 403 | 403 Forbidden | 403 Forbidden | pass |
| A107 | — | `log line for X-Request-Id` | — | #6 request_completed.route | /api/__test/nested/inner/boom/:id | /api/__test/nested/inner/boom/:id | pass |
| A108 | — | `log line for X-Request-Id` | — | #6 request_completed.route | /api/__test/nested/guarded/boom/:id | /api/__test/nested/guarded/boom/:id | pass |
| A109 | — | `log line for X-Request-Id` | — | #6 request_completed.route | /api/__test/nested/guarded/boom/:id | /api/__test/nested/guarded/boom/:id | pass |
| A110 | — | `log line (audit commit)` | — | request_completed carries userId from the guard | 3 | 3 | pass |
| A111 | POST | `/api/__test/idem` | anonymous (ip) | idem: missing Idempotency-Key (required) | 400 ValidationFailed | 400 ValidationFailed | pass |
| A112 | POST | `/api/__test/idem` | anonymous (ip) | idem: non-UUID Idempotency-Key | 400 ValidationFailed | 400 ValidationFailed | pass |
| A113 | POST | `/api/__test/idem` | anonymous (ip) | idem: first call → 201 | 201 | 201 | pass |
| A114 | POST | `/api/__test/idem` | anonymous (ip) | idem: replay same key+body → same 201 body (handler not re-run) | 201 {"run":7,"echo":{"a":1}} | 201 {"run":7,"echo":{"a":1}} | pass |
| A115 | POST | `/api/__test/idem` | anonymous (ip) | idem: same key, different body → 422 | 422 IdempotencyConflict | 422 IdempotencyConflict | pass |
| A116 | POST | `/api/__test/idem` | anonymous (ip) | idem: same key while first in flight → 409 | 409 Conflict | 409 Conflict | pass |
| A117 | — | `header` | anonymous (ip) | idem: in-flight 409 carries Retry-After: 1 | 1 | 1 | pass |
| A118 | POST | `/api/__test/idem` | anonymous (ip) | idem: after the first finished → replay 201 | 201 | 201 | pass |
| A119 | POST | `/api/__test/idem-invalid` | anonymous (ip) | idem-invalid: stored 400 | 400 ValidationFailed | 400 ValidationFailed | pass |
| A120 | POST | `/api/__test/idem-invalid` | anonymous (ip) | idem-invalid: replayed 400 carries the NEW request id | 400 ValidationFailed | 400 ValidationFailed | pass |
| A121 | POST | `/api/__test/idem-flaky ×2` | anonymous (ip) | idem-flaky: 5xx releases the lock, retry → 201 | 500→201 (fresh server) or 201→201 | 201→201 (run 4 on a fresh server: 500→201) | pass |
| A122 | POST | `/api/__test/idem-empty` | anonymous (ip) | idem-empty: 204 | 204 | 204 | pass |
| A123 | POST | `/api/__test/idem-empty` | anonymous (ip) | idem-empty: replay 204 | 204 | 204 | pass |
| A124 | POST | `/api/__test/access/verified` | patient | verified + Idempotency-Key: first 201 | 201 patient | 201 patient | pass |
| A125 | POST | `/api/__test/access/verified` | patient | verified + same key: replay 201 | 201 patient | 201 patient | pass |
| A126 | POST | `/api/__test/access/verified` | patient | verified + same key, different body → 422 | 422 IdempotencyConflict | 422 IdempotencyConflict | pass |
| A127 | — | `EXISTS idem:POST …:user:<id>:<key>` | patient | idempotency principal is user:<id> (Redis key) | 1 | 1 | pass |
| A128 | POST | `/api/__test/idem` | anonymous (ip) | #11 done-without-status record → handler runs (201) | 201 | 201 | pass |
| A129 | GET | `/api/health/live` | public | #11 done-without-status: process still alive | 200 | 200 | pass |
| A130 | POST | `/api/__test/idem ×2` | anonymous (ip) | #11 done-without-status: 2nd request stores, 3rd replays it | 201 new run → 201 same body | 201 new-run → 201 replayed | pass |
| A131 | POST | `/api/__test/idem` | anonymous (ip) | #11 garbage record → handler runs (201) | 201 | 201 | pass |
| A132 | GET | `/api/health/live` | public | #11 garbage: process still alive | 200 | 200 | pass |
| A133 | POST | `/api/__test/idem ×2` | anonymous (ip) | #11 garbage: 2nd request stores, 3rd replays it | 201 new run → 201 same body | 201 new-run → 201 replayed | pass |
| A134 | — | `grep CARE_LOG_FILE` | — | #11 logs: idempotency_record_invalid, no unhandled rejection | >=2 / 0 | 4 / 0 | pass |
| A135 | POST | `/api/__test/access/verified (edge)` | patient | same key, user 101 → 201 | 201 patient | 201 patient | pass |
| A136 | POST | `/api/__test/access/verified (edge)` | patient | same key, user 102 → own 201 (not a replay of 101) | 201 patient | 201 patient | pass |
| A137 | GET | `/api/__test/limited` | public | 4th request inside the window → 429 RateLimited | 429 RateLimited | 429 RateLimited | pass |
| A138 | GET | `/api/__test/limited ×4` | public | 429 carries Retry-After; first three 200 | 200 200 200 + Retry-After | 200 200 200 + Retry-After=1 | pass |
| A139 | GET | `/api/health/ready` | public | ready: 200, identityJwks=up, not enveloped | 200 ok, database up, redis up, identityJwks up | 200 ok, up, up, up | pass |
| A140 | — | `headers` | public | ready: X-Request-Id echoed, Cache-Control no-store | echo + no-store | echo + no-store | pass |
| A141 | GET | `/api/health/live` | public | live: 200 | 200 | 200 | pass |
| A142 | — | `grep` | — | log care-3001b.log: token signatures / Authorization / PII | 0 / 0 / 0 | 0 / 0 / 0 | pass |
| A143 | — | `grep` | — | log care-3011.log: token signatures / Authorization / PII | 0 / 0 / 0 | 0 / 0 / 0 | pass |

### JWKS outage and recovery (manual, spec §3.3.4 / §9.7, contract C1)
Real patient token obtained before the outage. Identity was stopped by killing the PID that listens on 3020/3120.

| # | Step | Expected (spec) | Got | Result |
|---|------|-----------------|-----|--------|
| O1 | Identity up: `GET /api/health/ready`; real token on `/api/__test/access/any` | 200 `ok`, `identityJwks: up`; 200 | 200 `ok` up/up/up; 200 | pass |
| O2 | Stop Identity | Identity unreachable | `000` on 3020 | pass |
| O3 | Readiness right after the stop | still `up`: the probe makes no network call, and the last attempt succeeded | 200 `ok`, `identityJwks: up` | pass |
| O4 | Token with an unknown `kid` → demand fetch (gate open) | 401 `Unauthorized`; log `warn jwks_refresh_failed {trigger: unknown_kid, host, reason: network}` (no path) | 401 `Unauthorized`; log line exactly so | pass |
| O5 | Readiness after the failed fetch | **200** `ok`, `identityJwks: down` (JWKS never fails readiness) | 200 `ok`, database up, redis up, identityJwks down | pass |
| O6 | Real token while Identity is down (cached keys, set < 1 h old) | 200 | 200 | pass |
| O7 | Restart the care harness while Identity is down (boot fetch fails) | 200 `ok`, `identityJwks: down`; log `jwks_refresh_failed {trigger: boot, reason: network}` | as expected | pass |
| O8 | Real token after the restart (no key ever loaded) | 401 `Unauthorized` | 401 `Unauthorized` | pass |
| O9 | Restart Identity (exact command above) | Identity ready 200 (public + internal) | 200 / 200 | pass |
| O10 | Real token less than 60 s after care's boot attempt | 401: the `no_keys` demand fetch is gated to one per minute; readiness still `down` | 401; `identityJwks: down` | pass |
| O11 | Real token after the 60 s gate | 200 after one `no_keys` fetch; log `info jwks_refreshed {trigger: no_keys, keys: 1}` | 200; log line exactly so | pass |
| O12 | Readiness after recovery (no care restart needed) | 200 `ok`, `identityJwks: up` | 200 `ok` up/up/up | pass |

The 1 h stale cap (`jwks_keys_expired`) and the 5-min interval refresh were not waited out. Unit tests cover them
(`jwks-cache.test.ts`). Recovery used the demand path (O11).

### Regression #10 — Redis stall breaker (manual, spec §12.3)
Setup: a one-off third harness on `:3012` with `REDIS_URL=redis://127.0.0.1:6391/1`. Port 6391 is a TCP black-hole
proxy to the native Redis. It touches only DB 1; Identity's DB 0 is untouched. "Holed" means the open connection
stops carrying bytes but stays open, so ioredis keeps `status=ready`. Durations are server-side
`request_completed.durationMs`.

| # | Step | Expected (spec) | Got | Result |
|---|------|-----------------|-----|--------|
| R1 | Baseline idempotent POST `/api/__test/idem` | 201, fast | 201, 25.6 ms | pass |
| R2 | Hole the connection; idempotent POSTs until the breaker opens | at most 3 failed commands, each costing about the 500 ms `commandTimeout`; then `warn redis_breaker_open` once | 2 requests at 507 ms (each pays 2 failed commands: SET NX and the cleanup EVAL); `redis_breaker_open` logged | pass |
| R3 | Next idempotent POSTs while open | < 100 ms; `idempotency_skipped {reason: redis_breaker_open}`; handler runs (201) | 1.3 / 1.1 / 1.2 ms, reason `redis_breaker_open`, 201 | pass |
| R4 | Rate-limited route while open | < 100 ms, `rate_limiter_degraded` (memory limiter) | 2.2 ms, `rate_limiter_degraded` | pass |
| R5 | Readiness while stalled | 200 `degraded`, `redis: down` (Redis is Tier 2) | 200 `degraded`, redis down | pass |
| R6 | Half-open probe after 5 s on the still-dead connection | one probe admitted (about 500 ms), the breaker re-opens, later requests stay fast | one 506.7 ms probe, `redis_breaker_open`, then 1 ms | pass |
| R7 | Fresh connection (proxy restarted → ioredis reconnects), wait 5 s, same key ×3 | first call stored, then replayed (same `run`); `info redis_breaker_closed` | `run` 10 / 10 / 10; `redis_breaker_closed` logged | pass |

### Log and worker checks

| # | Check | Expected | Got | Result |
|---|-------|----------|-----|--------|
| L1 | All four harness logs (`:3001` before and after the restart, `:3011`, `:3012`): `Bearer `, `"authorization"`, `eyJ`, token signature segments, QA emails, `@example.test`, `password`, the QA password, `SYNTHETIC-COMPLAINT`, the JWKS path | 0 matches | 0 everywhere | pass |
| L2 | `unhandled_error` lines on `:3001` | only the deliberate 500 routes; no value or clinical text | 13 lines: synthetic rollback ×3, `audit_entry_invalid: metadata.complaintText` ×3 (key name only, value absent), synthetic nested failure ×6, synthetic transient failure ×1 | pass |
| L3 | `npx tsx src/worker.ts --once audit-partitions` | exit 0, `audit_partitions_ensured`, `audit_partition_missing 0`, `audit_default_partition_rows 0` | exit 0, `created: []`, `checked: 3`, both gauges 0 | pass |
| L4 | `worker --once nope` | exit 1, `worker_loop_unknown` | exit 1, `worker_loop_unknown` | pass |
| L5 | Partitions present | `audit_logs_default`, `audit_logs_y2026m10..m12` | as expected | pass |

## Re-run after fix-review (2026-10-03)
After `/develop access --fix-review` (commits `245205c`, `11aa5a3`; review `reviews/review-20261003-1600.md`), on
the dev data stack migrated to the two new migrations (`20261003120000_audit_logs_column_insert_grants`,
`20261003120100_audit_logs_partitions_attach`; `ensure-app-login` → `created: false`, the existing `care_app` passes
the new privileged-role check). The `:3001` harness was restarted on the new code; Identity was the same
`feature/auth` process on `:3020`/`:3120`. Fresh synthetic accounts were registered through the real flow with
`QA_EMAIL_PREFIX=qa.access2` (Identity ids patient 4, doctor 5, admin 6; Identity worker run only for the
registration codes, then stopped).

| # | Check | Expected | Got | Result |
|---|-------|----------|-----|--------|
| F1 | `scripts/curl-test-access.sh` (all 12 sections, real + edge tokens, log hygiene on both harness logs) | 143 pass, exit 0 | 143 pass / 0 fail / 0 skipped, exit 0 | pass |
| F2 | Harness boot under the stricter boot assertion (per-method chains, `handler_before_authorize`, `middleware_without_policy`, `markPreAuth` on global middleware) | starts; ready `ok` up/up/up; `jwks_refreshed {trigger: boot}` with no request | as expected | pass |
| F3 | `unhandled_error` lines on `:3001` (review L7) | carry `route` and `status` | `route: "POST /api/__test/audit"`, `status: 500` (error body redacted) | pass |
| F4 | `npx tsx src/worker.ts --once audit-partitions` on the migrated dev DB (review L4, new ATTACH function) | exit 0, `audit_partitions_ensured`, `worker_once_completed` | exit 0, `created: []`, `checked: 3` | pass |

Not re-run by hand: the Redis stall (R-cases) — `tests/integration/redis-stall.test.ts` now recovers **without**
the manual `disconnect(true)` (socket timeout 2 s) and fails without the fix; the JWKS extra-member / `d` cases —
unit `jwks-cache.test.ts` (verified through `jose`); the `--once` exit 1 paths and the ATTACH concurrency budget —
`tests/integration/worker-partitions.test.ts`; column-level INSERT 42501 — `tests/integration/db-roles.test.ts`.

## Failures / notes
- **No real failures.** All 167 checks match the contract and the spec.
- Corrected during the run (script expectations, not product bugs): (1) #11, spec §12.4: the request that meets an
  invalid record runs the handler **without storing**, so the second request stores and the third replays. The
  first draft expected the second to replay. (2) Rate limit: spawning `node` once per UUID stretched four calls past
  the 1 s window, so the first three now go in one `curl` process. (3) `curl -o` applies only to the first URL.
- Observation (#10, not a failure; **resolved** by review M2 — `socketTimeout` 2 s): after a stall that **drops** bytes, ioredis's reply queue is desynced. The
  connection never recovers by itself, readiness keeps reporting `redis: down`, and the breaker keeps probing
  every 5 s for about 500 ms each. Recovery needed a fresh connection (R7), and
  `tests/integration/redis-stall.test.ts` does the same (`disconnect(true)`). A real TCP partition retransmits
  instead of dropping acknowledged bytes, so this is mostly a proxy artefact. Still worth a look in `/review-code`
  (e.g. reconnect after N consecutive command timeouts).
- Observation: `GET /api/__test/params/%E0%A4%A` **without** a token returns 400 `ValidationFailed`, not 401.
  Express decodes `:param` while matching the route, before `userGuard` runs. No data is disclosed. Spec §12.1
  defines only the with-token case (400).
- Observation (**resolved** by review L7, see F3): `unhandled_error` log lines carry no `route` field. The paired `request_completed` line has the
  correct label (#6 fixed).
- Not covered here (with where it is covered): the internal listener's `/internal/health/ready` `identityJwks` (the
  harness has no internal listener; `tests/integration/health.test.ts`); the boot assertion
  `route_without_policy` / `route_without_guard` (`tests/integration/boot.test.ts`); rejection of a removed `kid`
  after refresh (`tests/integration/auth.test.ts`); grants (`UPDATE`/`DELETE` → 42501 as `care_app`,
  `tests/integration/audit.test.ts`); the 1 h stale cap (unit `jwks-cache.test.ts`).
