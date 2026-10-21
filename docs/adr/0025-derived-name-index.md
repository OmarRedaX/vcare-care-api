---
title: "ADR 0025: a TTL-bound derived name index in Redis serves the doctor name filter"
owner: care-team
service: care-service
status: accepted
date: 2026-10-21
diataxis: explanation
last_verified: 2026-10-21
tags: [adr, decision, search, identity, privacy, caching, redis]
related: [availability, integration, capacity, adr-0004-cross-service-failure-policies, adr-0024-next-available-rank-index-free-map-and-sweep, adr-0026-discovery-degradation-when-redis-is-down]
---

# ADR 0025 — a TTL-bound derived name index in Redis serves the doctor name filter

- **Status:** Accepted • **Date:** 2026-10-21 • **Deciders:** care-team

## Context
PRD 7.4 requires searching doctors by name. Display names belong to Identity; Care hydrates them per page (Case 2) and
must never copy them into its own tables. SQL therefore cannot match a name prefix, and hydrating the whole candidate set
inline per search would break the 400 ms budget whenever Identity is slow.

## Decision
- `care-worker` builds `name-index` in Redis, a lexicographic sorted set whose members are
  `<lowercased display name>\u0000<userId>`. The sweep job refreshes it every `AVAILABILITY_NAME_REFRESH_SECONDS`
  (default 300 s): it hydrates the bookable doctors through `lib/identity-client` in batches of 100, reading through the
  existing `identity:user:<id>` cache, builds a temporary key and swaps it in atomically. The live key has a TTL of 15 min.
- A name filter is a `ZRANGEBYLEX` prefix query on the index, intersected with the SQL candidate ids, unioned with a
  headline prefix match done in SQL.
- If the index is missing or the last good build has expired (Identity down for more than ~15 min, worker down, Redis
  down), the filter falls back to **headline only** and the response says `meta.degraded: ["nameFilter"]`. Search never
  returns a 5xx because of it.
- The index is a Case 2 derived cache (same class as `identity:user:*`): never written to Postgres, never logged, never
  returned except as the effect of a filter. Names it holds are already shown to every patient in search results.

## Consequences
- ➕ PRD 7.4 name search without copying Identity data into Care's database and without per-search Identity load.
- ➖ About 7.2 k extra `GET /internal/users` calls per day (25 calls per refresh, 288 refreshes), about +7 % on the hub's
  ~100 k/day Case 2 figure; recorded in the hub capacity model.
- ➖ A renamed doctor is matched under the old name for up to 5 minutes (worst case 15 on a failed refresh).
- ➖ Prefix match only, on the whole display name; word-internal matching is not supported.

## Alternatives considered
- **Hydrate the candidate set per search:** rejected; unbounded Identity dependency on the hot path and uncached doctors
  would be silently missed.
- **Headline only in the MVP:** rejected; PRD 7.4 "search by name" would not be met.
- **A search endpoint on Identity:** rejected for the MVP; it needs a provider-first contract change and returns users of
  every role.
