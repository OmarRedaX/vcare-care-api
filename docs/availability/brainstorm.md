---
title: availability — Brainstorm
owner: care-team
service: care-service
module: availability
status: draft
diataxis: explanation
last_verified: 2026-10-21
tags: [brainstorm, availability, search, slots, discovery]
related: [system-design, availability-architecture, scheduling-slots, adr-0024-next-available-rank-index-free-map-and-sweep, adr-0025-derived-name-index, adr-0026-discovery-degradation-when-redis-is-down]
---

# availability — Brainstorm

The architecture is already decided: [architecture/availability.md](../architecture/availability.md) and ADRs
[0024](../adr/0024-next-available-rank-index-free-map-and-sweep.md), [0025](../adr/0025-derived-name-index.md),
[0026](../adr/0026-discovery-degradation-when-redis-is-down.md) (2026-10-21). This brief fixes the **scope, rules and
open questions** of the module; it does not repeat the design. Altitude check: no new architecture decision is needed.

## Problem & purpose
A patient can book today only if the client already knows a doctor id and a valid start. PRD 7.4 (discovery) and 7.5
(pick a slot shown in the patient's timezone) have no API: nothing lists doctors, shows a doctor's public profile, or
returns free slots. `availability` adds exactly those three read routes, and replaces the two no-op change listeners with
real cache invalidation. It also supplies the shared slot logic so the list a patient sees and the check booking runs
cannot disagree.

## Actors
- **Patient** — searches, opens a doctor, picks a slot (then books through `consultations`).
- **Admin** — same read routes; additionally opens any doctor's profile (`status: bookable | not_bookable`).
- **Doctor** — no access to these routes (RBAC table: search is patient/admin only).
- **`care-worker`** — builds the rank index, free-map and name index (no HTTP).

## In scope (this iteration)
One module, **built and merged slice by slice** (decided 2026-10-21); each slice ends green and can merge alone:
1. **Slots.** Pure `pkg/slots` additions (`subtractBusy`, `sliceSlots`, `firstFreeStart`, `toFreeMap`, `testFreeMap`),
   `SlotInputsLoader`, `GET /api/doctors/{id}/slots`, the `slots:` cache with `slots-ver`, the real
   `ScheduleChangeListener` / `ConsultationChangeListener` bindings, and the new `DoctorChangeListener` port in `doctors`
   (fired by `doctors` and `admin-doctors`).
2. **Search and profile.** `next-available:index`, `free-map:*`, the refresh set, the `availability-refresh` and
   `availability-sweep` worker loops, `GET /api/doctors`, `GET /api/doctors/{id}`, the public `DoctorProfile` DTO, the
   partial bookable-candidate index migration, Redis-down degradation (`meta.degraded`).
3. **Name filter.** `name-index`, its 300 s rebuild in the sweep, the `name` filter and its headline-only fallback.

## Out of scope
Booking, reschedule, cancel (already built in `consultations`); doctor-initiated follow-up booking; ratings or
reviews; geo or "near me" search; free-text search over bio; a name filter that matches word-internal text; per-type
availability in search (the index uses the shortest active type); a Postgres table of derived values; read replicas;
the Phase-2 booking agent's tools; any hub deployment, capacity or ownership change (all already rolled up).

## Key entities & relationships
No new tables. Reads `doctor_profiles`, `doctor_specialties` + `specialties` (slug), `doctor_languages`,
`working_hours`, `schedule_exceptions`, `consultation_types`, `consultations`. Redis keys (all derived):
`next-available:index`, `free-map:<doctorUserId>`, `next-available:refresh`, `next-available:swept-at`, `name-index`,
`slots:<doctorUserId>:<ver>:<typeId>:<fromDate>:<toDate>`, `slots-ver:<doctorUserId>`. One migration: partial indexes
for the bookable-candidate query (each commented with that query).

## Primary flows / endpoints (with roles + ownership)
| Route | Roles | Ownership | Notes |
|---|---|---|---|
| `GET /api/doctors` | patient, admin | none | candidates in SQL, ranked from the index; keyset page; Case 2 hydration; rate limit 60/min per IP, 120/min per user |
| `GET /api/doctors/{doctorUserId}` | patient, admin | none | patient: `404` unless bookable; admin: any doctor with `status`; `nextAvailableAt` and 5 `nextAvailableSlots` (shortest active type) rendered in `timezone` |
| `GET /api/doctors/{doctorUserId}/slots` | patient, admin | none | `typeId`, `from`, `to` (≤ 14 days, clipped to `[now, now+60 d]`), optional `timezone`; **`404` for a non-bookable doctor for both roles** (decided 2026-10-21) |

Every route has `authorize(policy)`. Accounts: patients and admins must be `status=active`; no email-verified requirement
(that gates booking only). Timezone for rendering: `timezone` param, else the patient's profile zone (via
`PatientsService.findProfile`), else UTC (admins have no patient profile, so UTC). Slot rendering happens after the cache.

## Business rules & state transitions
- A doctor is searchable and slot-able only when bookable (Domain rule 6); the SQL candidate query and `/slots` use the
  same predicate as booking (`isBookable`).
- `typeId` must belong to the doctor and be active, else `404 NotFound` (same as booking's type check).
- The slot list uses the same grid functions as `slot-fit.ts`: anchored on the working interval's start, busy intervals do
  not move the grid, intervals are per doctor-local date and never merged across dates.
- The index and free-map are computed on the doctor's **shortest active type** (ties: lowest id); a doctor with no free
  slot in the next 14 days is the known-"none" sentinel.
- Window filters: inside `[now, now+14 d]`, at most 14 days; missing `from` = now, missing `to` = `from + 14 d`;
  otherwise `400 ValidationFailed`. Exact to 15 minutes.
- Sort: `earliest_availability` (default), `price`, `experience`. The cursor is signed; a cursor whose sort kind no longer
  matches is `400 ValidationFailed`.
- Freshness: remove-on-change + refresh + 120 s sweep; a miss is an absent member or a score before `now`; at most
  `AVAILABILITY_INLINE_MISS_CAP` (20) inline computations per request.
- Redis down: `200` in price order with `meta.degraded`; `/slots` and `getDoctor` compute from Postgres.
- Search never computes slots per row beyond the cap; no N+1; no `SELECT *`.

## Cross-service touchpoints (case, direction, failure policy)
- **Case 2** (Care → Identity, degrade): one batched hydration per search page; `profileHydrated:false` on failure; never 5xx.
- **Name index** (ADR 0025): the sweep hydrates bookable doctors through `lib/identity-client` every 300 s via the
  `identity:user:*` read-through cache; failure keeps the last build until its 15 min TTL, then headline-only.
- No new Identity endpoint and no new scope.

## Privacy & audit
No clinical data; no audit rows (consistent with CLAUDE.md's audited actions). The public DTO omits suspension, sync and
verification state; only the admin view carries `status`. Names exist in Redis only (`identity:user:*`, `name-index`,
at most 15 min), are never logged and never reach Postgres. The cursor is the existing signed cursor.

## Constraints & guideline notes
Express 5, `class-validator` DTOs with explicit `ToInt()`/`ToBoolean()`; luxon only for time; repositories are functions;
generic Redis helpers belong in `lib/redis`, not in a service; new env vars in `lib/config/env.ts`
(`AVAILABILITY_SWEEP_INTERVAL_SECONDS`, `AVAILABILITY_NAME_REFRESH_SECONDS`, `AVAILABILITY_INLINE_MISS_CAP`); worker
loops registered in `worker-loops.ts`; a session advisory-lock namespace for the sweep (existing: 1101 to 1103). Budgets:
search p95 < 400 ms, 14-day slots p95 < 300 ms (benchmark with a busy doctor, 150 consultations).
No forbidden library is needed, and the Redis structures (sorted sets, a string bitmap, sets) need no new dependency.

## Contract changes expected
Provider is care; no Identity change. Listed in the shard ("Contract changes"): `meta.degraded` on `searchDoctors`;
`availableFrom/To` window rules and defaults; `nextAvailableAt` / `nextAvailableSlots` / `name` wording; cursor sort-kind
`400`; `404` on `/slots` for a non-bookable doctor and for an unknown or inactive `typeId`. They land first in
`contracts/openapi.yaml` at spec/develop step 0 (`x-roles`, `x-ownership`, error codes).

## Open questions
All resolved on 2026-10-21 by accepting the recommendations below; the spec turns them into exact definitions.
1. **Sweep lock and `free-map` layout.** Session advisory-lock namespace **1104** (existing 1101 to 1103). `free-map` is
   173 bytes: byte 0 = version `1`, bytes 1 to 4 = big-endian `uint32` base bucket (epoch seconds / 900 of the computation
   instant rounded down), then 168 bytes of bits (MSB first), bit `i` set when 15-minute bucket `base + i` contains a free
   slot start; 1 344 buckets cover 14 days.
2. **Candidate indexes.** Two partial indexes on `doctor_profiles` limited to the bookable profile predicate (not deleted,
   approved, synced, not suspended, accepting): `(consultation_fee, id)` for the price sort and `(years_experience DESC, id)`
   for the experience sort. "At least one active type" stays an `EXISTS` on `idx_consultation_types_doctor_profile_id_active`.
   Exact DDL and `EXPLAIN` evidence in the spec and develop.
3. **`DoctorChangeListener` sources.** Fired by `doctors` (timezone change, accepting toggle) and `admin-doctors`
   (suspend, reinstate) after commit. Not fired by `verification` or `identity-sync`: a doctor becoming bookable
   appears as a miss (computed on demand) and the sweep covers it within about 2 minutes.
4. **Public profile DTO.** `DoctorsService` gains a read method that returns public views for a set of profile user ids
   (specialty refs, languages, fee as money, active types); `availability` maps them to its own response DTOs and never
   imports a `doctors` repository.
5. **Rendering zone.** Keep UTC when there is no `timezone` param and no patient profile (as the contract says).
6. **After the build.** `CLAUDE.md` edits (`slots:` key `<ver>`, status line, module list) and the hub card re-sync are
   `/update-docs` work; no platform-scope delta is outstanding.

## Success criteria
- A patient can search, open a doctor and see correct slots in their timezone; the slot list and booking agree
  (shared `pkg/slots`; a property test books every listed slot and none outside it).
- Budgets hold: search p95 < 400 ms at 2.5 k doctors, 14-day slots p95 < 300 ms for a busy doctor, with and without
  cache hits; a benchmark test is included.
- Freshness: a booking, hours change, exception, type change or timezone change is reflected in the slot list within the
  60 s TTL at worst and in the rank index within one sweep; a lost invalidation is repaired by the sweep.
- Degradation: Redis down, worker down and Identity down each return `200` with the documented `meta.degraded` or
  `profileHydrated:false`; never a 5xx.
- RBAC per route (doctor denied, patient and admin allowed, patient `404` on a non-bookable doctor); contract
  conformance for every status and error code; logs contain no names from the name index.
- Pagination page 2 on each sort; window filters exact to 15 minutes including DST days and cross-midnight rendering.
