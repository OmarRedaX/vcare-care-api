---
title: "ADR 0026: doctor search degrades to price order when Redis is down"
owner: care-team
service: care-service
status: accepted
date: 2026-10-21
diataxis: explanation
last_verified: 2026-10-21
tags: [adr, decision, search, resilience, redis, degradation]
related: [availability, resilience, adr-0006-health-split-redis-tier-2, adr-0024-next-available-rank-index-free-map-and-sweep, adr-0025-derived-name-index]
---

# ADR 0026 — doctor search degrades to price order when Redis is down

- **Status:** Accepted • **Date:** 2026-10-21 • **Deciders:** care-team

## Context
Redis is Tier 2 ([ADR 0006](./0006-health-split-redis-tier-2.md)): its loss may slow or degrade reads but must not stop
booking. Search ([ADR 0024](./0024-next-available-rank-index-free-map-and-sweep.md),
[0025](./0025-derived-name-index.md)) now depends on three Redis structures, and its default sort is earliest availability.

## Decision
- When the rank index is unreachable (Redis down, breaker open, command timeout), `GET /api/doctors` still answers `200`:
  the earliest-availability sort falls back to `(consultationFee ASC, id)` with a SQL keyset; a page's rows get
  `nextAvailableAt` computed inline, at most `AVAILABILITY_INLINE_MISS_CAP` (default 20) doctors, the rest `null`.
- Parts that cannot be honoured are ignored and named in `meta.degraded` (values `sort`, `availabilityFilter`,
  `nameFilter`; the field is absent when nothing is degraded). A name filter falls back to headline-only.
- `GET /api/doctors/{id}/slots` is unaffected: it computes from Postgres (5 queries), within its 300 ms budget on a miss.
- Booking re-validates against Postgres every time, so a degraded list can never cause a wrong booking.
- Metric `availability_degraded{reason}`; alert `AvailabilityDegradedHigh` (ticket) when more than 5 % of searches are
  degraded for 5 minutes.

## Consequences
- ➕ Patients can still browse and book during a Redis outage; the contract tells the client what was ignored.
- ➖ The contract gains `meta.degraded` (lands through `/construct-spec`); clients must handle a missing availability sort.
- ➖ A cursor issued in degraded mode (price order) is not valid after Redis recovers; the client gets `400 ValidationFailed`
  on a cursor whose sort kind no longer matches and restarts the list.

## Alternatives considered
- **Degrade with `nextAvailableAt: null` on every row:** rejected; a small, bounded inline computation is cheap enough.
- **`503` for requests that depend on the unavailable parts:** rejected; the default sort depends on them, so it would make
  Redis effectively Tier 1 for discovery and contradict ADR 0006.
