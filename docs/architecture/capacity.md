---
title: Capacity Derivation
owner: care-team
service: care-service
status: accepted
diataxis: explanation
last_verified: 2026-10-08
tags: [architecture, capacity, sizing, load, storage, redis]
related: [deployment, infrastructure, data-model, scheduling-slots, adr-0009-audit-logs-monthly-partitions, adr-0010-next-available-lazy-cache-worker-refresh, hub-capacity]
---

# Capacity Derivation — care-service

Care's sizing, derived from the platform's shared traffic assumptions. Service-scope (hub ADR 0008).
**Inputs are authored in the hub** (`../vcare-hub/architecture/capacity.md` → sections 1–2: 500 k registered,
50 k DAU, 500 k listing pages/day, peak = daily × 0.15 / 3600 × 2, 10× headroom). **Values below are authored
here**; the hub's Care roll-up row quotes the headlines and links back. Decided in `/system-design` on 2026-09-15.

## 1. Care-specific assumptions (authored here)
| Assumption | Value | Why |
|---|---|---|
| Consultations booked | **7.5 k/day** (2.5 k doctors × 3) → ≈ 2.7 M/year | lean MVP target chosen by care-team; full utilisation is covered by the 10× check |
| Reschedules + cancellations | 20 % of bookings → 1.5 k/day | |
| Completed → medical record | 90 % → ≈ 6.75 k records/day | |
| Attachments | 1 per 2 records, 1.5 MB average | |
| Verification documents | 4 per doctor × 2 MB | |
| Listing pages split (hub input 500 k/day) | search 300 k · consultation/patient lists 200 k | |
| Slot views | 300 k/day (≈ 1 per search page) | |
| Audit rows | ≈ 100 k/day | status changes (~4/consultation) + clinical reads + record writes + download-url issuance |

## 2. Per-endpoint load
| Path | Per day | Peak rps | Budget (p95) |
|---|---|---|---|
| `GET /api/doctors` (search) | 300 k | 25 | < 400 ms |
| `GET /api/doctors/:id/slots` | 300 k | 25 | < 300 ms |
| `GET /api/doctors/:id` | 150 k | 12.5 | — |
| consultation and patient lists | 200 k | 17 | < 200 ms (calendar) |
| other reads (detail, waiting room, records, profiles, help) | 300 k | 25 | — |
| `POST /api/consultations` | 7.5 k | 0.6 | < 200 ms |
| reschedule, cancel | 1.5 k | 0.1 | < 200 ms |
| join, start, complete, no-show | 22.5 k | 1.9 | — |
| record writes and amendments | 7.5 k | 0.6 | — |
| uploads | 5 k | 0.4 | — |
| **Total** | **≈ 1.3 M** | **≈ 105** | |

Case 2 hydration reaching Identity and JWKS/service-token load are platform numbers (hub capacity section 2).

## 3. Compute
| Component | Size | Count | Reasoning |
|---|---|---|---|
| `care-api` | 1 vCPU, 2 GB | min 2, max 6 | ≈ 50 rps per task at peak, DB-bound handlers, slot computation < 5 ms in memory; autoscale on CPU 60 % or search p95 > 400 ms |
| `care-worker` | 0.5 vCPU, 1 GB | 1 (2 when lag alerts repeat) | ≈ 25 k outbox rows/day, 1-minute reminder scan, coalesced `next-available` refreshes ([ADR 0008](../adr/0008-care-worker-component.md)) |
| `care-migrate` | 0.5 vCPU, 1 GB | one-off per release | |

## 4. PostgreSQL
- **Class:** 2 vCPU / 8 GB; single-AZ primary + async replica in a second AZ ([ADR 0005](../adr/0005-availability-and-recovery-targets.md)).
- **Load at peak:** ≈ 400 queries/s (search 3 queries, slots 5 on a cache miss, lists 1–2), ≈ 10 writes/s including
  audit and outbox rows.
- **Connections:** each `care-api` task opens up to `DATABASE_POOL_MAX` request connections **plus 1** for the
  readiness probe pool (`application_name=care-api-probe`, foundation 2026-09-28); the worker is budgeted at 5
  (its pool max is 4 since verification); `care-migrate` uses 1 during a release.

  | `DATABASE_POOL_MAX` | Per API task | 2 tasks + worker | 6 tasks + worker |
  |---|---|---|---|
  | 20 (code default, `lib/config/env.ts`) | 21 | **47** | **131** |
  | 10 (the value this derivation assumed on 2026-09-15; must then be set explicitly per task) | 11 | 27 | 71 |

  Either fits the 2 vCPU / 8 GB class. Which value production sets is not decided yet; until it is, the
  code default (20) applies, and the hub roll-up's "≈ 25 connections" is stale (it predates the probe connection and
  assumed 10). At 10× (15–20 tasks) the default gives ≈ 320–425 connections, so the connection proxy in §7 is needed
  either way.

| Table | Rows/year | ≈ bytes/row incl. indexes | Year 1 |
|---|---|---|---|
| `audit_logs` (monthly partitions, [ADR 0009](../adr/0009-audit-logs-monthly-partitions.md)) | 36 M | 1 KB | **36 GB** |
| `medical_records` + amendments | 2.5 M | 4 KB | 10 GB |
| `consultations` (incl. GiST exclusion index) | 2.7 M | 1.5 KB | 4 GB |
| `notification_outbox` (30-day retention) | ~750 k live | 1 KB | 1 GB steady |
| everything else (profiles, schedules, types, jobs, help, attachment rows) | small | — | < 1 GB |
| **Total** | | | **≈ 52 GB steady / 100 GB provisioned with autoscaling** |

## 5. Redis (Tier 2)
| Keyspace | Size |
|---|---|
| `slots:*` (TTL ≤ 60 s) | < 50 MB |
| `next-available:*` (2.5 k doctors) | < 1 MB |
| `identity:user:*` (TTL 300 s, ~30 k active ids) | ≈ 10 MB |
| idempotency (24 h, ~10 k writes/day) | ≈ 20 MB |
| rate limits, refresh set | small |
| **Total** | **< 100 MB → smallest managed node with a replica** |

## 6. Object storage
| Class | Volume |
|---|---|
| Record attachments | ≈ 5.6 GB/day → **≈ 2 TB/year**; lifecycle to infrequent-access after 90 days |
| Verification documents | ≈ 20 GB total |
Soft-deleted objects are not purged in MVP.

## 7. 10× check (75 k consultations/day, ≈ 1 000 rps)
| Resource | At 10× | Verdict |
|---|---|---|
| `care-api` | ≈ 15–20 tasks | holds — raise max; add a connection proxy past ~10 tasks (each task holds up to `DATABASE_POOL_MAX + 1` connections) |
| PostgreSQL | ≈ 4 000 qps, ≈ 520 GB/year (audit 360 GB) | holds with discovery reads on the replica and a 4–8 vCPU class; audit partitions archived by retention |
| Redis | < 1 GB | holds |
| Object storage | ≈ 20 TB/year | holds (cost, not architecture) |
| Worker | ≈ 250 k outbox rows/day | holds with 2 workers |
**Verdict: holds with scale-out** — no redesign.

## 8. Revisit triggers
Any of, for a week: search p95 > 300 ms · API tasks at max for > 3 days · DB CPU > 60 % at peak · an `audit_logs`
partition > 10 GB · consultations > 20 k/day · replica lag p95 > 30 s. Platform triggers live in the hub.
