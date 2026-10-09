---
title: audit — Brainstorm
owner: care-team
service: care-service
module: audit
status: draft
diataxis: explanation
last_verified: 2026-10-09
tags: [brainstorm, audit, audit-logs, pagination, partitions]
related: [access-spec, admin-doctors-spec, adr-0009-audit-logs-monthly-partitions, adr-0018-db-role-split-explicit-grants-partition-function]
---

# audit — Brainstorm

Scope set on 2026-10-09 on branch `feature/admin-doctors` (the module is small and its only dependency, the write side
`lib/audit`, already exists). No owner-level decision is open: behaviour is fixed by `contracts/openapi.yaml`
(`listAuditLogs`, PR #29), the `access` spec hand-off (decision D1, §14.1) and ADR 0009.

## Problem & purpose
Audit rows are written everywhere (`lib/audit`) but nobody can read them. Admins need `GET /api/audit-logs` to answer
"who did what to this entity, when". `audit_logs` is range-partitioned by month, so an unbounded query would scan every
partition; the contract therefore makes every read time-bounded.

## Actors
- **Admin** — the only reader. Entries carry ids, statuses and reasons-length only, never clinical text, so the read is
  not itself a clinical access and is not audited.

## In scope (this iteration)
- `GET /api/audit-logs` newest first (`created_at DESC, id DESC`).
- Filters (whitelisted): `actorUserId`, `action`, `entityType`, `entityId`, `from`, `to`.
- **Time bounds always applied:** `to` defaults to now; `from` defaults to 30 days before `to`; `from` later than `to`
  → `400 ValidationFailed` (`details[].field`). Both ISO-8601 with offset.
- Keyset pagination unchanged: `?cursor&limit` (1..100, default 20), `limit + 1` fetch, `meta { nextCursor, hasMore, count }`;
  cursor encodes `(created_at, id)` with full microsecond precision (foundation fix #7).
- One migration creating the three read indexes on the partitioned parent (hand-off of D1), each commented with its query,
  plus whatever the time-bounded predicate needs for partition pruning.

## Out of scope
- Export, free-text search, `metadata` filtering, retention/detach tooling (ADR 0009), writing audit rows (exists).
- Any change to the append-only grants (INSERT/SELECT only).

## Key entities & relationships
`audit_logs` only (existing). Response DTO `AuditLogEntry`: `id, actorUserId|null, actorRole, action, entityType, entityId,
requestId|null, metadata, createdAt`. No joins, no Identity hydration.

## Primary flows / endpoints (with roles + ownership)
| Route | Role | Ownership | Notes |
|---|---|---|---|
| `GET /api/audit-logs` | admin (token status active) | none | 200 · 400 `ValidationFailed` (bad filters, `from > to`, bad cursor, limit out of range) · 401 · 403 · 429 |

## Business rules
- Window: `to := to ?? now`, `from := from ?? to − 30 days`; `from > to` is 400; `from == to` is an empty window, not an error.
- A very large explicit window is allowed (no cap in the contract); the keyset limit bounds the response, partition pruning
  bounds the scan. Whether to cap the span is a spec-time question (recommend: no cap, document).
- The upper bound is inclusive-exclusive to be decided in the spec (`created_at >= from AND created_at < to`, recommended)
  so a cursor from page 1 stays stable when `to` defaults to now (the effective `to` is frozen into the cursor).

## Cross-service touchpoints
None.

## Privacy & audit
Metadata is already clinical/PII-free by construction (`lib/audit` validation). The route returns it verbatim; request
logs carry no filter values that could identify a person (`entityId`/`actorUserId` are ids; log route label only).

## Constraints & guideline notes
- Layering: new `src/app/audit/` (read side) over the existing `lib/audit` (write side); no cross-module repo import.
- Repository: explicit columns, fixed number of queries, no `SELECT *`; `EXPLAIN` the three filter shapes and show
  partition pruning in an integration test (plan mentions only the in-window partitions).
- Tests must not depend on wall-clock "now": inject the clock for the default window.

## Contract changes expected
None expected (contract already declares the window). The spec may add 400 detail field names and the cursor semantics.

## Open questions
For `/construct-spec`: inclusivity of `to`; span cap (recommend none); how the frozen effective `to` travels in the cursor.

## Success criteria
- Default call returns only the last 30 days newest first; `from > to` → 400; page 2 reachable with stable order on ties.
- Each filter shape is served by its index and prunes partitions (asserted from `EXPLAIN`).
- Admin-only RBAC; entries contain no clinical text; the cursor survives a changing wall clock.
