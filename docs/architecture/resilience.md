---
title: Resilience
owner: care-team
service: care-service
status: draft
diataxis: explanation
last_verified: 2026-09-15
tags: [resilience, retries, timeouts, idempotency, alerting, durable-jobs, outbox]
related: [integration, runbook, scheduling-slots, infrastructure, deployment, adr-0004-cross-service-failure-policies, adr-0006-health-split-redis-tier-2, adr-0008-care-worker-component, adr-0011-notification-outbox-and-reminders, adr-0012-doctor-reinstatement]
---

# Resilience

How care-service behaves when dependencies are slow or down, and how it keeps writes exactly-once.

## Timeouts
| Call | Timeout | Notes |
|---|---|---|
| Identity internal calls (token, users, status) | 2 s per attempt, connect + response (`IDENTITY_TIMEOUT_MS=2000`) | `undici` keep-alive pool |
| JWKS fetch | 2 s | cached keys keep verifying during an outage |
| Video provider (room, join token) | 2 s | join/start fail cleanly; lifecycle state unchanged on failure |
| Object storage from `care-api` (`complete`: `HEAD`, 16-byte `GET`, `DELETE` 2 s; `COPY` 10 s) | per ADR 0015 | `complete` fails, no row inserted, intent stays open for a retry until it expires |
| Email provider | outside the request | async |
| Postgres statement | 5 s default; hot paths are budgeted far lower | |
| Redis command | 200 ms | cache miss path on timeout |

## Retries, backoff, jitter
- Only on network errors, timeouts, `429`, `502`, `503`, `504`, plus one token refresh on `401`. Never on other `4xx`.
- Backoff `200 ms · 2^attempt` with ±20 % jitter; respect `Retry-After`.
- Retried writes are idempotent on the provider (Identity's status PATCH is).
- `X-Request-Id` is forwarded on every attempt (jobs store the original request id).
- Every response body is validated through DTOs; a malformed body is a failure.

| Case | Inline attempts | After |
|---|---|---|
| 1 | 3 | durable job, alert after 15 min unsynced |
| 2 | 2 (1 retry) | degrade |
| 3 | as many as fit in ~6 s | durable job, no attempt cap, backoff capped at 60 s, alert after 3 consecutive failures |
| 4 (reinstatement) | 3 | durable job (`kind='reinstatement'`), alert after 15 min unsynced ([ADR 0012](../adr/0012-doctor-reinstatement.md)) |
| contacts lookup (notifications) | 1 per outbox batch | outbox row stays `pending` with backoff — delivery delayed only |

**Non-retryable answers:** Identity `409 InvalidStatusTransition` stops Case 1 and Case 3 retries immediately,
sets `identity_sync_status='failed'` (and the job `status='failed'`), and raises `IdentitySyncTransitionRejected`
(a page for Case 3). Retrying cannot fix drift; an operator reconciles and requeues ([runbook.md](../runbook.md)).

## Case 2 — cache and degrade
- Read-through Redis `identity:user:<id>`, TTL 300 s (`HYDRATION_CACHE_TTL_SECONDS`); only misses call Identity.
- On failure: serve hits; misses render `displayName: null`, `avatarUrl: null`, `profileHydrated: false`;
  emit `identity_hydration_degraded`. The endpoint still returns 200.
- Redis down: every id is a miss; one batched Identity call per page still bounds load; if both are down, the
  response still renders without names.
- Hydration never runs on the booking path.

## Cases 1 and 3 — durable retry jobs (`identity_sync_jobs`)
- The job row is inserted when inline attempts are exhausted, in its own transaction after the decision commit.
  A crash between the decision commit and the job insert is covered by a sweeper: profiles with
  `identity_sync_status='pending'` and no open job older than 60 s get a job.
- The retrier loop runs in `care-worker` ([ADR 0008](../adr/0008-care-worker-component.md)) and polls `status='pending' AND next_attempt_at <= now()` with
  `FOR UPDATE SKIP LOCKED`, so multiple instances never double-send (and double-send would be harmless anyway).
- On success: job `succeeded`, `doctor_profiles.identity_sync_status='synced'`, audit `identity_sync.synced`
  (actor role `system`), caches invalidated (a newly synced approved doctor becomes searchable).
- On transient failure: `attempts++`, `consecutive_failures++`, `next_attempt_at = now + min(backoff, cap)`
  (Case 1 cap 5 min, Case 3 cap 60 s).
- A newer decision for the same doctor supersedes the open job (`superseded`) in the same transaction.
- Jobs survive restarts because they live in Postgres, not in memory.

## Alerting thresholds
| Alert | Threshold | Severity |
|---|---|---|
| `IdentitySuspensionSyncFailing` | a Case 3 job with `consecutive_failures >= 3` | page |
| `IdentitySyncTransitionRejected` | any job moved to `failed` (Identity 409) | page |
| `IdentityApprovalSyncPending` | a Case 1 job pending > 15 min | ticket |
| `IdentityHydrationDegraded` | degraded outcomes > 5 % of hydration calls over 10 min | ticket |
| `SlotComputationLatencyHigh` | slots p95 > 300 ms for 10 min | ticket |
| `SearchLatencyHigh` | search p95 > 400 ms for 10 min | ticket |
| `ExclusionViolationSpike` | `23P01` > 20/min | ticket |
| `AuditWriteFailures` | any audit insert failure | page |
| `HealthCheckFailing` | `/api/health/ready` 503 for 2 min | page |

Runtime alerts added 2026-09-15 (`OutboxLagHigh`, `OutboxDeadJobs`, `DbReplicaLagHigh`, `WorkerHeartbeatStale`,
`AuditPartitionMissing`, `IdentityReinstatementSyncPending`, `RateLimiterDegraded`, `AvailabilityBudgetBurn`):
[deployment.md](./deployment.md) → Observability.

Actions for each: [runbook.md](../runbook.md).

## Idempotency
| Layer | Mechanism |
|---|---|
| HTTP | `Idempotency-Key` UUID **required** on book, reschedule, cancel (missing → `400 ValidationFailed`); optional on other writes |
| Redis | key `(route, principal, key)` → `{bodyHash, status, responseBody}` for 24 h; set to "in progress" with `SET NX` before the handler, so a concurrent duplicate waits or gets the stored response |
| Replay | same key + same body hash → original status and body; different body → `422 IdempotencyConflict` |
| Database (booking) | `idempotency_key` and `request_hash` on the consultation row, `uq_consultations_idempotency (patient_user_id, idempotency_key)`. If Redis lost the record, the insert collides; the service loads the existing row and replays (same hash) or returns 422 (different hash). A Redis loss cannot double-book. |
| Reschedule / cancel | Redis record; on Redis loss, a replay is still safe: reschedule to the same start is a no-op update, and a second cancel is rejected as `409 InvalidTransition` without side effects |

## Exclusion-violation handling
- The booking and reschedule `INSERT`/`UPDATE` run inside the transaction; SQLSTATE `23P01` rolls back and maps to
  `409 SlotUnavailable`. The raw database error is never surfaced.
- Two concurrent bookings for one slot → exactly one 201 and one 409 (mandatory integration test).
- No retry on `23P01`: the slot is genuinely taken; the client refreshes slots.
- The slot cache is invalidated after every committed booking so a stale list is visible for at most the
  invalidation lag, and never allows a double booking.

## Notifications never block writes
Emails use a **transactional outbox** ([ADR 0011](../adr/0011-notification-outbox-and-reminders.md)): the
`notification_outbox` row is inserted in the same transaction as the write, and `care-worker` delivers it outside
the request (SKIP LOCKED, backoff `30 s · 2^n` ≤ 30 min, `dead` after 8 attempts). Recipient emails come from
Identity's `GET /internal/users/contacts` at send time and are never cached, stored, or logged. A provider or
Identity outage delays emails but never fails, delays, or rolls back a booking, reschedule, cancellation, or session
action. Reminders are produced by a 1-minute worker scan over `consultations`.

## Degradation summary
| Dependency down | Effect |
|---|---|
| Identity (internal) | search/lists without names (Case 2); approvals 202 pending (Case 1); suspensions 503 with local effect applied (Case 3); bookings unaffected |
| Identity JWKS only | cached keys keep working; a rotated unknown `kid` → 401 until reachable |
| Redis (Tier 2) | no caches (slower reads), per-instance fallback rate limits, idempotency falls back to the DB key for booking; readiness reports `degraded`, never 503 |
| `care-worker` | sync retries, emails, reminders, and cache refreshes delayed; requests unaffected; `WorkerHeartbeatStale` pages |
| Postgres | service unavailable; health 503 |
| Video provider | join/start fail; consultations remain in their state; no-show and cancel still work |
| Email provider | notifications delayed only (outbox retries) |
| Object storage | direct uploads, `complete`, and downloads fail; no document or attachment row is created; records' text still readable |
