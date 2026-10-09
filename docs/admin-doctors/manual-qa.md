---
title: admin-doctors — Manual QA (CURL)
owner: care-team
service: care-service
module: admin-doctors
status: verified
diataxis: how-to
last_verified: 2026-10-09
tags: [admin-doctors, manual-qa, curl, suspension, reinstatement, identity-sync, case-3, case-4, rbac, idempotency, worker]
related: [admin-doctors-spec, admin-doctors-tasks, admin-doctors-brainstorm, schedules-manual-qa, verification-manual-qa, quickstart, runbook, adr-0021-identity-sync-engine-module]
---

# admin-doctors — Manual QA (CURL)

_Run: 2026-10-09 • Server: http://127.0.0.1:3031 • Result: 155 pass / 0 fail_ (two consecutive full runs on the same database, both 155 / 0; the table below is the second run, which also proves the script is repeatable)

## Environment

The real Care HTTP listener (`npx tsx src/server.ts`, `NODE_ENV=development`, public port 3031, internal 3131) **and the real Care worker** (`npx tsx src/worker.ts`, default `IDENTITY_SYNC_POLL_SECONDS=10`, `IDENTITY_SYNC_RETRY_CAP_SECONDS=60`) ran against a throwaway database `care_qa_admin` on the local Postgres 18 cluster (`127.0.0.1:5434`, extensions `btree_gist`, `citext`), migrated with the repo CLI (`src/migrate.ts latest`, then `ensure-app-login`, so both processes connected as `care_app`, not the owner). Redis was Memurai on `localhost:6379` db index 13 (flushed at the start of each script run). The database was dropped and every process stopped at the end of the session.

**Identity.** `scripts/admin-doctors-qa-fake-identity.mjs` (derived from the schedules fake) is one loopback process on port 3021 that plays three roles: JWKS publisher plus in-memory EdDSA user-token minter (admin, patient, doctor, expired, and an admin whose token carries `status=suspended`; `iss=vcare-identity`, `aud=[vcare-identity, vcare-care]`, `typ=user`), the service-token endpoint `POST /internal/auth/token`, and the internal `PATCH /internal/users/{id}/status` / `GET /internal/users` routes with Identity's real transition table (`active -> suspended`, `suspended -> active`) and its 500-code-point `reason` limit. `IDENTITY_JWKS_URL` and `IDENTITY_INTERNAL_URL` of both Care processes pointed at it. Its behaviour is switched **at runtime, without restarting Care**, with `GET /__ctl?mode=healthy|down|hang|conflict` (`down` = 503 on every internal call, `hang` = never answers so Care's 2 s client timeout fires, `conflict` = status PATCH answers `409 InvalidStatusTransition`). `GET /__calls` returns every status PATCH it received (user id, target status, `actorUserId`, forwarded `X-Request-Id`, the reason's **length in code points** only, and the answer), which is how the script counts calls (for example "no retry loop") and checks request-id forwarding without ever storing reason text.

**Object storage.** MinIO was unavailable; this slice makes no storage call. Care booted with `STORAGE_ENDPOINT=http://127.0.0.1:9` (nothing listening) and dummy credentials.

**Fixtures.** Doctors 410-429 (synthetic Identity user ids) were created through the real `POST /api/doctors/apply` route; owner SQL only approved the profile (`verification_status='approved'`, `identity_sync_status='synced'`), set the prerequisite states of the 409 cases (`submitted`, `rejected`, sync `pending` / `failed`, suspended-but-unsynced, soft-deleted), asserted state and audit rows, and reset the fixtures before and after each run. One active consultation type per approved doctor was created through the real route so `isBookable` is meaningful. Each section uses its own admin user id (the `admin-doctors-write` limiter is 30/min per admin) except the deliberate rate-limit section. Every call sent a fresh UUID `X-Request-Id`; every row checked that the response echoed it and carried `Cache-Control: no-store`. Every error row checked HTTP status, `success=false`, `error.code`, a string `error.message`, a `details` array and `error.requestId` equal to the sent id; every success row checked `success=true` plus a case-specific shape assertion (ids and `flaggedConsultationIds` typed, ISO dates, top-level `identitySync` sibling on `202`, top-level `suspension` marker on `503`). No token, response body or reason text is recorded here; reasons are synthetic (`Synthetic QA reason`, a marker `SYNTHETIC-REASON-5521`, `y` and emoji filler).

Re-run: start the fake Identity, `src/server.ts` and `src/worker.ts` as in the header of `scripts/curl-test-admin-doctors.sh`, then
`CARE_OWNER_DATABASE_URL=postgres://<owner>@127.0.0.1:5434/care_qa_admin REDIS_URL=redis://localhost:6379/13 SERVER_LOG=<care-api log> WORKER_LOG=<care-worker log> bash scripts/curl-test-admin-doctors.sh` (about 5 minutes: three 25 s worker-tick waits, outage convergence waits of up to 2 minutes, the 6 s hang timeout). The script refuses a database whose name does not end in `_test` or contain `_qa`, and always restores the fake to `healthy` on exit.

## Endpoints covered

Both operations of the module: `PATCH /api/admin/doctors/{doctorUserId}/suspend` (`suspendDoctor`, Case 3, must-not-degrade) and `PATCH /api/admin/doctors/{doctorUserId}/reinstate` (`reinstateDoctor`, Case 4, retry-report-pending), plus their side effects visible elsewhere: `GET /api/doctors/me` (`isSuspended`, `isBookable`, `identitySyncStatus`) and `PUT /api/doctors/me/working-hours` (the `doctor_not_suspended` guard). Roles: admin, patient, another doctor, the target doctor themself, admin token with `status=suspended`, unauthenticated, expired token.

Scenarios: healthy suspend and reinstate; Identity down (503 / 202), convergence by the real worker, unbounded retry and the `IdentitySuspensionSyncFailing` page; Identity timeouts; Identity `409` for both kinds (job `failed`, no retry loop, `IdentitySyncTransitionRejected`); the no-op rules S6 and S7 (re-suspend while `pending` / `failed`, blind reinstate retry while `pending` / `failed`, suspend while a reinstatement is unsynced); validation; RBAC; 404 / 409 preconditions; `Idempotency-Key` replay, conflict and "503 is not stored"; two parallel suspends; the 500-code-point Identity clamp; reason never in audit metadata or logs; the shared rate limit.

## Cases

Rows with method `check` are non-HTTP assertions (owner SQL, the fake Identity call log, worker/api log scans, equality of two responses). For `check` rows `Expected` / `Got` are the compared values (`;` separates joined values, `/` joins fields such as `suspended/by/syncStatus`).

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 1 | PATCH | /api/admin/doctors/410/suspend | none | suspend unauthenticated | 401 Unauthorized | 401 Unauthorized | PASS |
| 2 | PATCH | /api/admin/doctors/410/suspend | admin | suspend expired-token | 401 TokenExpired | 401 TokenExpired | PASS |
| 3 | PATCH | /api/admin/doctors/410/suspend | patient | suspend wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 4 | PATCH | /api/admin/doctors/410/suspend | doctor-other | suspend other-doctor | 403 Forbidden | 403 Forbidden | PASS |
| 5 | PATCH | /api/admin/doctors/410/suspend | doctor-self | suspend target-doctor-themself | 403 Forbidden | 403 Forbidden | PASS |
| 6 | PATCH | /api/admin/doctors/410/suspend | admin-suspended | suspend admin-token-status-suspended | 403 Forbidden | 403 Forbidden | PASS |
| 7 | PATCH | /api/admin/doctors/410/suspend | patient | suspend spoofed-X-User-Id-ignored | 403 Forbidden | 403 Forbidden | PASS |
| 8 | PATCH | /api/admin/doctors/410/reinstate | none | reinstate unauthenticated | 401 Unauthorized | 401 Unauthorized | PASS |
| 9 | PATCH | /api/admin/doctors/410/reinstate | admin | reinstate expired-token | 401 TokenExpired | 401 TokenExpired | PASS |
| 10 | PATCH | /api/admin/doctors/410/reinstate | patient | reinstate wrong-role | 403 Forbidden | 403 Forbidden | PASS |
| 11 | PATCH | /api/admin/doctors/410/reinstate | doctor-other | reinstate other-doctor | 403 Forbidden | 403 Forbidden | PASS |
| 12 | PATCH | /api/admin/doctors/410/reinstate | doctor-self | reinstate target-doctor-themself | 403 Forbidden | 403 Forbidden | PASS |
| 13 | PATCH | /api/admin/doctors/410/reinstate | admin-suspended | reinstate admin-token-status-suspended | 403 Forbidden | 403 Forbidden | PASS |
| 14 | PATCH | /api/admin/doctors/410/reinstate | patient | reinstate spoofed-X-User-Id-ignored | 403 Forbidden | 403 Forbidden | PASS |
| 15 | check | /api/admin/doctors/410 | none | RBAC matrix: no suspension, no job, no Identity call | 0/0/0 | 0/0/0 | PASS |
| 16 | PATCH | /api/admin/doctors/410/suspend | admin | suspend reason-missing | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 17 | PATCH | /api/admin/doctors/410/suspend | admin | suspend body-missing | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 18 | PATCH | /api/admin/doctors/410/suspend | admin | suspend reason-2-chars | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 19 | PATCH | /api/admin/doctors/410/suspend | admin | suspend reason-2001-chars | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 20 | PATCH | /api/admin/doctors/410/suspend | admin | suspend reason-control-character | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 21 | PATCH | /api/admin/doctors/410/suspend | admin | suspend reason-number | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 22 | PATCH | /api/admin/doctors/410/suspend | admin | suspend reason-null | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 23 | PATCH | /api/admin/doctors/410/suspend | admin | suspend unknown-member-actorUserId | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 24 | PATCH | /api/admin/doctors/410/suspend | admin | suspend unknown-member-status | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 25 | PATCH | /api/admin/doctors/abc/suspend | admin | suspend doctorUserId-non-numeric | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 26 | PATCH | /api/admin/doctors/0/suspend | admin | suspend doctorUserId-zero | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 27 | PATCH | /api/admin/doctors/-1/suspend | admin | suspend doctorUserId-negative | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 28 | PATCH | /api/admin/doctors/1.5/suspend | admin | suspend doctorUserId-fractional | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 29 | PATCH | /api/admin/doctors/410/reinstate | admin | reinstate reason-missing | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 30 | PATCH | /api/admin/doctors/410/reinstate | admin | reinstate body-missing | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 31 | PATCH | /api/admin/doctors/410/reinstate | admin | reinstate reason-2-chars | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 32 | PATCH | /api/admin/doctors/410/reinstate | admin | reinstate reason-2001-chars | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 33 | PATCH | /api/admin/doctors/410/reinstate | admin | reinstate reason-control-character | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 34 | PATCH | /api/admin/doctors/410/reinstate | admin | reinstate reason-number | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 35 | PATCH | /api/admin/doctors/410/reinstate | admin | reinstate reason-null | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 36 | PATCH | /api/admin/doctors/410/reinstate | admin | reinstate unknown-member-actorUserId | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 37 | PATCH | /api/admin/doctors/410/reinstate | admin | reinstate unknown-member-status | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 38 | PATCH | /api/admin/doctors/abc/reinstate | admin | reinstate doctorUserId-non-numeric | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 39 | PATCH | /api/admin/doctors/0/reinstate | admin | reinstate doctorUserId-zero | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 40 | PATCH | /api/admin/doctors/-1/reinstate | admin | reinstate doctorUserId-negative | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 41 | PATCH | /api/admin/doctors/1.5/reinstate | admin | reinstate doctorUserId-fractional | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 42 | check | /api/admin/doctors/410 | none | validation failures: no suspension, no job, no Identity call | 0/0/0 | 0/0/0 | PASS |
| 43 | PATCH | /api/admin/doctors/99999/suspend | admin | suspend unknown-doctor | 404 NotFound | 404 NotFound | PASS |
| 44 | PATCH | /api/admin/doctors/101/suspend | admin | suspend patient-user-id-has-no-profile | 404 NotFound | 404 NotFound | PASS |
| 45 | PATCH | /api/admin/doctors/418/suspend | admin | suspend soft-deleted-profile | 404 NotFound | 404 NotFound | PASS |
| 46 | PATCH | /api/admin/doctors/99999/reinstate | admin | reinstate unknown-doctor | 404 NotFound | 404 NotFound | PASS |
| 47 | PATCH | /api/admin/doctors/101/reinstate | admin | reinstate patient-user-id-has-no-profile | 404 NotFound | 404 NotFound | PASS |
| 48 | PATCH | /api/admin/doctors/418/reinstate | admin | reinstate soft-deleted-profile | 404 NotFound | 404 NotFound | PASS |
| 49 | PATCH | /api/admin/doctors/412/suspend | admin | suspend draft-doctor | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 50 | PATCH | /api/admin/doctors/413/suspend | admin | suspend submitted-doctor | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 51 | PATCH | /api/admin/doctors/414/suspend | admin | suspend rejected-doctor | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 52 | PATCH | /api/admin/doctors/415/suspend | admin | suspend approved-but-sync-pending | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 53 | PATCH | /api/admin/doctors/416/suspend | admin | suspend approved-but-sync-failed | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 54 | check | doctors 412-416 | none | rejected suspends: no job, no suspension, no Identity call | 0/0/0 | 0/0/0 | PASS |
| 55 | PATCH | /api/admin/doctors/412/reinstate | admin | reinstate never-suspended draft-doctor (no-op) | 200 | 200 | PASS |
| 56 | PATCH | /api/admin/doctors/417/reinstate | admin | reinstate never-suspended approved-doctor (no-op) | 200 | 200 | PASS |
| 57 | PATCH | /api/admin/doctors/415/reinstate | admin | reinstate suspended-but-suspension-sync-pending | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 58 | PATCH | /api/admin/doctors/416/reinstate | admin | reinstate suspended-but-suspension-sync-failed | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 59 | check | doctors 415,416 | none | rejected reinstates: still suspended, no job | 2/0 | 2/0 | PASS |
| 60 | PATCH | /api/admin/doctors/420/suspend | admin | suspend happy path, Identity healthy | 200 | 200 | PASS |
| 61 | check | /api/admin/doctors/420/suspend | admin | X-Request-Id forwarded to Identity | f4b43d84-5d04-43d2-a0c3-c13700760837 | f4b43d84-5d04-43d2-a0c3-c13700760837 | PASS |
| 62 | check | /api/admin/doctors/420/suspend | admin | Identity got one PATCH: suspended, actorUserId = token subject | 1/suspended/21 | 1/suspended/21 | PASS |
| 63 | check | /api/admin/doctors/420/suspend | admin | Identity account status | suspended | suspended | PASS |
| 64 | check | /api/admin/doctors/420/suspend | admin | local state: suspended / by admin 21 / synced; job succeeded | 1/21/synced;suspension:succeeded | 1/21/synced;suspension:succeeded | PASS |
| 65 | check | /api/doctors/me | doctor | doctor view: isSuspended / isBookable / sync | true/false/synced | true/false/synced | PASS |
| 66 | PUT | /api/doctors/me/working-hours | doctor | suspended doctor blocked from doctor actions (doctor_not_suspended) | 403 Forbidden | 403 Forbidden | PASS |
| 67 | check | audit-logs | admin | audit: doctor.suspended x1, identity_sync.synced x1 (actor admin), reason text absent | 1/1/0 | 1/1/0 | PASS |
| 68 | PATCH | /api/admin/doctors/420/suspend | admin | re-suspend already suspended + synced (no-op) | 200 | 200 | PASS |
| 69 | check | /api/admin/doctors/420/suspend | admin | no-op: suspendedAt equals the committed value, no new PATCH, job, or audit row | 2026-10-09T11:37:37/1/1/1 | 2026-10-09T11:37:37/1/1/1 | PASS |
| 70 | PATCH | /api/admin/doctors/420/reinstate | admin | reinstate happy path, Identity healthy | 200 | 200 | PASS |
| 71 | check | /api/admin/doctors/420/reinstate | admin | X-Request-Id forwarded to Identity | 91169713-4244-43b2-bbd7-a0e0779012c5 | 91169713-4244-43b2-bbd7-a0e0779012c5 | PASS |
| 72 | check | /api/admin/doctors/420/reinstate | admin | Identity got PATCH active; account active | 2/active/21/active | 2/active/21/active | PASS |
| 73 | check | /api/admin/doctors/420/reinstate | admin | local state: unsuspended / synced; reinstatement job succeeded | 0/-/synced;suspension:succeeded,reinstatement:succeeded | 0/-/synced;suspension:succeeded,reinstatement:succeeded | PASS |
| 74 | check | /api/doctors/me | doctor | doctor view after reinstate: bookable again | false/true/synced | false/true/synced | PASS |
| 75 | PUT | /api/doctors/me/working-hours | doctor | reinstated doctor can use doctor actions again | 200 | 200 | PASS |
| 76 | check | audit-logs | admin | audit: doctor.reinstated x1 | 1 | 1 | PASS |
| 77 | PATCH | /api/admin/doctors/420/reinstate | admin | reinstate not-suspended doctor (no-op, S7/BR13) | 200 | 200 | PASS |
| 78 | check | /api/admin/doctors/420/reinstate | admin | no-op: no new PATCH, job, or audit row | 2/2/1 | 2/2/1 | PASS |
| 79 | PATCH | /api/admin/doctors/421/suspend | admin | suspend, Identity down (5xx) | 503 IdentityUnavailable | 503 IdentityUnavailable | PASS |
| 80 | check | /api/admin/doctors/421/suspend | admin | 503: at least the 3 inline attempts reached Identity | 1 | 1 | PASS |
| 81 | check | /api/admin/doctors/421/suspend | admin | 503: suspended locally, sync pending, one suspension job pending | 1/22/pending;suspension:pending | 1/22/pending;suspension:pending | PASS |
| 82 | check | /api/doctors/me | doctor | doctor view while pending: suspended, unbookable | true/false/pending | true/false/pending | PASS |
| 83 | PUT | /api/doctors/me/working-hours | doctor | locally suspended doctor blocked while Identity is unconfirmed | 403 Forbidden | 403 Forbidden | PASS |
| 84 | check | audit-logs | admin | audit: doctor.suspended x1, identity_sync.pending x1 | 1/1 | 1/1 | PASS |
| 85 | PATCH | /api/admin/doctors/421/suspend | admin | re-suspend while pending (S6): same 503, not 200 | 503 IdentityUnavailable | 503 IdentityUnavailable | PASS |
| 86 | check | /api/admin/doctors/421/suspend | admin | S6 re-suspend: no new job/audit row, no inline attempts (at most 1 worker attempt) | 1/1/1 | 1/1/1 | PASS |
| 87 | check | internal-job | doctor | worker keeps retrying with no attempt cap: consecutive_failures >= 3 while job stays pending | 1 | 1 | PASS |
| 88 | check | worker-log | observer | IdentitySuspensionSyncFailing page logged | 1 | 1 | PASS |
| 89 | check | internal-job | doctor | Identity back: worker converges the job to synced | 1 | 1 | PASS |
| 90 | check | /api/admin/doctors/421/suspend | admin | converged: state synced, job succeeded, Identity suspended | 1/22/synced;suspension:succeeded;suspended | 1/22/synced;suspension:succeeded;suspended | PASS |
| 91 | check | audit-logs | system | audit: identity_sync.synced written by actor system | 1 | 1 | PASS |
| 92 | check | /api/doctors/me | doctor | doctor view after convergence | true/false/synced | true/false/synced | PASS |
| 93 | PATCH | /api/admin/doctors/421/suspend | admin | suspend after convergence (no-op, synced -> 200) | 200 | 200 | PASS |
| 94 | check | /api/admin/doctors/421/suspend | admin | no Identity call by the no-op | 4 | 4 | PASS |
| 95 | PATCH | /api/admin/doctors/422/suspend | admin | suspend, Identity hangs (client timeout) | 503 IdentityUnavailable | 503 IdentityUnavailable | PASS |
| 96 | check | /api/admin/doctors/422/suspend | admin | hang: suspended locally, job pending | 1/23/pending;suspension:pending | 1/23/pending;suspension:pending | PASS |
| 97 | check | internal-job | doctor | hang cleared: worker converges to synced | 1 | 1 | PASS |
| 98 | check | /api/admin/doctors/422/suspend | admin | hang converged: Identity suspended | suspended | suspended | PASS |
| 99 | PATCH | /api/admin/doctors/423/suspend | admin | suspend, Identity 409 | 503 IdentityUnavailable | 503 IdentityUnavailable | PASS |
| 100 | check | /api/admin/doctors/423/suspend | admin | 409: exactly one Identity call (no inline retry); local suspension kept; job failed | 1;1/24/failed;suspension:failed | 1;1/24/failed;suspension:failed | PASS |
| 101 | check | internal-job | system | job last_error_code | InvalidStatusTransition | InvalidStatusTransition | PASS |
| 102 | check | /api/doctors/me | doctor | doctor view after 409 | true/false/failed | true/false/failed | PASS |
| 103 | check | /api/admin/doctors/423/suspend | system | no retry loop: still one Identity call 25 s later (>= 2 worker ticks) | 1 | 1 | PASS |
| 104 | check | logs | observer | IdentitySyncTransitionRejected page logged | 1 | 1 | PASS |
| 105 | PATCH | /api/admin/doctors/423/suspend | admin | re-suspend while failed (S6): same 503, data failed | 503 IdentityUnavailable | 503 IdentityUnavailable | PASS |
| 106 | PATCH | /api/admin/doctors/423/reinstate | admin | reinstate while suspension sync failed | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 107 | check | /api/admin/doctors/423/suspend | admin | still one Identity call, one job, one audit row | 1/1/1 | 1/1/1 | PASS |
| 108 | PATCH | /api/admin/doctors/424/suspend | admin | suspend for the reinstate-409 case | 200 | 200 | PASS |
| 109 | PATCH | /api/admin/doctors/424/reinstate | admin | reinstate, Identity 409 | 202 | 202 | PASS |
| 110 | check | /api/admin/doctors/424/reinstate | admin | reinstate 409: unsuspended locally, sync failed, one extra Identity call | 2;0/-/failed;suspension:succeeded,reinstatement:failed | 2;0/-/failed;suspension:succeeded,reinstatement:failed | PASS |
| 111 | check | /api/doctors/me | doctor | doctor view: not suspended but unbookable | false/false/failed | false/false/failed | PASS |
| 112 | check | /api/admin/doctors/424/reinstate | system | no retry loop after reinstate 409 | 2 | 2 | PASS |
| 113 | PATCH | /api/admin/doctors/424/reinstate | admin | reinstate again while failed (S6): 202 failed re-report | 202 | 202 | PASS |
| 114 | PATCH | /api/admin/doctors/424/suspend | admin | suspend while reinstatement unsynced (S7) | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 115 | check | /api/admin/doctors/424/reinstate | admin | no extra PATCH, one reinstatement job, one doctor.reinstated audit row | 2/1/1 | 2/1/1 | PASS |
| 116 | PATCH | /api/admin/doctors/425/suspend | admin | suspend for the reinstate-down case | 200 | 200 | PASS |
| 117 | PATCH | /api/admin/doctors/425/reinstate | admin | reinstate, Identity down | 202 | 202 | PASS |
| 118 | check | /api/admin/doctors/425/reinstate | admin | reinstate pending: >= 3 inline attempts, unsuspended locally, reinstatement job pending | 1;0/-/pending;suspension:succeeded,reinstatement:pending | 1;0/-/pending;suspension:succeeded,reinstatement:pending | PASS |
| 119 | check | /api/doctors/me | doctor | doctor view: not suspended, still unbookable until synced | false/false/pending | false/false/pending | PASS |
| 120 | PUT | /api/doctors/me/working-hours | doctor | doctor-action guards pass once unsuspended (even while sync pending) | 200 | 200 | PASS |
| 121 | PATCH | /api/admin/doctors/425/reinstate | admin | blind retry while pending (S6): 202 pending, no new job | 202 | 202 | PASS |
| 122 | PATCH | /api/admin/doctors/425/suspend | admin | suspend while reinstatement unsynced (S7) | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 123 | check | /api/admin/doctors/425/reinstate | admin | one reinstatement job, one suspension job, one doctor.reinstated audit row | 1/1/1 | 1/1/1 | PASS |
| 124 | check | internal-job | doctor | Identity back: worker converges the reinstatement to synced | 1 | 1 | PASS |
| 125 | check | /api/admin/doctors/425/reinstate | admin | converged: Identity active, job succeeded | active;suspension:succeeded,reinstatement:succeeded | active;suspension:succeeded,reinstatement:succeeded | PASS |
| 126 | check | /api/doctors/me | doctor | doctor view after convergence: bookable again | false/true/synced | false/true/synced | PASS |
| 127 | check | audit-logs | system | audit: reinstatement identity_sync.synced by actor system | 1 | 1 | PASS |
| 128 | PATCH | /api/admin/doctors/425/reinstate | admin | reinstate after convergence (no-op, 200) | 200 | 200 | PASS |
| 129 | PATCH | /api/admin/doctors/426/suspend | admin | suspend with Idempotency-Key (first) | 200 | 200 | PASS |
| 130 | PATCH | /api/admin/doctors/426/suspend | admin | same key + same body replays the stored 200 | 200 | 200 | PASS |
| 131 | check | /api/admin/doctors/426/suspend | admin | replay body is byte-identical; one Identity call; one job | identical;1;1 | identical;1;1 | PASS |
| 132 | PATCH | /api/admin/doctors/426/suspend | admin | same key + different body | 422 IdempotencyConflict | 422 IdempotencyConflict | PASS |
| 133 | PATCH | /api/admin/doctors/426/suspend | admin | Idempotency-Key not a UUID | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 134 | PATCH | /api/admin/doctors/426/reinstate | admin | reinstate with key, Identity down (first) | 202 | 202 | PASS |
| 135 | PATCH | /api/admin/doctors/426/reinstate | admin | same key replays the stored 202 | 202 | 202 | PASS |
| 136 | check | /api/admin/doctors/426/reinstate | admin | stored 202 replayed byte-identically; one reinstatement job; one audit row | identical;1;1 | identical;1;1 | PASS |
| 137 | PATCH | /api/admin/doctors/426/reinstate | admin | reinstate same key + different body | 422 IdempotencyConflict | 422 IdempotencyConflict | PASS |
| 138 | PATCH | /api/admin/doctors/427/suspend | admin | suspend with key, Identity down (503) | 503 IdentityUnavailable | 503 IdentityUnavailable | PASS |
| 139 | check | internal-job | doctor | doctors 426 and 427 converge after Identity returns | 1 | 1 | PASS |
| 140 | PATCH | /api/admin/doctors/427/suspend | admin | same key after a 503: not stored, re-executes (now the synced no-op -> 200) | 200 | 200 | PASS |
| 141 | check | /api/admin/doctors/429/suspend | admin | two parallel suspends both answer 200 or 503 (got: 200 200) | 1 | 1 | PASS |
| 142 | check | /api/admin/doctors/429/suspend | admin | exactly one job, one doctor.suspended row, one Identity PATCH | 1/1/1 | 1/1/1 | PASS |
| 143 | PATCH | /api/admin/doctors/428/suspend | admin | suspend with a 2000-char reason (max allowed) | 200 | 200 | PASS |
| 144 | check | /api/admin/doctors/428/suspend | admin | Identity received exactly 500 code points; Care stored all 2000 | 500/2000 | 500/2000 | PASS |
| 145 | PATCH | /api/admin/doctors/428/reinstate | admin | reinstate with a 3-char reason (min allowed) | 200 | 200 | PASS |
| 146 | check | /api/admin/doctors/428/reinstate | admin | Identity received the 3-char reason untouched | 3 | 3 | PASS |
| 147 | PATCH | /api/admin/doctors/428/suspend | admin | suspend with a 600-emoji reason (1200 UTF-16 units) | 200 | 200 | PASS |
| 148 | check | /api/admin/doctors/428/suspend | admin | emoji reason clamped to exactly 500 code points (no split surrogate; Identity accepted) | 500/suspended | 500/suspended | PASS |
| 149 | PATCH | /api/admin/doctors/428/reinstate | admin | reinstate after emoji case | 200 | 200 | PASS |
| 150 | check | audit-logs | observer | reason marker/text never in audit metadata | 0 | 0 | PASS |
| 151 | check | server-log | observer | reason marker/text never in the care-api log | 0 | 0 | PASS |
| 152 | check | worker-log | observer | reason marker/text never in the care-worker log | 0 | 0 | PASS |
| 153 | check | admin-doctors-write | admin | first 30 requests in the window are not limited (404 for the absent doctor) | 1 | 1 | PASS |
| 154 | PATCH | /api/admin/doctors/99999/reinstate | admin | request 31 (other route, same bucket) | 429 RateLimited | 429 RateLimited | PASS |
| 155 | check | admin-doctors-write | admin | Retry-After present on 429 | 1 | 1 | PASS |

## Failures / notes

No product failure. Both full runs ended 155 pass / 0 fail. Earlier attempts exposed defects in the QA harness only (fixed in the script, not product bugs): a regenerated fake keypair under a cached JWKS (restart Care after restarting the fake), Git Bash rewriting `"/"` inside `node -e` arguments and `/tmp` paths for the native `curl`, and two overlapping script runs sharing one database.

Observations (not failures, none contradicts the spec or contract):
- **Expected 503s log at `error` level.** Each `503 IdentityUnavailable` produced an `unhandled_error` line (with a server-side stack) plus an error-level `request_completed` line in the care-api log (18 requests, 36 lines, all `status:503`, no `500`). That is the shared error handler logging every 5xx; alert rules keyed on "any `level=error`" will fire on a normal Case 3 degradation. The lines carry ids, status and code only, no reason text.
- Alert log lines (across the whole session, three script runs including one aborted early): `IdentitySuspensionSyncFailing` appeared in the care-worker log (3 lines, only after the third consecutive failure of the 421 outage), `IdentitySyncTransitionRejected` appeared in the care-api log (6 lines: the inline attempt is what meets the 409, and the worker never retried it). No `SYNTHETIC-REASON` marker or `Synthetic QA reason` text appeared in either log or in `audit_logs.metadata`.
- Convergence timing matched the spec: with Identity down the first 3 attempts are inline (about 0.8 s with immediate 503s, about 6 s with the 2 s timeout in `hang`), after that exactly one attempt per worker tick with backoff; after `healthy` the job reached `synced` within one backoff window (at most 60 s).
- The 409 cases confirmed "no retry loop": exactly one Identity call for the suspension and exactly one extra for the reinstatement, unchanged after 25 s (two or more 10 s worker ticks), job and profile `failed`, local state kept.
- Two parallel suspends on one doctor answered `200 200` in this run (either `200` or `503` is allowed by the contract for the loser, S6) and always produced one job, one `doctor.suspended` audit row and one Identity PATCH.
- Contract gap already tracked in tasks.md (a `test.failing`): `suspendDoctor` / `reinstateDoctor` do not declare `Idempotency-Key`, `422 IdempotencyConflict` or the in-flight `409`, yet the routes implement them; behaviour verified here (rows for keys, 422, non-UUID key `400`, "503 not stored").
- `reinstatedAt` is "now" on every call (no stored column), so a fresh no-op reinstate returns a new timestamp while a replayed `Idempotency-Key` returns the stored body (verified byte-identical).

Not verified (and why):
- `flaggedConsultationIds` with real values and `consultation.flagged_for_followup` audit rows: the `consultations` module does not exist, the port is the no-op, so the list is always `[]` (asserted as such).
- Audit or port failure rolling the suspension back to a `500` (needs fault injection inside the transaction; covered by the integration suite).
- The in-flight duplicate `Idempotency-Key` path (`409 Conflict` + `Retry-After: 1`, needs a deterministic race) and the Redis-down behaviour (idempotency skipped, limiter fallback).
- The 15-minute `IdentityReinstatementSyncPending` ticket alert (900 s of real time; unit-tested with a fake clock).
- Worker priority (suspension jobs listed first with 50 due jobs), parallel suspend-plus-reinstate races, and superseding a stray open verification job (integration suite).
- A real Identity instance (only the contract-compliant fake was used), the production build (`dist/`), and request-latency budgets (no benchmark was run).
