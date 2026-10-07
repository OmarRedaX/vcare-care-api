---
title: Resilience
owner: care-team
service: care-service
status: draft
diataxis: explanation
last_verified: 2026-10-08
tags: [resilience, retries, timeouts, idempotency, alerting, durable-jobs, outbox, postgres, redis]
related: [integration, runbook, scheduling-slots, infrastructure, deployment, foundation-spec, adr-0004-cross-service-failure-policies, adr-0006-health-split-redis-tier-2, adr-0008-care-worker-component, adr-0011-notification-outbox-and-reminders, adr-0012-doctor-reinstatement]
---

# Resilience

How care-service behaves when dependencies are slow or down, and how it keeps writes exactly-once.

## Timeouts
| Call | Timeout | Notes |
|---|---|---|
| Identity internal calls (token, users, status) | 2 s per attempt, connect + response (`IDENTITY_TIMEOUT_MS=2000`) | `undici` keep-alive pool |
| JWKS fetch (`lib/auth`, `undici`) | 2 s for connect + headers + body; body ≤ 64 KiB; no redirects | refresh every 5 min (Identity's `max-age`); a demand fetch (unknown `kid`, stale or no keys) at most once per 60 s across all triggers, single-flight; on failure the previous key set is kept and trusted for at most **1 h** after the last successful fetch, then no key is (every user token → 401, never a skipped verification). `identityJwks: down` in readiness; never 5xx |
| Video provider (room, join token) | 2 s | join/start fail cleanly; lifecycle state unchanged on failure |
| Object storage from `care-api` (`complete`: `HEAD`, 16-byte `GET`, `DELETE` 2 s; `COPY` 10 s) | per ADR 0015 | `complete` fails, no row inserted, intent stays open for a retry until it expires |
| Email provider | outside the request | async |
| Postgres connect | 2 s (`connectionTimeoutMillis`, also the pool create timeout) | a connect that never completes fails instead of hanging |
| Postgres pool acquire | 1 s for `care-api`/`care-worker`, 60 s for `care-migrate` | fast-fail when the pool is exhausted |
| Postgres statement | 2 s server-side `statement_timeout` (none for `care-migrate`); hot paths are budgeted far lower | startup parameter, set per pool |
| Postgres query (client side) | 3 s `query_timeout` (statement timeout + 1 s) | fires only when the server cannot answer (partition, failover without a TCP reset); the connection is then discarded (below) |
| Postgres TCP keepalive | first probe after 10 s idle | detects a dead peer long before kernel retransmission gives up (~15 min) |
| Readiness probes | 500 ms each (Postgres `SELECT 1` on the dedicated probe pool, Redis `PING`), run concurrently | a probe that rejects or times out reports `down` |
| Redis connect / command / socket | 2 s / **500 ms** / **2 s** (`socketTimeout`: a connection with commands outstanding and no byte for 2 s is destroyed and redialled — a half-open socket after an un-RST failover recovers in seconds, not ~15 min); no offline queue; 1 retry per request; reconnect `min(n × 200, 2000)` ms forever | cache-miss / fallback path on timeout. A Redis that stalls while still connected opens the per-client breaker after 3 consecutive failures for 5 s (one half-open probe then decides): at most 3 × 500 ms per 5 s per process on the idempotency and rate-limit paths (fixed [#10](https://github.com/OmarRedaX/vcare-care-api/issues/10)) |
| HTTP server | `requestTimeout` 30 s, `headersTimeout` 66 s, `keepAliveTimeout` 65 s | |
| Graceful shutdown | `SHUTDOWN_TIMEOUT_MS` (10 s) for drain **and** resource close | [infrastructure.md](./infrastructure.md) → Boot and shutdown |

## Postgres failure modes
- **Timed-out connections are discarded.** pg keeps a query whose client-side `query_timeout` fired after it was
  sent as the connection's active query and does not destroy the socket. The pool's `validate`
  (`lib/knex/pg-connection-state.ts`) therefore rejects any free connection that still has an active, queued, or
  unanswered query, and the next acquire opens a fresh one. After a failover without a TCP reset each pool pays at
  most one timed-out query per dead connection, instead of every later query on it timing out until the kernel drops
  the socket.
- **Readiness recovers on its own.** The probe pool has one connection: a probe stuck on a black-holed connection
  reports `down` after 500 ms, and later probes report `down` while that query holds the connection. Once the query
  reaches its 3 s `query_timeout`, the connection is discarded and the next probe reports `database: up` as soon as
  the new primary accepts connections — at most one timed-out probe query (≤ 3 s), with no restart.
- **The request pool cannot fail readiness.** Readiness never borrows a request-pool connection, so a saturated but
  healthy task stays in the load balancer.
- **Connection poolers.** `TimeZone=UTC` and `statement_timeout` travel as startup parameters. A pooler (PgBouncer,
  RDS Proxy) must forward them or the settings move back to a pool `afterCreate` (infrastructure.md → Database
  connection); verify this before adopting one.

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
- **Case 1 (built, verification 2026-10-08):** the job row is inserted in the decision transaction itself (including
  when the inline attempt then succeeds), so there is no crash window and no sweeper. **Case 3/4 (planned):** the job
  is inserted when inline attempts are exhausted; a sweeper covers the crash window (profiles with
  `identity_sync_status='pending'` and no open job older than 60 s get a job).
- The retrier loop runs in `care-worker` ([ADR 0008](../adr/0008-care-worker-component.md)) and polls `status='pending' AND next_attempt_at <= now()`. As built for
  Case 1 it is a plain read: a session-scoped per-doctor advisory lock (shared with the inline path) plus a re-check of
  the job and its `next_attempt_at` inside the lock mean two workers never send for one doctor at once and never retry
  before a backoff elapses (a double-send would be harmless anyway, Identity's PATCH is idempotent). Worker retries make one attempt per job per tick and build no response view.
- On success: job `succeeded`, `doctor_profiles.identity_sync_status='synced'`, audit `identity_sync.synced`
  (actor role `system`), caches invalidated (a newly synced approved doctor becomes searchable).
- On transient failure: `attempts++`, `consecutive_failures++`, `next_attempt_at = now + min(backoff, cap)`
  (as built `IDENTITY_SYNC_RETRY_CAP_SECONDS=60` for Case 1; Case 3 cap 60 s).
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

**As built for Case 1 (verification, 2026-10-08):** `IdentitySyncTransitionRejected` is an `error` log line (`IdentitySyncTransitionRejected`, with `jobId` and `profileId`, no reason or body) written when the job and profile move to `failed`; `IdentityApprovalSyncPending` is an `error` log line written once, by the first retry attempt that crosses `IDENTITY_SYNC_ALERT_AFTER_SECONDS` (900 s) after the job was created. Alert rules match those log events; a metric is not emitted. `UploadVerificationFailureSpike` is described in [file-handling.md](./file-handling.md) and [deployment.md](./deployment.md).

Runtime alerts added 2026-09-15 (`OutboxLagHigh`, `OutboxDeadJobs`, `DbReplicaLagHigh`, `WorkerHeartbeatStale`,
`AuditPartitionMissing`, `IdentityReinstatementSyncPending`, `RateLimiterDegraded`, `AvailabilityBudgetBurn`):
[deployment.md](./deployment.md) → Observability.

Actions for each: [runbook.md](../runbook.md).

## Idempotency
| Layer | Mechanism |
|---|---|
| HTTP | `Idempotency-Key` UUID **required** on book, reschedule, cancel (missing → `400 ValidationFailed`); optional on other writes |
| Redis | key `idem:<METHOD path>:<principal>:<key>` → `{state, bodyHash, status, body}` for 24 h. Before the handler an "in progress" marker (with a per-attempt owner nonce) is set with `SET NX`, TTL 60 s; a concurrent duplicate with the same body gets an **immediate `409 Conflict` with `Retry-After: 1`** (no waiting) and its retry receives the replay. The result is stored as soon as the handler completes the response, even if the client already disconnected; a 5xx or 429 releases the marker so the client may retry. A marker is only ever released by compare-and-delete of its own owner nonce, including after a `SET NX` that timed out client-side but may still land |
| Replay | same key + same body hash → original status and body (a stored error's `error.requestId` is replaced by the current request's id); different body → `422 IdempotencyConflict` |
| Redis down or breaker open | idempotency is skipped (`warn idempotency_skipped` + metric, `reason: redis_not_ready \| redis_breaker_open \| redis_error`), never a 5xx; the database key below still protects booking. A malformed stored record (e.g. a record-shape change during a rolling deploy, or unparsable JSON) is shape-checked, removed by compare-and-delete, logged `warn idempotency_record_invalid`, and the handler runs (`reason: invalid_record`); every async path ends in a terminal catch, so nothing can crash the process (fixed [#11](https://github.com/OmarRedaX/vcare-care-api/issues/11)). Not yet fixed: on a clinical route the stored body would keep clinical fields in Redis for 24 h and a replay would skip the audit ([#14](https://github.com/OmarRedaX/vcare-care-api/issues/14), needs a spec decision before `records`) |
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
| Identity JWKS only | cached keys keep working for up to 1 h after the last successful fetch (`identityJwks: down`, `jwks_refresh_failed`); a rotated unknown `kid` → one gated refetch per minute, else 401; after 1 h every user token → 401 (`jwks_keys_expired`, alert `IdentityJwksStale` pages at 30 min) |
| Redis (Tier 2) | no caches (slower reads), per-instance fallback rate limits, idempotency falls back to the DB key for booking; readiness reports `degraded`, never 503 |
| `care-worker` | sync retries, emails, reminders, and cache refreshes delayed; requests unaffected; `WorkerHeartbeatStale` pages |
| Postgres | service unavailable; health 503 |
| Video provider | join/start fail; consultations remain in their state; no-show and cancel still work |
| Email provider | notifications delayed only (outbox retries) |
| Object storage | direct uploads, `complete`, and downloads fail; no document or attachment row is created; records' text still readable |
