---
title: Care Service — Runbook
owner: care-team
service: care-service
status: draft
diataxis: how-to
last_verified: 2026-09-28
tags: [runbook, operations, on-call, care]
related: [resilience, integration, infrastructure, deployment, quickstart, service-card]
---

# Runbook — care-service

Task-oriented doc for on-call. The foundation is built (2026-09-28): health probes, boot/shutdown, and the log lines
under "Boot and shutdown log lines" are live. Business alerts and the SQL below are the intended shape once the
modules and their tables exist.

> **Clinical data never leaves the system.** Tickets, chat, and incident notes carry **ids, statuses, and
> request ids only** — never complaint text, record contents, names, object keys, presigned URLs, or tokens. Admin DB access
> for clinical tables is itself a privileged action: use the audited admin tooling where it exists.

## At a glance
| | |
|---|---|
| Health (public) | `GET http://<host>:3001/api/health/ready` — Postgres (fatal) + Redis (reported; JWKS cache state is added by `lib/auth`); `/api/health/live` — process only (ADR 0006). `GET /api/health` no longer exists (404) |
| Health (internal) | `GET http://<host>:3101/internal/health/ready`, `/internal/health/live` |
| SLOs (p95) | doctor search < **400 ms** · 14-day slot computation < **300 ms** · booking write < **200 ms** · calendar/day view < 200 ms |
| Integrity | zero double-bookings (exclusion constraint) · zero unaudited clinical reads |
| Alert channel | `#alerts-care` (pages go to care on-call) |
| Logs | structured JSON, `service="care-service"`, keyed by `requestId` |

## Alerts → actions
| Alert | Severity | Trigger | Likely cause | First action |
|---|---|---|---|---|
| `IdentitySuspensionSyncFailing` | **page** | a Case 3 `identity_sync_jobs` row has 3 consecutive failed attempts | Identity internal listener down, network policy, expired service client secret | Confirm the doctor is locally suspended (bookings blocked). Check `GET http://<identity>:3100/internal/health/ready`, then Identity's on-call. Inspect the job (below). Do **not** tell the reporter sessions are revoked until the job succeeds. |
| `IdentitySyncTransitionRejected` | **page** | Identity answered `409 InvalidStatusTransition` to a Case 1 or Case 3 status change; `identity_sync_status='failed'` | Drift: an ops/manual change made outside Care (Identity's admin API refuses doctor targets since hub ADR 0006), or an unexpected state | Retrying cannot fix it. Read both sides' state (Care: `doctor_profiles`; Identity: admin user view). Reconcile with the Identity owner, then requeue the job (below). For a suspension, ask Identity on-call to revoke the doctor's sessions manually meanwhile. |
| `IdentityApprovalSyncPending` | ticket | a Case 1 job is unsynced for > 15 minutes | Identity degraded | Doctor stays unbookable (correct). Check Identity health; the retrier continues. Requeue after recovery if `next_attempt_at` is far out. |
| `IdentityHydrationDegraded` | ticket | `identity_hydration_degraded` > 5 % of hydration calls over 10 min | Identity slow/down, token exchange failing | No user impact beyond missing names (`profileHydrated:false`). Check Identity health and `/internal/auth/token` errors. Never "fix" by failing search. |
| `SlotComputationLatencyHigh` | ticket | slots endpoint p95 > 300 ms for 10 min | missing index use, cache stampede, a doctor with a huge busy set, DB saturation | `EXPLAIN` the busy-consultations overlap query (must use the GiST index of `excl_consultations_doctor_no_overlap`); check Redis hit rate for `slots:*`; check DB CPU/locks. |
| `SearchLatencyHigh` | ticket | `GET /api/doctors` p95 > 400 ms for 10 min | `next-available:*` cache misses computed inline, a filter without index, hydration latency | Check `next-available` hit rate; `EXPLAIN` the search query; check Identity batch latency (hydration has a 2 s timeout and 1 retry). |
| `ExclusionViolationSpike` | ticket | SQLSTATE `23P01` > 20/min | many patients racing for the same slots (expected at peaks), a stale slot cache, or a client retry loop without `Idempotency-Key` reuse | Each violation is a correct `409 SlotUnavailable`. Check slot-cache invalidation after booking commits and per-user rate-limit hits. Not a data-integrity incident. |
| `AuditWriteFailures` | **page** | any `audit_logs` insert failure | DB permission regression, disk, constraint | Clinical reads fail closed (500) — patient and doctor record access is down. Check DB grants for the app role (`INSERT`, `SELECT` on `audit_logs`), disk, recent migrations. |
| `HealthCheckFailing` | **page** | `/api/health/ready` returns 503 for 2 min | Postgres unreachable or tasks stuck draining | Read the body: `checks.database: "down"` → check Postgres connectivity, credentials, and failover state (after a failover without a TCP reset, readiness recovers by itself within one ≤ 3 s timed-out probe query once the new primary accepts connections — no restart needed); `database: "up"` with 503 → the task is draining (`shutdown_started` in its logs). Redis loss never fails readiness (it shows `degraded`; see `RateLimiterDegraded`). |
| `DbReplicaLagHigh` | **page** | replica lag > 30 s for 5 min | write burst, replica undersized, network | A failover now would lose up to the lag. Check replica CPU/IO; avoid planned failovers until lag recovers. If the primary AZ fails: promote the replica (RTO ≤ 30 min, ADR 0005) and reconcile bookings created in the lag window from request logs and `notification_outbox`. |
| `WorkerHeartbeatStale` | **page** | `care-worker` heartbeat > 2 min old | worker crashed, stuck loop, deploy failed | Restart/redeploy `care-worker`. Requests are unaffected, but Case 3 retries, emails, and reminders are paused. |
| `OutboxLagHigh` | ticket | oldest pending outbox row > 5 min for 5 min | email provider slow, Identity contacts lookup failing, worker saturated | Check provider status and `identity_call_failed{case=contacts}`; scale `care-worker` to 2. Never send emails by hand from the database. |
| `OutboxDeadJobs` | ticket | any `notification_outbox.status='dead'` | persistent provider rejection | Inspect `last_error_code`; fix config; requeue with `status='pending', attempts=0, next_attempt_at=now()`. |
| `AuditPartitionMissing` | ticket | next month's `audit_logs` partition missing, or default partition has rows | worker partition loop failing | Run the worker's partition job manually (`node dist/worker.js --once audit-partitions`); move default-partition rows after creating the partition. |
| `IdentityReinstatementSyncPending` | ticket | a Case 4 job unsynced > 15 min | Identity degraded | Doctor stays unbookable (correct). Check Identity health; the retrier continues. |
| `RateLimiterDegraded` | ticket | fallback limiter active for 2 min | Redis down or failing over | Check Redis; limits are per instance until it recovers. |
| `UploadVerificationFailureSpike` | ticket | > 20 `upload_verification_failed` in 10 min | a client build sending wrong files, a client not waiting for the S3 POST before `complete`, or probing | Group by `reason` (`missing`/`size`/`type`) and route; `missing` spikes point at clients, `type` spikes from few users at probing (rate limits apply). No rows were created — nothing to clean beyond quarantine, which the worker purges. |
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

## Common tasks

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
The retrier picks it up within one poll interval; on success it sets `doctor_profiles.identity_sync_status='synced'`.
Confirm with the query above and check the admin console shows the doctor as synced. Log the action in the
incident with the job id and request id only.

### Move or cancel flagged consultations after a suspension
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
- `consumed_at` null and expired → the client never completed; the worker purge removes the quarantine object.
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
