---
title: Care Service — Runbook
owner: care-team
service: care-service
status: draft
diataxis: how-to
last_verified: 2026-10-09
tags: [runbook, operations, on-call, care]
related: [resilience, integration, admin-doctors-spec, adr-0021-identity-sync-engine-module, infrastructure, deployment, quickstart, service-card, access-spec, adr-0018-db-role-split-explicit-grants-partition-function]
---

# Runbook — care-service

Task-oriented doc for on-call. The foundation is built (2026-09-28): health probes, boot/shutdown, and the log lines
under "Boot and shutdown log lines" are live. The access base is built (2026-10-02): user-token verification against
Identity's JWKS, `authorize`, the boot route assertion, `audit_logs` with the `audit-partitions` worker loop, and the
owner/app database roles — their alerts (`IdentityJwksStale`, `AuditPartitionMissing`, `AuditWriteFailures`) and
tasks below are live. Verification is built (2026-10-08): the `identity-sync` and `upload-intent-purge` worker loops, the Case 1 alerts (`IdentityApprovalSyncPending`, `IdentitySyncTransitionRejected`), `UploadVerificationFailureSpike`, and the sync-job and upload-intent queries below are live. Admin doctors is built (2026-10-09): suspension (Case 3) and reinstatement (Case 4) run through the same `identity-sync` loop, with the `IdentitySuspensionSyncFailing` and `IdentityReinstatementSyncPending` alerts; the declared `503 IdentityUnavailable` is logged as `warn handled_error` (not an `unhandled_error`). Other business alerts and the SQL for module tables are the intended shape once those modules exist.

> **Clinical data never leaves the system.** Tickets, chat, and incident notes carry **ids, statuses, and
> request ids only** — never complaint text, record contents, names, object keys, presigned URLs, or tokens. Admin DB access
> for clinical tables is itself a privileged action: use the audited admin tooling where it exists.

## At a glance
| | |
|---|---|
| Health (public) | `GET http://<host>:3001/api/health/ready` — Postgres (fatal) + Redis (reported) + `identityJwks` (JWKS cache state, reported only — `down` never fails readiness); `/api/health/live` — process only (ADR 0006). `GET /api/health` no longer exists (404) |
| Health (internal) | `GET http://<host>:3101/internal/health/ready`, `/internal/health/live` |
| SLOs (p95) | doctor search < **400 ms** · 14-day slot computation < **300 ms** · booking write < **200 ms** · calendar/day view < 200 ms |
| Integrity | zero double-bookings (exclusion constraint) · zero unaudited clinical reads |
| Alert channel | `#alerts-care` (pages go to care on-call) |
| Logs | structured JSON, `service="care-service"`, keyed by `requestId` |

## Alerts → actions
| Alert | Severity | Trigger | Likely cause | First action |
|---|---|---|---|---|
| `IdentitySuspensionSyncFailing` | **page** | a Case 3 `identity_sync_jobs` row has 3 consecutive failed attempts (then every 10th) | Identity internal listener down, network policy, expired service client secret | Confirm the doctor is locally suspended (bookings blocked). Check `GET http://<identity>:3100/internal/health/ready`, then Identity's on-call. Inspect the job (below). Do **not** tell the reporter sessions are revoked until the job succeeds. |
| `IdentitySyncTransitionRejected` | **page** | Identity refused a status change of any kind (Case 1 verification, Case 3 suspension, Case 4 reinstatement) for good: `409 InvalidStatusTransition`, or `400` / `403` / `422` (the request itself is refused; the log `code` is then `HTTP_400` / `HTTP_403` / `HTTP_422`); job and `identity_sync_status` are `failed` | Drift: an ops/manual change made outside Care (Identity's admin API refuses doctor targets since hub ADR 0006), or an unexpected state | Log line `IdentitySyncTransitionRejected` (error, `kind`, `code`, `jobId`, `profileId`). Retrying cannot fix it (a `400` usually means a contract or validation mismatch with Identity, a `403` a non-doctor target or a missing scope: read `last_error_code` on the job). A reinstatement leaves the profile unsuspended but unbookable. Read both sides' state (Care: `doctor_profiles`; Identity: admin user view). Reconcile with the Identity owner, then requeue the job (below). For a suspension, ask Identity on-call to revoke the doctor's sessions manually meanwhile. |
| `IdentityApprovalSyncPending` | ticket | a Case 1 job is unsynced for > 15 minutes (a Case 4 reinstatement raises `IdentityReinstatementSyncPending` by the same rule) | Identity degraded | Doctor stays unbookable (correct). Check Identity health; the `identity-sync` loop continues (one attempt per due job per tick). Log line `IdentityApprovalSyncPending` (error, `jobId`, `profileId`). If Identity answers `404` on `/internal/users/{id}/status`, its internal-users module is not deployed yet (known environment dependency): Care keeps retrying and nothing is wrong in Care. Requeue after recovery if `next_attempt_at` is far out, or run `node dist/worker.js --once identity-sync`. While the job is unsynced, admin approve/reject answer `409 Conflict` + `Retry-After: 5` by design. |
| `IdentityHydrationDegraded` | ticket | `identity_hydration_degraded` > 5 % of hydration calls over 10 min | Identity slow/down, token exchange failing | No user impact beyond missing names (`profileHydrated:false`). Check Identity health and `/internal/auth/token` errors. Never "fix" by failing search. |
| `SlotComputationLatencyHigh` | ticket | slots endpoint p95 > 300 ms for 10 min | missing index use, cache stampede, a doctor with a huge busy set, DB saturation | `EXPLAIN` the busy-consultations overlap query (must use the GiST index of `excl_consultations_doctor_no_overlap`); check Redis hit rate for `slots:*`; check DB CPU/locks. |
| `SearchLatencyHigh` | ticket | `GET /api/doctors` p95 > 400 ms for 10 min | `next-available:*` cache misses computed inline, a filter without index, hydration latency | Check `next-available` hit rate; `EXPLAIN` the search query; check Identity batch latency (hydration has a 2 s timeout and 1 retry). |
| `ExclusionViolationSpike` | ticket | SQLSTATE `23P01` > 20/min | many patients racing for the same slots (expected at peaks), a stale slot cache, or a client retry loop without `Idempotency-Key` reuse | Each violation is a correct `409 SlotUnavailable`. Check slot-cache invalidation after booking commits and per-user rate-limit hits. Not a data-integrity incident. |
| `AuditWriteFailures` | **page** | any `audit_write_failed` metric (`action` dim) | DB permission regression, a missing partition grant, disk, a `chk_audit_logs_*` violation (a code bug) | Clinical reads and audited writes fail closed (500) — patient and doctor record access is down. Check grants for `vcare_app` (below: `INSERT`, `SELECT` on `audit_logs`, `audit_logs_default`, and every `audit_logs_y*` partition; `USAGE` on `audit_logs_id_seq`), that `care_app` is still a member of `vcare_app`, disk, recent migrations. The log line `audit_write_failed` carries `action`, `entityType`, and the serialized error (SQLSTATE; never metadata). |
| `HealthCheckFailing` | **page** | `/api/health/ready` returns 503 for 2 min | Postgres unreachable or tasks stuck draining | Read the body: `checks.database: "down"` → check Postgres connectivity, credentials, and failover state (after a failover without a TCP reset, readiness recovers by itself within one ≤ 3 s timed-out probe query once the new primary accepts connections — no restart needed); `database: "up"` with 503 → the task is draining (`shutdown_started` in its logs). Redis loss never fails readiness (it shows `degraded`; see `RateLimiterDegraded`). |
| `DbReplicaLagHigh` | **page** | replica lag > 30 s for 5 min | write burst, replica undersized, network | A failover now would lose up to the lag. Check replica CPU/IO; avoid planned failovers until lag recovers. If the primary AZ fails: promote the replica (RTO ≤ 30 min, ADR 0005) and reconcile bookings created in the lag window from request logs and `notification_outbox`. |
| `WorkerHeartbeatStale` | **page** | `care-worker` heartbeat > 2 min old | worker crashed, stuck loop, deploy failed | Restart/redeploy `care-worker`. Requests are unaffected, but Case 3 retries, emails, and reminders are paused. |
| `OutboxLagHigh` | ticket | oldest pending outbox row > 5 min for 5 min | email provider slow, Identity contacts lookup failing, worker saturated | Check provider status and `identity_call_failed{case=contacts}`; scale `care-worker` to 2. Never send emails by hand from the database. |
| `OutboxDeadJobs` | ticket | any `notification_outbox.status='dead'` | persistent provider rejection | Inspect `last_error_code`; fix config; requeue with `status='pending', attempts=0, next_attempt_at=now()`. |
| `AuditPartitionMissing` | ticket | `audit_partition_missing = 1` (`error audit_partition_missing`), next month's partition missing, or `audit_default_partition_rows > 0` (`warn audit_default_partition_nonempty`) | worker loop failing (lock timeout, permissions, worker down), or rows landed in `audit_logs_default` — which then blocks creating their month | Run one tick: `node dist/worker.js --once audit-partitions`. Exit 0 (`worker_once_completed`) = the partitions were ensured by that tick; exit 1 with `worker_once_incomplete` = not ensured — read the preceding `audit_partition_missing` `error.code` (`23514`: the default partition holds rows of the new month → move them, task below; `55P03`: lock timeout (200 ms) → retry) or, with no such line, another worker held the advisory lock → retry in a minute. |
| `IdentityJwksStale` | **page** | `jwks_cache_age_s` > 1 800 (no successful JWKS refresh for 30 min; platform alert in hub `architecture/deployment.md` → Observability) | Identity public listener down, `IDENTITY_JWKS_URL` wrong, egress/network policy, a malformed JWKS response | At 3 600 s the cached keys are distrusted and **every authenticated Care request is 401** (health stays 200, `identityJwks: down`). Read `warn jwks_refresh_failed` (`host`, `reason`: `timeout`, `network`, `http_status` + `status`, `content_type`, `too_large`, `invalid_json`, `invalid_document`). `curl -s <IDENTITY_JWKS_URL>` from a Care task; check Identity's `/api/health/ready` and on-call. `error jwks_keys_expired` marks the 1 h crossing. Never "fix" by skipping verification. |
| `IdentityReinstatementSyncPending` | ticket | a Case 4 job unsynced > 15 min | Identity degraded | Doctor stays unbookable (correct). Check Identity health; the retrier continues. |
| `RateLimiterDegraded` | ticket | fallback limiter active for 2 min | Redis down or failing over | Check Redis; limits are per instance until it recovers. |
| `UploadVerificationFailureSpike` | ticket | > 20 `upload_verification_failed` in 10 min | a client build sending wrong files, a client not waiting for the S3 POST before `complete`, or probing | As built the metric has one label, `reason=invalid_file` (missing object, size, or unrecognized bytes are not distinguished), so correlate by request id and user in the `upload_intents` rows (`consumed_at` set, `result_id` null) and the per-user 20/h intent limit; spikes from few users point at probing, spikes across users at a client build or a client that does not wait for the S3 POST before `complete`. No rows were created — nothing to clean beyond quarantine, which the worker purges. |
| `AvailabilityBudgetBurn` | **page** | 5xx + readiness failures burning the 99.9 % budget at > 2× over 1 h | any | Correlate with deploys (roll back), Postgres, replica promotion. |

## Boot and shutdown log lines
Every line is one JSON object on stdout/stderr with `service="care-service"`. None of them carries a value from the
environment or a request.

| `message` (level) | Meaning | First action |
|---|---|---|
| `invalid_environment` (error, stderr) | env validation failed; `keys` lists the offending variables (never values); exit 1 | Fix the named keys in the task definition. When the key is **`DATABASE_URL`**, check its scheme (`postgres:`/`postgresql:`) **and its query string**: it must not carry `options`, `statement_timeout`, `query_timeout`, or `application_name` (Care sets them per pool). `INTERNAL_HOST` must be an IP literal, not a host name. |
| `boot_failed` (error) | an entrypoint (`care-api`, `care-worker`, `care-migrate`) threw during boot; `error` holds the serialized error (name, code, frames — for a database error, no message); exit 1 | Read `error.name`/`error.code`; a crash loop right after a deploy → roll back. |
| `server_listen_failed` (error) | a listener could not bind (e.g. `EADDRINUSE`); exit 1 | Check `PORT`/`INTERNAL_PORT`/`INTERNAL_HOST` against the task networking. |
| `server_started` (info) | both listeners are up (`port`, `internalPort`) | — |
| `redis_unavailable` (warn) / `redis_recovered` (info) | one line per Redis transition (the first `ready` at boot also logs `redis_recovered`) | Tier 2: requests continue with fallbacks; see `RateLimiterDegraded`. |
| `knex_warn` / `knex_error` (warn / error) | Knex's own pool messages, e.g. connection or acquire errors while Postgres is unreachable; `summary` is the first line of Knex's text (≤ 200 chars) or, for an error object, its name only | Correlate with readiness `database: "down"` and Postgres status. A burst during a Postgres outage or failover is expected. `knex_deprecated` (warn) is a code follow-up, not an incident. |
| `shutdown_started` (info) | `SIGTERM`/`SIGINT` (or `uncaught_error`) received; readiness is now 503 | — |
| `shutdown_timeout` (error) | in-flight requests did not drain within `SHUTDOWN_TIMEOUT_MS`; `unfinishedRequests` = how many were cut; exit 1 | Look for slow requests (`request_completed` with high `durationMs`) before the deploy; raise the deadline only if long requests are legitimate. |
| `shutdown_resource_failed` (error) | closing a pool or Redis threw; the next resource is still closed | Usually harmless at exit; repeated → check the dependency. |
| `shutdown_resource_timeout` (error) | a resource (request pool, probe pool, Redis) did not close within the remaining deadline (`budgetMs`); exit 1 | Typically a pool stuck on a dead Postgres primary during a failover; confirm Postgres status. |
| `shutdown_complete` (info) | shutdown finished; exit code follows | — |
| `shutdown_forced` (warn) | a second signal arrived while draining; exit 1 immediately | Check the orchestrator's stop timeout is longer than `SHUTDOWN_TIMEOUT_MS`. |
| `uncaught_error` (error) | an uncaught exception or unhandled rejection; the task shuts down with exit 1 | A bug: open an issue with the request id and `error.name`/`code`. |
| `worker_started` / `worker_stopping` (info), `worker_stop_timeout` (error) | `care-worker` lifecycle; the timeout means a loop tick outlived `SHUTDOWN_TIMEOUT_MS` | See `WorkerHeartbeatStale`. |
| `worker_loop_unknown` / `worker_tick_failed` / `worker_once_incomplete` (error) | `--once <loop>` named no loop, its single tick threw, or the tick ran but did not reach its goal (`audit-partitions`: not ensured, or the lock was held elsewhere); exit 1 | Check the loop name (`audit-partitions`, `identity-sync`, `upload-intent-purge`); read `error` for the SQLSTATE, or the preceding `audit_partition_missing` line. |
| `route_without_policy: <METHOD> <path>` / `route_without_guard: …` / `handler_before_authorize: …` / `middleware_without_policy: <fn> under <path>` / `param_callback_without_policy: <name> under <path>` / `policy_invalid: …` (inside `boot_failed`) | a route method is mounted without `authorize`, without a guard before it, with a non-guard handler before `authorize`, a router-level layer that is neither a router, an error handler, nor `markPreAuth` middleware, a `router.param` / `app.param` callback (it would run before the guard), or an invalid policy (e.g. a status list containing `suspended`); the process refuses to start | A code defect in the release: roll back. Never work around it by removing the check. |
| `jwks_refreshed` (info) / `jwks_refresh_failed` (warn) / `jwks_keys_expired` (error) | the JWKS cache loaded `keys` keys (`trigger`: `boot`, `interval`, `stale`, `unknown_kid`, `no_keys`) / a refresh failed (`host`, `reason`, `status?`; previous keys kept) / no successful refresh for 1 h — no key is trusted now | See `IdentityJwksStale`. One `jwks_refresh_failed` at boot while Identity starts is harmless. |
| `access_denied` (info) | `authorize` denied a request; `reason` (`unauthenticated`, `role`, `status`, `email_unverified`, `check:<name>`, `ownership_not_found`, `ownership_forbidden`) and the route pattern — never ids | Expected traffic; a spike of one reason on one route after a deploy may be a policy regression. |
| `token_verification_error` (error) | an unexpected error while verifying a token (a bug or the key source failing); the request got 401 (fail closed) | Open an issue with the request id; the token is never logged. |
| `app_login_ensured` (info) | `ensure-app-login` created (`created: true`) or re-synced (`false`) the app login | — |
| `migration_failed` with `app_login_role_privileged` / `app_login_ddl_failed` (error) | `ensure-app-login` refused a privileged/owning/other-role-member existing role, or its role check or DDL failed (SQLSTATE `code` only) | See "Provision or rotate the app login". |
| `redis_breaker_open` (warn) / `redis_breaker_closed` (info) | Redis commands failed 3 times in a row (stall while connected): idempotency and rate limits stop using Redis for 5 s, then one probe decides. A connection that gets no byte for 2 s while commands are outstanding (half-open socket after an un-RST failover) is destroyed and redialled (`redis_unavailable` → `redis_recovered`), so the probe lands on a fresh connection | Check Redis latency/CPU; see `RateLimiterDegraded`. |
| `idempotency_record_invalid` (warn) | a stored idempotency value failed the shape check and was removed; the request ran without replay | A spike right after a deploy means a record-format change; otherwise investigate who writes `idem:*` keys. |
| `client_error_mapped` (warn) | a non-`AppError` 4xx (`name`, `status`) was mapped to `400`/`404` | Usually a malformed client request; never contains the value. |

## Common tasks

### Provision or rotate the app login (`ensure-app-login`)
`care-migrate` runs `node dist/migrate.js latest && node dist/migrate.js ensure-app-login` with both secrets:
`MIGRATION_DATABASE_URL` (owner, needs `CREATEROLE`) and `DATABASE_URL` (the app login `care_app`). The command
creates `care_app` as a member of `vcare_app`, or — when it exists — re-sets its password from `DATABASE_URL` and
re-grants the membership; it logs only `app_login_ensured { created }`. To rotate the app password: update the
`DATABASE_URL` secret for `care-migrate`, `care-api`, and `care-worker`, run the migrate task, then roll the API and
worker tasks. **Keep server-side `log_statement = 'none'` while it runs** — the password travels inside a
`CREATE/ALTER ROLE` statement, which `log_statement = 'ddl'`, `'mod'`, or `'all'` would log. Locally:
`npm run migrate:ensure-app-login`.
Failures (`migration_failed`, exit 1): `app_login_role_privileged` — the existing role named by `DATABASE_URL` has
`SUPERUSER`, `CREATEROLE`, `CREATEDB`, `REPLICATION`, or `BYPASSRLS`, owns objects, or is a direct member of any
role other than `vcare_app` (e.g. `GRANT care TO care_app`, `pg_write_all_data`, `pg_read_all_data`, `pg_monitor` —
it would inherit those rights); the command refuses to take it over (it never demotes a role or revokes a
membership). Point `DATABASE_URL` at the right login, or fix that role by hand (as the owner, list its memberships
with `SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles r ON r.oid = m.member
WHERE r.rolname = '<login>'` and `REVOKE <role> FROM <login>` for each one but `vcare_app`), then re-run.
`app_login_ddl_failed` (with a SQLSTATE `code` when the server answered, none on a dropped connection) — the role
check or the `CREATE/ALTER ROLE` failed; the message is fixed on purpose so the password and login name can never
reach the log. Re-run.

### Check the app role's grants
```sql
-- as the owner: table privileges of vcare_app (append-only tables must show INSERT and SELECT only)
SELECT table_name, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
FROM information_schema.role_table_grants
WHERE grantee = 'vcare_app'
GROUP BY table_name
ORDER BY table_name;
-- care_app is a member of vcare_app
SELECT pg_has_role('care_app', 'vcare_app', 'MEMBER') AS is_member;
```
A missing partition grant is fixed by re-running the worker tick (it grants partitions it creates) or, for an
existing partition, as the owner: `GRANT INSERT, SELECT ON audit_logs_yYYYYmMM TO vcare_app;`.

### Move rows out of the default audit partition
Rows land in `audit_logs_default` only when their month's partition is missing; they block creating that month.
As the owner, in one transaction (never `DELETE` audit history elsewhere — this moves rows, it does not drop them):
```sql
BEGIN;
CREATE TEMP TABLE audit_move ON COMMIT DROP AS
    SELECT * FROM audit_logs_default WHERE created_at >= $1 AND created_at < $2;   -- the month's UTC bounds
DELETE FROM audit_logs_default WHERE created_at >= $1 AND created_at < $2;
SELECT partition_name, created FROM audit_logs_ensure_partitions(2);              -- now creates the month
INSERT INTO audit_logs SELECT * FROM audit_move;                                  -- routed to the new partition
COMMIT;
```
Then run `node dist/worker.js --once audit-partitions` (exit 0) and confirm `audit_default_partition_rows` is 0. Record only the
row count and the month in the incident.

### Inspect an identity sync job
```sql
SELECT id, kind, doctor_user_id, target_status, status, attempts, consecutive_failures,
       last_error_code, next_attempt_at, created_at, request_id
FROM identity_sync_jobs
WHERE doctor_user_id = $1
ORDER BY id DESC
LIMIT 5;
```
`last_error_code` holds an HTTP status or a network error class — never a response body.

### Retry an identity sync job now
After the root cause is fixed (Identity healthy, or drift reconciled for a `failed` job):
```sql
UPDATE identity_sync_jobs
SET status = 'pending', next_attempt_at = now(), consecutive_failures = 0, updated_at = now()
WHERE id = $1 AND status IN ('pending', 'failed');
```
The `identity-sync` loop picks it up within one poll interval (`IDENTITY_SYNC_POLL_SECONDS`, 10 s), or run one tick now with `node dist/worker.js --once identity-sync` (exit 0 when every due job was processed, exit 1 when any failed); on success it sets `doctor_profiles.identity_sync_status='synced'`.
Confirm with the query above and check the admin console shows the doctor as synced. Log the action in the
incident with the job id and request id only.

### Run a worker loop once
`node dist/worker.js --once identity-sync` retries every due job of any kind (Case 1, Case 3, Case 4) once, suspensions first; `--once upload-intent-purge` closes expired open intents (deleting their quarantine objects) and removes intent rows older than 7 days. Both need the worker's normal env (`DATABASE_URL`, Identity and storage variables), use their own pool, and exit 0 on success. `upload-intent-purge` exits 1 (`worker_once_incomplete`) when another worker holds its singleton lock or a storage delete failed; rerun after the cause clears.

### Move or cancel flagged consultations after a suspension
Until the `consultations` module exists, suspension flags nothing (a no-op port returns `flaggedConsultationIds: []`); this task applies once it does.
1. List the queue: `GET /api/consultations?needsAdminFollowup=true&scope=upcoming` as an admin (admin view has no clinical fields).
2. For each consultation either reschedule to another doctor's flow (patient rebooks) or cancel on behalf:
   `PATCH /api/consultations/{id}/cancel` with `Idempotency-Key` and `{"reason":"Doctor unavailable"}`.
3. Patients are notified asynchronously. The audit log records each admin action (`consultation.cancelled`, actor role `admin`).

The same queue holds consultations flagged by a doctor's confirmed schedule block (flow F, `followupReason=schedule_blocked`).

### Investigate a failed upload
Uploads are intent → S3 POST → `complete` ([architecture/file-handling.md](./architecture/file-handling.md)).
```sql
SELECT id, kind, target_id, expires_at, consumed_at, result_id, created_at
FROM upload_intents
WHERE owner_user_id = $1
ORDER BY id DESC
LIMIT 10;
```
- `consumed_at` set and `result_id` null → verification rejected the stored bytes (check `upload_verification_failed`
  by request id); the user uploads again with a real PDF/JPEG/PNG ≤ 10 MB.
- `consumed_at` null and expired → the client never completed; the `upload-intent-purge` loop removes the quarantine object and closes the intent within about 5 minutes (a later `complete` answers `409`).
- Never read or share the object, its key, or a presigned URL in a ticket.

### Quarantine not draining
If `quarantine/` grows (worker purge failing), check `worker_heartbeat{loop=upload-intent-purge}`; the bucket
lifecycle rule still expires quarantine objects after 24 h. Do not delete final prefixes by hand.

### Trace a request by `X-Request-Id`
1. Get the id from the client's response header or the error body's `error.requestId`.
2. Search Care logs for `requestId=<id>` (route, status, `durationMs`, `userId`, `role` — no bodies).
3. Search Identity logs for the same id: every Care → Identity call forwards it.
4. Audit rows carry `request_id`; `GET /api/audit-logs?entityType=consultation&entityId=<id>` shows the actions.
5. Report findings with ids only.

### Check why a doctor is not bookable
`GET /internal/doctors/{userId}/summary` (service token) or the admin application view: `isBookable` requires
`verificationStatus=approved`, `identitySyncStatus=synced`, not suspended, accepting patients, and an active
consultation type.

## Escalation
care on-call → care-team lead. Identity-side failures (Cases 1 and 3) → identity-service on-call
(see `../vcare-hub/catalog/identity-service.card.md`). Suspected clinical-data exposure → security incident
process immediately; do not investigate by reading clinical rows.
