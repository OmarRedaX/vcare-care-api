---
title: Runtime, Availability and Observability
owner: care-team
service: care-service
status: accepted
diataxis: explanation
last_verified: 2026-10-03
tags: [architecture, runtime, scaling, slo, disaster-recovery, bottlenecks, observability, worker]
related: [capacity, infrastructure, resilience, runbook, adr-0005-availability-and-recovery-targets, adr-0006-health-split-redis-tier-2, adr-0007-log-derived-metrics, adr-0008-care-worker-component, adr-0018-db-role-split-explicit-grants-partition-function, hub-deployment]
---

# Runtime, Availability and Observability — care-service

Care's side of the runtime architecture. Service-scope (hub ADR 0008). The **platform deployment topology** — edge
routing, private network, every service's components, the availability roll-up, the release pipeline — is authored
in the hub (`../vcare-hub/architecture/deployment.md`); the hub quotes this doc's counts and targets.
Sizing: [capacity.md](./capacity.md). Env vars: [infrastructure.md](./infrastructure.md).

## 1. Components
| Component | Image / entrypoint | Count | Scaling | Health used | Egress |
|---|---|---|---|---|---|
| `care-api` | one image, `node dist/server.js` (both listeners); DB login `care_app` | min 2, max 6, across AZs | CPU 60 %; step on search p95 > 400 ms | LB: `/api/health/ready`, `/internal/health/ready`; orchestrator: `/api/health/live` | Identity public JWKS, video provider, object storage |
| `care-worker` | same image, `node dist/worker.js`; DB login `care_app` (own pool, 2 connections) | 1 (2 on repeated lag) | manual | orchestrator: process liveness | email provider, object storage (quarantine purge) |
| `care-migrate` | same image, `node dist/migrate.js latest && node dist/migrate.js ensure-app-login`; DB **owner** (`MIGRATION_DATABASE_URL`) + the app secret it provisions | one-off per release | — | exit code | none |

All reach own Postgres and Redis; `care-api` and `care-worker` reach Identity's internal LB, and `care-api` its
public JWKS. Only `care-migrate` holds the owner credential ([ADR 0018](../adr/0018-db-role-split-explicit-grants-partition-function.md);
hub `deployment.md` → Release pipeline step 3).
`care-worker` loops ([ADR 0008](../adr/0008-care-worker-component.md)): identity-sync retrier + sweeper · notification
outbox · reminder scan (1 min) · `next-available` refresh · `audit_logs` partition maintenance (daily) · outbox purge ·
upload-intent purge (5 min; [file-handling.md](./file-handling.md), ADR 0013).

## 2. Availability and recovery ([ADR 0005](../adr/0005-availability-and-recovery-targets.md))
| Target | Value | Mechanism |
|---|---|---|
| Availability | **99.9 % monthly** (≈ 43 min) | ≥ 2 API tasks in ≥ 2 AZs; readiness-gated LB; rolling deploys |
| RPO — AZ failure | ≤ 1 min | async replica in a second AZ; alert on lag |
| RPO — corruption / bad migration | ≤ 5 min | point-in-time recovery |
| RTO — task/AZ failure | ≤ 30 min | orchestrator reschedules tasks; promote replica (runbook) |
| RTO — region loss | ≤ 4 h | restore the cross-region snapshot copy, redeploy IaC |
| Backups | daily snapshots 35 d + PITR, cross-region copy | quarterly restore and promotion drill |

**Tier 2** (loss degrades, never fails requests): Redis ([ADR 0006](../adr/0006-health-split-redis-tier-2.md)), email
provider (outbox), video provider (join/start only), `care-worker` (delays only). Identity follows the per-case
policies ([integration.md](./integration.md)).

## 3. Release specifics
The pipeline is platform-wide (hub `deployment.md` → Release pipeline). Care's specifics:
1. `care-migrate` before rollout (expand → migrate → contract; partition DDL is additive).
2. Rollout: `care-api` (min healthy 100 %, max 200 %), then `care-worker`.
3. Smoke: `/api/health/ready` 200 · synthetic `GET /api/doctors?limit=1` 200 · worker heartbeat metric < 2 min old.

## 4. Bottlenecks and mitigations
| # | Bottleneck | Mitigation |
|---|---|---|
| 1 | Search at peak / mass cache invalidation | indexed SQL page, one `MGET`, worker refresh of `next-available` ([ADR 0010](../adr/0010-next-available-lazy-cache-worker-refresh.md)); alert `SearchLatencyHigh` |
| 2 | Slot computation on hot doctors | fixed 5-query plan, 60 s cache; alert `SlotComputationLatencyHigh` |
| 3 | `audit_logs` growth | monthly partitions, time-bounded queries ([ADR 0009](../adr/0009-audit-logs-monthly-partitions.md)) |
| 4 | Connections / failover | request pool per task (`DATABASE_POOL_MAX`) + a 1-connection readiness probe pool; statement timeout 2 s, client query timeout 3 s, connect timeout 2 s, TCP keepalive; fast-fail on pool wait > 1 s; a connection whose query timed out is discarded, not reused ([resilience.md](./resilience.md) → Postgres failure modes); proxy past ~10 tasks (verify it forwards the `options` / `statement_timeout` startup parameters first — [infrastructure.md](./infrastructure.md) → Database connection); promotion drill |
| 5 | Replica lag → data loss window on failover | `DbReplicaLagHigh`; booking idempotency lets clients retry safely |
| 6 | Outbox lag / provider slowness | SKIP LOCKED batches, 5 s provider timeout, backoff, `dead` after 8; scale worker to 2 |
| 7 | Redis failover | Tier 2 fallbacks; readiness ignores Redis |

## 5. Observability ([ADR 0007](../adr/0007-log-derived-metrics.md))
| Metric | Dimensions | Used by |
|---|---|---|
| `http_requests`, `http_latency_ms`, `http_errors` | `route`, `status`, `code` | RED dashboards, latency alerts, budget burn |
| `slot_computation_ms`, `search_cache_miss_ratio` | — | bottlenecks 1–2 |
| `identity_hydration_degraded`, `identity_call_failed` | `case` | Case 2 / sync alerts |
| `identity_sync_job_consecutive_failures`, `identity_sync_job_pending_age_s` | `kind` | Cases 1, 3, 4 alerts |
| `outbox_oldest_pending_age_s`, `outbox_dead` | `kind` | outbox alerts |
| `exclusion_violation` | — | `ExclusionViolationSpike` |
| `db_pool_wait_ms`, `db_replica_lag_s` | — | bottlenecks 4–5 |
| `rate_limiter_degraded` | `limiter` | Redis fallback |
| `worker_heartbeat` | `loop` | `WorkerHeartbeatStale` |
| `audit_default_partition_rows` (bounded at 1 001), `audit_partition_missing` (0/1) | — | `AuditPartitionMissing` |
| `audit_write_failed` | `action` | `AuditWriteFailures` |
| `jwks_refresh_failed` | `reason` | JWKS fetch health (`IdentityJwksStale` context) |
| `jwks_cache_age_s` | — | `IdentityJwksStale` |
| `redis_breaker_open` | — | Redis stall detection ([resilience.md](./resilience.md) → Timeouts) |
| `upload_verification_failed`, `upload_intent_expired`, `download_url_issued` | `reason` / `kind` | `UploadVerificationFailureSpike` |

**Alerts added by this design** (actions in [runbook.md](../runbook.md); existing ones in [resilience.md](./resilience.md)):
`OutboxLagHigh` (oldest pending > 5 min for 5 min, ticket) · `OutboxDeadJobs` (> 0, ticket) · `DbReplicaLagHigh`
(> 30 s for 5 min, page) · `WorkerHeartbeatStale` (> 2 min, page) · `AuditPartitionMissing`
(`audit_partition_missing = 1`, next month missing, or `audit_default_partition_rows > 0`, ticket) ·
`IdentityJwksStale` (`jwks_cache_age_s` > 1 800, page — cached keys are distrusted at 3 600, after which every
authenticated Care request is 401; the platform alert row lives in hub `architecture/deployment.md` → Observability) · `IdentityReinstatementSyncPending` (Case 4 job > 15 min, ticket) ·
`RateLimiterDegraded` (any for 2 min, ticket) · `UploadVerificationFailureSpike` (> 20 in 10 min, ticket) · `AvailabilityBudgetBurn` (5xx + readiness failures burning 99.9 % at
> 2× over 1 h, page). `HealthCheckFailing` now probes readiness.

## 6. Contract changes required (land via `/construct-spec` + `/develop`)
- ~~Replace `GET /api/health`, `GET /internal/health` with `…/health/live` and `…/health/ready` (ADR 0006).~~ Done:
  contract changed 2026-09-15, implemented by the foundation (verified 2026-09-28); the old paths return 404.
- Add `PATCH /api/admin/doctors/{doctorUserId}/reinstate` (ADR 0012) — 200 / 202 `identitySync: pending|failed` /
  404 / 409 `InvalidTransition`; `x-failure-policy: retry-report-pending`.
- `GET /api/audit-logs` requires/defaults a time range (ADR 0009).
- File handling (ADRs 0013, 0014): replace the two multipart upload operations with `…/uploads` + `…/complete`, add
  the three `download-url` operations, drop `downloadUrl` from DTOs, add `UploadIntentExpired` — full list in
  [file-handling.md](./file-handling.md) §2. IaC: bucket CORS, Block Public Access, TLS policy, `quarantine/*`
  lifecycle (hub ADR 0011).
- **Consumer of new Identity provider changes (Identity ships first):** internal status transition
  `suspended → active`; `GET /internal/users/contacts?ids=` with scope `users:contact:read` (hub ADRs 0009, 0010).

## 7. Deferred
Synchronous standby (99.95 %) · connection proxy · read-replica routing for discovery reads (enabled when search
p95 approaches budget) · secondary email provider · OpenTelemetry (joint ADR).
