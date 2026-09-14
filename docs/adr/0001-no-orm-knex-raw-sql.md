---
title: "ADR 0001: No ORM — Knex query builder + raw-SQL migrations"
owner: care-team
service: care-service
status: accepted
date: 2026-09-14
diataxis: explanation
last_verified: 2026-09-14
tags: [adr, decision, database, knex]
related: [data-model, infrastructure, adr-0003-db-exclusion-constraint]
---

# ADR 0001 — No ORM; Knex query builder + raw-SQL migrations

- **Status:** Accepted • **Date:** 2026-09-14 • **Deciders:** care-team

## Context
Care's correctness depends on PostgreSQL features that ORMs model poorly or not at all: a `btree_gist` exclusion
constraint over `tstzrange`, partial unique indexes for soft delete, an update-after-lock trigger on medical
records, `REVOKE` on append-only tables, `FOR UPDATE SKIP LOCKED` for durable jobs, and GiST range-overlap queries
on the slot hot path. The hot paths have p95 budgets (search < 400 ms, 14-day slots < 300 ms, booking < 200 ms)
that require every query to be visible and `EXPLAIN`-checked. Clinical data must never be over-selected.

## Decision
Use **Knex** over `pg` as a query builder and write **migrations as raw SQL** (`knex.raw`) with a real `down`.
Repositories are exported functions with an optional `conn: Knex` for transactions, explicit column lists (never
`SELECT *`), and a private `toEntity` mapper. Services own transactions. ORMs (Prisma, TypeORM, Sequelize,
Drizzle, Kysely, MikroORM) are forbidden.

## Consequences
- ➕ Constraints, triggers, grants, and indexes are written exactly as PostgreSQL executes them.
- ➕ Every query is reviewable and `EXPLAIN`-able; column lists keep clinical fields out of queries that do not need them.
- ➕ Transactions that combine a write, its audit row, and a constraint-mapped error (`23P01`) stay explicit.
- ➕ No migration lock-in or generated schema drift.
- ➖ More boilerplate (column constants, mappers, hand-written SQL).
- ➖ No compile-time link between SQL and TypeScript types; covered by integration tests against real Postgres.

## Alternatives considered
- **Prisma** — rejected: no exclusion constraints or partial indexes in its schema language without escaping to raw
  SQL, opaque generated queries, its own migration engine.
- **TypeORM / MikroORM** — rejected: decorator entities, lazy relations that invite N+1, weak support for range types.
- **Kysely / Drizzle (typed builders)** — rejected for MVP: better typing, but a new dependency that still needs raw
  SQL for the features above; revisit by ADR if type-safety gaps cause defects.
