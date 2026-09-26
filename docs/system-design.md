---
title: Care Service — System Design
owner: care-team
service: care-service
status: draft
diataxis: explanation
last_verified: 2026-09-26
tags: [system-design, architecture, router, care]
related: [overview, data-model, api, scheduling-slots, consultation-lifecycle, clinical-records, rbac, integration, resilience, infrastructure, future]
---

# System Design — care-service

This page is the **router**. The design is sharded — one document per concern. Load only the shard you need.
Seeded from the PRD (`../vcare-hub/product/prd.md`) and `CLAUDE.md`; `/system-design <topic>` refines it.

| Shard | Read it when you need to… | Lens |
|---|---|---|
| [architecture/overview.md](./architecture/overview.md) | see containers, module map, layering, request pipeline | explanation |
| [architecture/data-model.md](./architecture/data-model.md) | look up tables, constraints, indexes, ERD | reference |
| [architecture/api.md](./architecture/api.md) | look up routes with roles, ownership, audit | reference |
| [architecture/scheduling-slots.md](./architecture/scheduling-slots.md) | understand availability, timezones, booking re-validation, caches | explanation |
| [architecture/consultation-lifecycle.md](./architecture/consultation-lifecycle.md) | understand statuses, transitions, windows, flows D/E/F | explanation |
| [architecture/clinical-records.md](./architecture/clinical-records.md) | understand records, lock, amendments, attachments, AI boundary | explanation |
| [architecture/rbac.md](./architecture/rbac.md) | check permissions, per-route policies, viewer-aware DTOs | reference |
| [architecture/integration.md](./architecture/integration.md) | understand service tokens and Integration Cases 1–3 | explanation |
| [architecture/resilience.md](./architecture/resilience.md) | understand timeouts, retries, durable jobs, idempotency, alerts | explanation |
| [architecture/infrastructure.md](./architecture/infrastructure.md) | look up env vars, logging, errors, health | reference |
| [architecture/deployment.md](./architecture/deployment.md) | understand components (`care-api`, `care-worker`), availability/RPO/RTO, release smoke, bottlenecks, metrics and alerts | explanation |
| [architecture/capacity.md](./architecture/capacity.md) | check Care's load, compute, database, storage, and Redis sizing and its 10× check | explanation |
| [architecture/file-handling.md](./architecture/file-handling.md) | understand uploads (intent → S3 → verified complete), on-demand download URLs, bucket rules, contract changes | explanation |
| [architecture/future.md](./architecture/future.md) | see what is deferred and why | explanation |

## Key decisions
| ADR | Decision |
|---|---|
| [0001](./adr/0001-no-orm-knex-raw-sql.md) | No ORM — Knex + raw-SQL migrations |
| [0002](./adr/0002-slots-never-stored.md) | Slots are computed, never stored |
| [0003](./adr/0003-db-exclusion-constraint.md) | Non-overlap guaranteed by a `btree_gist` exclusion constraint |
| [0004](./adr/0004-cross-service-failure-policies.md) | Per-case failure policies for identity-service calls |
| [0005](./adr/0005-availability-and-recovery-targets.md) | 99.9 % availability, async replica, RPO/RTO targets |
| [0006](./adr/0006-health-split-redis-tier-2.md) | Redis Tier 2; health split into liveness and readiness |
| [0007](./adr/0007-log-derived-metrics.md) | Log-derived metrics (embedded metric format) |
| [0008](./adr/0008-care-worker-component.md) | Background work in a separate `care-worker` |
| [0009](./adr/0009-audit-logs-monthly-partitions.md) | `audit_logs` monthly range partitions, ≥ 6-year retention |
| [0010](./adr/0010-next-available-lazy-cache-worker-refresh.md) | `next-available` lazy cache + worker refresh |
| [0011](./adr/0011-notification-outbox-and-reminders.md) | Notifications via transactional outbox; reminders via worker scan |
| [0012](./adr/0012-doctor-reinstatement.md) | Admin doctor reinstatement, retry-report-pending (Case 4) |
| [0013](./adr/0013-verified-direct-upload-lifecycle.md) | Direct-to-S3 uploads via temporary intent; row only after verified `complete` |
| [0014](./adr/0014-on-demand-download-urls.md) | On-demand, audited, 60 s presigned download URLs |
| [0015](./adr/0015-aws-sdk-storage-adapter.md) | AWS SDK v3 modular packages behind `lib/storage` |
| [0017](./adr/0017-generic-helpers-and-transaction-scoping.md) | Generic helpers live in `lib/`/`pkg/`; transactions use Knex's handler form |

`/system-design` 2026-09-15 (Care runtime, capacity, notifications, reinstatement) also produced hub ADR 0009
(doctor reinstatement via Care) and hub ADR 0010 (notification contact lookup). The file-handling session
(ADRs 0013–0015) produced hub ADR 0011 (browsers reach private object storage through presigned URLs).

Platform decisions that constrain Care (hub, 2026-09-15): ADR 0005 single public origin with edge path routing
(CORS dev-only) · ADR 0006 doctor account status changes only through Care (closes the known gap in
[integration.md](./architecture/integration.md)) · ADR 0007 managed container platform. This repo's `CLAUDE.md`
(Security rules → CORS; Cross-service integration → doctor account status) was aligned on 2026-09-15.

## Source of truth
**The API source of truth is [`contracts/openapi.yaml`](../contracts/openapi.yaml).** `architecture/api.md` and
module specs mirror it; on disagreement the contract wins and the prose is stale.

Platform-scope architecture lives **only** in the hub (hub ADR 0008), starting at `../vcare-hub/INDEX.md`: the
platform overview and C4 views (`architecture/overview.md`), deployment topology and availability roll-up
(`deployment.md`), shared capacity assumptions and sizing roll-up (`capacity.md`), integration cases
(`landscape.md`), data ownership, and Identity's synced contract. Care's capacity derivation and availability
targets are authored here ([capacity.md](./architecture/capacity.md), [deployment.md](./architecture/deployment.md))
and rolled up in the hub. The service summary the hub aggregates is [service-card.md](./service-card.md).
Start at [INDEX.md](./INDEX.md).
