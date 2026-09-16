---
title: "ADR 0009: audit_logs is range-partitioned by month from the first migration"
owner: care-team
service: care-service
status: accepted
date: 2026-09-15
diataxis: explanation
last_verified: 2026-09-15
tags: [adr, decision, audit, postgres, partitioning, retention]
related: [data-model, capacity, clinical-records]
---

# ADR 0009 — `audit_logs` is range-partitioned by month from the first migration

- **Status:** Accepted • **Date:** 2026-09-15 • **Deciders:** care-team

## Context
Every clinical access and every state change writes an audit row: ≈ 100 k rows/day, ≈ 36 M rows and ≈ 36 GB per
year at the design load ([capacity.md](../architecture/capacity.md)), 10× that at the headroom point. The table is
append-only (`INSERT`/`SELECT` grants only) and medical audit trails must be retained for years. Converting a large
append-only table with grants to partitions later is a disruptive migration.

## Decision
- `audit_logs` is created as `PARTITION BY RANGE (created_at)` with **monthly partitions**
  (`audit_logs_yYYYYmMM`). Primary key `(id, created_at)`; indexes are defined on the parent.
- The first migration creates the current and next month; `care-worker` ensures the next **two** months exist
  daily (advisory-locked, idempotent). A `DEFAULT` partition catches mistakes and alerts if it is non-empty.
- Grants (`INSERT`, `SELECT` for `vcare_app`) are applied on the parent and every new partition.
- **Retention ≥ 6 years.** Older partitions are later detached and archived to object storage by an ops procedure
  (not in MVP code). Rows are never deleted by the application.

## Consequences
- ➕ Inserts and recent-range admin queries stay fast; retention becomes detach, not `DELETE`.
- ➖ Queries without a `created_at` bound scan every partition — `GET /api/audit-logs` requires a time range
  (defaulting to the last 30 days) — a contract detail for the audit module spec.
- ➖ Partition maintenance is a worker responsibility with its own alert (`AuditPartitionMissing`).

## Alternatives considered
- **Plain table, partition later** — rejected: disruptive migration at ~100 M rows.
- **Time-series extension** — rejected: new infrastructure dependency for one table.
