---
title: Care Service — Docs Index
owner: care-team
service: care-service
status: draft
last_verified: 2026-09-15
tags: [index, router, care]
related: [service-card, system-design, runbook, quickstart]
---

# Care Service — Docs Index

**Read this first.** Router for care-service docs. Load only what you need. The **Lens** column is the
Diátaxis type — a label, not a folder tree.

## Service-level
| Doc | Read it when you need to… | Lens |
|---|---|---|
| [service-card.md](./service-card.md) | get the 30-second summary (owner, deps, endpoints, data) — synced to the hub | — |
| [system-design.md](./system-design.md) | find the architecture shard for a concern | explanation |
| [quickstart.md](./quickstart.md) | run the service locally for the first time and book a consultation | tutorial |
| [runbook.md](./runbook.md) | respond to an alert or perform an on-call task | how-to |

## Architecture shards
| Doc | Read it when you need to… | Lens |
|---|---|---|
| [architecture/overview.md](./architecture/overview.md) | see containers, modules, layering, the request pipeline | explanation |
| [architecture/data-model.md](./architecture/data-model.md) | look up tables, columns, constraints, indexes, ERD | reference |
| [architecture/api.md](./architecture/api.md) | look up routes with roles, ownership, audit (human view of the contract) | reference |
| [architecture/scheduling-slots.md](./architecture/scheduling-slots.md) | understand slot computation, timezones, booking re-validation, caching | explanation |
| [architecture/consultation-lifecycle.md](./architecture/consultation-lifecycle.md) | understand statuses, transitions, windows, reschedule/cancel/leave flows | explanation |
| [architecture/clinical-records.md](./architecture/clinical-records.md) | understand records, the 24 h lock, amendments, attachments, clinical audit | explanation |
| [architecture/rbac.md](./architecture/rbac.md) | check who may call a route and what they see | reference |
| [architecture/integration.md](./architecture/integration.md) | understand service tokens and Integration Cases 1–3 with identity-service | explanation |
| [architecture/resilience.md](./architecture/resilience.md) | understand timeouts, retries, degrade policies, idempotency, durable jobs | explanation |
| [architecture/infrastructure.md](./architecture/infrastructure.md) | look up env vars, logging, error envelope, health, request ids | reference |
| [architecture/deployment.md](./architecture/deployment.md) | understand components (`care-api`, `care-worker`), availability/RPO/RTO, release smoke, bottlenecks, metrics, alerts | explanation |
| [architecture/capacity.md](./architecture/capacity.md) | check Care's load, compute, database, storage, Redis sizing, 10× check | explanation |
| [architecture/file-handling.md](./architecture/file-handling.md) | understand document/attachment uploads (intent → S3 → verified complete), on-demand download URLs, bucket rules, required contract changes | explanation |
| [architecture/future.md](./architecture/future.md) | see deferred work: events, Phase-2 AI (Care's side), scale, out of scope | explanation |

## Decisions (ADRs, append-only)
| ADR | Decision | Lens |
|---|---|---|
| [adr/0001-no-orm-knex-raw-sql.md](./adr/0001-no-orm-knex-raw-sql.md) | Knex query builder + raw-SQL migrations, no ORM | explanation |
| [adr/0002-slots-never-stored.md](./adr/0002-slots-never-stored.md) | availability is computed per request, never stored | explanation |
| [adr/0003-db-exclusion-constraint.md](./adr/0003-db-exclusion-constraint.md) | a `btree_gist` exclusion constraint guarantees non-overlap | explanation |
| [adr/0004-cross-service-failure-policies.md](./adr/0004-cross-service-failure-policies.md) | Case 1 retry-report-pending, Case 2 degrade, Case 3 must-not-degrade | explanation |
| [adr/0005-availability-and-recovery-targets.md](./adr/0005-availability-and-recovery-targets.md) | 99.9 % availability, async replica, RPO/RTO | explanation |
| [adr/0006-health-split-redis-tier-2.md](./adr/0006-health-split-redis-tier-2.md) | Redis Tier 2; liveness/readiness health split | explanation |
| [adr/0007-log-derived-metrics.md](./adr/0007-log-derived-metrics.md) | log-derived metrics, no tracing SDK in MVP | explanation |
| [adr/0008-care-worker-component.md](./adr/0008-care-worker-component.md) | background work in a separate `care-worker` | explanation |
| [adr/0009-audit-logs-monthly-partitions.md](./adr/0009-audit-logs-monthly-partitions.md) | `audit_logs` monthly partitions, ≥ 6-year retention | explanation |
| [adr/0010-next-available-lazy-cache-worker-refresh.md](./adr/0010-next-available-lazy-cache-worker-refresh.md) | `next-available` lazy cache + worker refresh | explanation |
| [adr/0011-notification-outbox-and-reminders.md](./adr/0011-notification-outbox-and-reminders.md) | notifications via outbox; reminders via worker scan | explanation |
| [adr/0012-doctor-reinstatement.md](./adr/0012-doctor-reinstatement.md) | admin doctor reinstatement, retry-report-pending (Case 4) | explanation |
| [adr/0013-verified-direct-upload-lifecycle.md](./adr/0013-verified-direct-upload-lifecycle.md) | direct-to-S3 uploads via a temporary intent; the real row only after `complete` verifies the bytes | explanation |
| [adr/0014-on-demand-download-urls.md](./adr/0014-on-demand-download-urls.md) | download URLs issued per click, audited, 60 s presigned GET; no URLs in DTOs | explanation |
| [adr/0015-aws-sdk-storage-adapter.md](./adr/0015-aws-sdk-storage-adapter.md) | AWS SDK v3 modular packages, only inside `lib/storage` | explanation |

## Module docs
Created by the workflow, not ahead of time: `/brainstorm <feature>` creates `docs/<module>/` (brainstorm,
spec, tasks, manual-qa, reviews/). Each module gets rows here when it starts.

| Doc | Read it when you need to… | Lens |
|---|---|---|
| [foundation/brainstorm.md](./foundation/brainstorm.md) | see the agreed scope of the runnable skeleton (what is in and out of the foundation) | explanation |
| [foundation/spec.md](./foundation/spec.md) | build or change the skeleton: entrypoints, `lib/` APIs (errors, logger, idempotency, rate limit, health, shutdown, worker runner), env, tooling, Docker, CI, test plan | reference |

## Contract (source of truth — prose above derives from it)
| Contract | Defines |
|---|---|
| [contracts/openapi.yaml](../contracts/openapi.yaml) | the HTTP API: public `/api/*` and network-isolated `/internal/*` |

There is no AsyncAPI contract: MVP is HTTP-only; future events are listed in `x-future-events`.

---
_Platform-scope questions (platform overview, deployment topology, capacity assumptions, Identity's contract, who
calls whom, data ownership, glossary, PRD) → the hub, where they live exclusively (hub ADR 0008):
`../vcare-hub/INDEX.md` (on GitHub: [OmarRedaX/Vcare](https://github.com/OmarRedaX/Vcare/blob/main/INDEX.md)).
Do not clone another service just to read it._
