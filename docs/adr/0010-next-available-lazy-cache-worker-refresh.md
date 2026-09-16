---
title: "ADR 0010: next-available is a lazy Redis cache refreshed by the worker"
owner: care-team
service: care-service
status: accepted
date: 2026-09-15
diataxis: explanation
last_verified: 2026-09-15
tags: [adr, decision, search, caching, performance, slots]
related: [scheduling-slots, capacity, adr-0002-slots-never-stored, adr-0008-care-worker-component]
---

# ADR 0010 — `next-available` is a lazy Redis cache refreshed by the worker

- **Status:** Accepted • **Date:** 2026-09-15 • **Deciders:** care-team

## Context
Search sorts by earliest availability at ~25 rps peak (≈ 300 k searches/day) within a 400 ms p95 budget. Slots are
never stored ([ADR 0002](./0002-slots-never-stored.md)). With lazy computation only, a mass invalidation or a cold
Redis makes every row on a page a miss and can break the budget.

## Decision
- `next-available:<doctorUserId>` in Redis, TTL 300 s, holds the earliest free slot start in the next 14 days (or
  "none").
- Search reads the page's doctors with one `MGET`; misses are computed inline for **that page only** (≤ `limit`
  doctors) and written back.
- Every input change (booking, reschedule, cancel, no-show, hours, exceptions, types, timezone, accepting toggle,
  suspension, reinstatement) **deletes** the key after commit **and** enqueues a refresh that `care-worker` computes
  within seconds — so hot doctors are rarely missed by readers.
- Refresh requests are coalesced per doctor (a Redis set drained by the worker); losing them (Redis down) only
  means lazy computation.

## Consequences
- ➕ Search hits stay cache-warm; no refresh pipeline in Postgres; the whole key set is < 1 MB at 2.5 k doctors.
- ➖ The worker does extra slot computations on busy doctors (bounded by coalescing).
- ➖ A cold start still computes inline for one page at a time.

## Alternatives considered
- **Precomputed `doctor_profiles.next_available_at` column** — rejected: write amplification on every booking and a
  derived value in a source table.
- **Lazy only** — rejected: mass invalidations and cold starts risk the search budget.
