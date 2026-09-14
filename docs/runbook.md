---
title: Care Service — Runbook
owner: care-team
service: care-service
status: draft
diataxis: how-to
last_verified: 2026-09-14
tags: [runbook, operations, on-call, care]
related: [resilience, integration, infrastructure, service-card]
---

# Runbook — care-service

Task-oriented doc for on-call. Written ahead of the code (status `design`); commands against the database are
the intended shape once the tables exist.

> **Clinical data never leaves the system.** Tickets, chat, and incident notes carry **ids, statuses, and
> request ids only** — never complaint text, record contents, names, signed URLs, or tokens. Admin DB access
> for clinical tables is itself a privileged action: use the audited admin tooling where it exists.

## At a glance
| | |
|---|---|
| Health (public) | `GET http://<host>:3001/api/health` — Postgres + Redis (+ cached JWKS, informational) |
| Health (internal) | `GET http://<host>:3101/internal/health` |
| SLOs (p95) | doctor search < **400 ms** · 14-day slot computation < **300 ms** · booking write < **200 ms** · calendar/day view < 200 ms |
| Integrity | zero double-bookings (exclusion constraint) · zero unaudited clinical reads |
| Alert channel | `#alerts-care` (pages go to care on-call) |
| Logs | structured JSON, `service="care-service"`, keyed by `requestId` |

## Alerts → actions
| Alert | Severity | Trigger | Likely cause | First action |
|---|---|---|---|---|
| `IdentitySuspensionSyncFailing` | **page** | a Case 3 `identity_sync_jobs` row has 3 consecutive failed attempts | Identity internal listener down, network policy, expired service client secret | Confirm the doctor is locally suspended (bookings blocked). Check `GET http://<identity>:3100/internal/health`, then Identity's on-call. Inspect the job (below). Do **not** tell the reporter sessions are revoked until the job succeeds. |
| `IdentitySyncTransitionRejected` | **page** | Identity answered `409 InvalidStatusTransition` to a Case 1 or Case 3 status change; `identity_sync_status='failed'` | Drift: the account was changed directly in Identity (known gap), or an unexpected state | Retrying cannot fix it. Read both sides' state (Care: `doctor_profiles`; Identity: admin user view). Reconcile with the Identity owner, then requeue the job (below). For a suspension, ask Identity on-call to revoke the doctor's sessions manually meanwhile. |
| `IdentityApprovalSyncPending` | ticket | a Case 1 job is unsynced for > 15 minutes | Identity degraded | Doctor stays unbookable (correct). Check Identity health; the retrier continues. Requeue after recovery if `next_attempt_at` is far out. |
| `IdentityHydrationDegraded` | ticket | `identity_hydration_degraded` > 5 % of hydration calls over 10 min | Identity slow/down, token exchange failing | No user impact beyond missing names (`profileHydrated:false`). Check Identity health and `/internal/auth/token` errors. Never "fix" by failing search. |
| `SlotComputationLatencyHigh` | ticket | slots endpoint p95 > 300 ms for 10 min | missing index use, cache stampede, a doctor with a huge busy set, DB saturation | `EXPLAIN` the busy-consultations overlap query (must use the GiST index of `excl_consultations_doctor_no_overlap`); check Redis hit rate for `slots:*`; check DB CPU/locks. |
| `SearchLatencyHigh` | ticket | `GET /api/doctors` p95 > 400 ms for 10 min | `next-available:*` cache misses computed inline, a filter without index, hydration latency | Check `next-available` hit rate; `EXPLAIN` the search query; check Identity batch latency (hydration has a 2 s timeout and 1 retry). |
| `ExclusionViolationSpike` | ticket | SQLSTATE `23P01` > 20/min | many patients racing for the same slots (expected at peaks), a stale slot cache, or a client retry loop without `Idempotency-Key` reuse | Each violation is a correct `409 SlotUnavailable`. Check slot-cache invalidation after booking commits and per-user rate-limit hits. Not a data-integrity incident. |
| `AuditWriteFailures` | **page** | any `audit_logs` insert failure | DB permission regression, disk, constraint | Clinical reads fail closed (500) — patient and doctor record access is down. Check DB grants for the app role (`INSERT`, `SELECT` on `audit_logs`), disk, recent migrations. |
| `HealthCheckFailing` | **page** | `/api/health` returns 503 for 2 min | Postgres or Redis unreachable | The body's `checks` names the failing dependency. Check connectivity and credentials; Redis loss also disables rate limits and idempotency replay (booking still protected by `uq_consultations_idempotency`). |

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

### Rotate `SIGNED_URL_SECRET`
Signed URLs live ≤ 10 minutes, so rotation is a short overlap:
1. Deploy with the new secret as primary and the old one accepted for verification only (dual-key window).
2. Wait `SIGNED_URL_TTL_SECONDS` (600 s) plus clock skew.
3. Deploy without the old secret. Links issued before step 1 expire naturally; users re-open the record to get a fresh URL.
Never paste either secret or any signed URL into a ticket.

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
