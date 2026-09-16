---
title: "ADR 0005: Availability 99.9 %, async replica, RPO/RTO targets"
owner: care-team
service: care-service
status: accepted
date: 2026-09-15
diataxis: explanation
last_verified: 2026-09-15
tags: [adr, decision, slo, availability, disaster-recovery, backups]
related: [deployment, capacity, runbook, hub-deployment]
---

# ADR 0005 — Availability 99.9 %, async replica, RPO/RTO targets

- **Status:** Accepted • **Date:** 2026-09-15 • **Deciders:** care-team

## Context
Care is Tier 1 (search, booking, consultations), but no availability, data-loss, or recovery targets existed, so the
hub's availability roll-up had an empty Care row. identity-service committed to 99.95 % with a synchronous standby
(identity ADR 0009). Platform availability is bounded by the weakest Tier-1 service.

## Decision
| Target | Value |
|---|---|
| Availability | **99.9 % monthly** (≈ 43 min budget) |
| RPO | ≤ 1 min for AZ failure (async replication lag) · ≤ 5 min for logical corruption (PITR) |
| RTO | ≤ 30 min for task/AZ failure (promote replica) · ≤ 4 h for region loss |

Mechanisms: ≥ 2 `care-api` tasks across ≥ 2 AZs; managed PostgreSQL **single-AZ primary + asynchronous read replica
in a second AZ** (the replica also serves discovery reads and is the promotion target); point-in-time recovery;
daily encrypted snapshots retained 35 days and copied to a second region; quarterly restore and promotion drills.
Redis, the email provider, and the video provider are Tier 2 ([ADR 0006](./0006-health-split-redis-tier-2.md)).

## Consequences
- ➕ Roughly half the database cost of a synchronous standby; the replica is used, not idle.
- ➕ Clear inputs for `AvailabilityBudgetBurn` and release policy.
- ➖ **The platform availability roll-up becomes 99.9 %** (Care is the weaker Tier-1 service).
- ➖ An AZ failover can lose up to ~1 min of committed writes (bookings, record edits, audit rows). Mitigations:
  alert `DbReplicaLagHigh`; booking idempotency lets clients safely retry; runbook reconciles lost bookings from
  notification and request logs.
- ➖ Promotion is slower than automatic Multi-AZ failover (RTO 30 min vs ~2 min).

## Alternatives considered
- **99.95 %, synchronous standby (parity with Identity)** — recommended, rejected by the deciders on cost for MVP.
  Revisit when revenue or clinical-data-loss tolerance requires it (new ADR superseding this one).
- **99.99 %, multi-region active-passive** — rejected: ~2× infrastructure and buys nothing unless Identity also goes
  multi-region.
