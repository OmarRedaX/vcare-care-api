---
title: Care Service — System Design
owner: care-team
service: care-service
status: draft
diataxis: explanation
last_verified: 2026-09-14
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
| [architecture/future.md](./architecture/future.md) | see what is deferred and why | explanation |

## Key decisions
| ADR | Decision |
|---|---|
| [0001](./adr/0001-no-orm-knex-raw-sql.md) | No ORM — Knex + raw-SQL migrations |
| [0002](./adr/0002-slots-never-stored.md) | Slots are computed, never stored |
| [0003](./adr/0003-db-exclusion-constraint.md) | Non-overlap guaranteed by a `btree_gist` exclusion constraint |
| [0004](./adr/0004-cross-service-failure-policies.md) | Per-case failure policies for identity-service calls |

## Source of truth
**The API source of truth is [`contracts/openapi.yaml`](../contracts/openapi.yaml).** `architecture/api.md` and
module specs mirror it; on disagreement the contract wins and the prose is stale.

Cross-service context (landscape, data ownership, Identity's synced contract) lives in the hub:
`../vcare-hub/INDEX.md`. The service summary the hub aggregates is [service-card.md](./service-card.md).
Start at [INDEX.md](./INDEX.md).
