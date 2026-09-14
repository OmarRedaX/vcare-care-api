---
title: Care Service — Docs Index
owner: care-team
service: care-service
status: draft
last_verified: 2026-09-14
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
| [architecture/future.md](./architecture/future.md) | see deferred work: events, the doctor-status gap, Phase-2 AI, out of scope | explanation |

## Decisions (ADRs, append-only)
| ADR | Decision | Lens |
|---|---|---|
| [adr/0001-no-orm-knex-raw-sql.md](./adr/0001-no-orm-knex-raw-sql.md) | Knex query builder + raw-SQL migrations, no ORM | explanation |
| [adr/0002-slots-never-stored.md](./adr/0002-slots-never-stored.md) | availability is computed per request, never stored | explanation |
| [adr/0003-db-exclusion-constraint.md](./adr/0003-db-exclusion-constraint.md) | a `btree_gist` exclusion constraint guarantees non-overlap | explanation |
| [adr/0004-cross-service-failure-policies.md](./adr/0004-cross-service-failure-policies.md) | Case 1 retry-report-pending, Case 2 degrade, Case 3 must-not-degrade | explanation |

## Module docs
Created by the workflow, not ahead of time: `/brainstorm <feature>` creates `docs/<module>/` (brainstorm,
spec, tasks, manual-qa, reviews/). Each module gets rows here when it starts.

## Contract (source of truth — prose above derives from it)
| Contract | Defines |
|---|---|
| [contracts/openapi.yaml](../contracts/openapi.yaml) | the HTTP API: public `/api/*` and network-isolated `/internal/*` |

There is no AsyncAPI contract: MVP is HTTP-only; future events are listed in `x-future-events`.

---
_Cross-service questions (Identity's contract, who calls whom, data ownership, glossary, PRD) → the hub:
`../vcare-hub/INDEX.md` (on GitHub: [OmarRedaX/Vcare](https://github.com/OmarRedaX/Vcare/blob/main/INDEX.md)).
Do not clone another service just to read it._
