---
title: availability — Spec
owner: care-team
service: care-service
module: availability
status: ready
version: 0.2.0
diataxis: reference
last_verified: 2026-10-23
tags: [spec, availability, search, slots, discovery, redis, worker, rank-index, free-map, name-index, degradation, listeners]
related: [availability-brainstorm, availability-architecture, scheduling-slots, consultations-spec, schedules-spec, doctors-spec, admin-doctors-spec, verification-spec, data-model, api, capacity, infrastructure, resilience, adr-0002-slots-never-stored, adr-0006-health-split-redis-tier-2, adr-0008-care-worker-component, adr-0024-next-available-rank-index-free-map-and-sweep, adr-0025-derived-name-index, adr-0026-discovery-degradation-when-redis-is-down]
contracts: [contracts/openapi.yaml]
---

# availability — Spec

Doctor discovery: `GET /api/doctors` (search), `GET /api/doctors/{doctorUserId}` (public profile with a slots preview) and
`GET /api/doctors/{doctorUserId}/slots`, plus the real cache invalidation behind the three after-commit ports. The
architecture is decided and binding ([architecture/availability.md](../architecture/availability.md), ADRs
[0024](../adr/0024-next-available-rank-index-free-map-and-sweep.md), [0025](../adr/0025-derived-name-index.md),
[0026](../adr/0026-discovery-degradation-when-redis-is-down.md); [ADR 0010](../adr/0010-next-available-lazy-cache-worker-refresh.md)
is superseded). Scope and the resolved open questions come from [brainstorm.md](./brainstorm.md). This spec turns them into
exact definitions and is **organised around three build slices**, each mergeable alone:

| Slice | Delivers | Migration | Worker | Section | Status |
|---|---|---|---|---|---|
| **S1 Slots** | pure `pkg/slots` additions, `SlotInputsLoader`, `GET .../slots`, the `slots:` cache with `slots-ver`, the real `ScheduleChangeListener` / `ConsultationChangeListener` bindings, the new `DoctorChangeListener` port | none | none | 12.1, 13.1 | **built 2026-10-21** |
| **S2 Search and profile** | rank index, free-map, refresh set, `availability-refresh` + `availability-sweep` loops, `GET /api/doctors`, `GET /api/doctors/{id}`, public `DoctorProfile` DTO, candidate-index migration, Redis-down degradation, worker Redis | `20261021120000` | gains Redis | 12.2, 13.2 | **built 2026-10-23** (branch `feature/availability-slice2`; as-built notes in section 14) |
| **S3 Name filter** | `name-index` build in the sweep, the `name` filter on the index | none | sweep step | 12.3, 13.3 | planned |

Sections 1 to 11 are the contract of the module (what must be true); section 12 specifies the components slice by slice;
section 13 is the task list and exit gate of each slice. Binding rules: CLAUDE.md → "Database rules", "API conventions",
"Authorization — RBAC and ownership", "Security rules", "Privacy and logging", "Cross-service integration" (Case 2),
"Testing policy", "Performance rules", "Build order for a new module".

---

## 1. Overview

### 1.1 What `availability` owns
| Area | Delivers |
|---|---|
| Routes | `GET /api/doctors`, `GET /api/doctors/{doctorUserId}`, `GET /api/doctors/{doctorUserId}/slots` (patient, admin; all `GET`, no `Idempotency-Key`) |
| Pure logic | `pkg/slots`: `subtractBusy`, `sliceSlots`, `firstFreeStart`, `computeSlots`, `clipWindow`, `toFreeMap`, `testFreeMap`, `baseBucketOf` (reusing the grid rules of `slot-fit.ts`, so list and booking cannot disagree) |
| Derived data (Redis only) | `slots:*` + `slots-ver:*`, `next-available:index`, `free-map:*`, `next-available:refresh`, `next-available:swept-at`, `name-index` + `name-index:built-at` |
| Ports | fills `ScheduleChangeListener` and `ConsultationChangeListener`; adds `DoctorChangeListener` (declared in `doctors`, fired by `doctors` and `admin-doctors`) |
| Worker | loops `availability-refresh` and `availability-sweep` (singleton), the name-index rebuild inside the sweep |
| Tables | **none**. One migration of indexes on existing tables (S2) |

It does **not** own: booking, reschedule, cancel (`consultations`, unchanged); working hours, exceptions, types
(`schedules`); profile data (`doctors`); display names (Identity, hydrated per Case 2); any stored slot (ADR 0002).

### 1.2 Principles
1. **Slots are never stored.** Everything above in "Derived data" is a cache: losing it costs ordering quality for about
   one sweep (S2) or a few Postgres queries per request, never correctness. Booking re-validates against Postgres every time.
2. **One implementation of the grid.** The slot list, the free-map and `ConsultationsService.assertOnGrid` use the same
   `pkg/slots` functions (`resolveOpenIntervals`, `isSlotOnGrid` semantics). A property test books every listed slot and
   finds none outside the list (rule AV-R3).
3. **Redis is Tier 2** ([ADR 0006](../adr/0006-health-split-redis-tier-2.md)): no discovery route returns a 5xx because Redis
   or the worker is down. Identity down is Case 2: `profileHydrated:false`, never a 5xx.
4. **A module reads other modules only through their services.** Each owning module gets a small read-side service
   (`*.reader.ts`, constructor takes only the `Knex`, so `care-worker` can build it with `new`); `availability` imports no
   foreign repository (CLAUDE.md → "Folder structure and layering").
5. **Generic helpers have one home**: `lib/redis` (`tryRedis`, `prefixRange`), `lib/async` (`single-flight`), `pkg/slots`
   (all slot maths), `pkg/utils` (name normalisation). Services hold Care rules only.

### 1.3 Dependencies
- **Modules (through services):** `doctors` (`DoctorsService`, `DoctorDiscoveryReader`), `schedules` (`SchedulesService`,
  `SlotInputsReader`), `consultations` (`ConsultationRowsService`, `BusyIntervalsReader`), `patients`
  (`PatientsService.findProfile`, rendering timezone), `specialties` (`SpecialtiesService.findByIds`, public specialty refs).
- **Other service:** Identity, only through `lib/identity-client` (`getUsersBatch`, Case 2). No new Identity endpoint or scope.
- **Infrastructure:** Postgres (primary), Redis >= 6.2 (`ZMSCORE`; local and test images are Redis 7), the `care-worker`
  component (gains a Redis connection).

### 1.4 Decisions taken in this spec (beyond the brainstorm resolutions)
| # | Decision | Why |
|---|---|---|
| D1 | Read-side services per owning module (`DoctorDiscoveryReader`, `SlotInputsReader`, `BusyIntervalsReader`) | keeps the cross-module rule and lets the worker build them with `new` (no DI container in `worker.ts`) |
| D2 | The candidate SQL lives in `doctors` and contains one `EXISTS` over `consultation_types` (the only cross-table term) | pushing "at least one active type" into the page query is the only way to keep keyset pages full; parity with `isBookable` is test-enforced (AV-R14) |
| D3 | Write-back to the index and free-map is **version-guarded** (Lua compare on `slots-ver`) | without it, a computation that started before an invalidation could write a stale score after the `ZREM` |
| D4 | `GET /api/doctors/{id}`: `nextAvailableAt` and `nextAvailableSlots` come from the same slot list (cache-first, shortest active type, next 14 days), not from the rank index | exact, shares the `slots:` cache, works with Redis down |
| D5 | `name` works in S2 as headline-only with `meta.degraded:["nameFilter"]`; S3 adds the index | lets S2 merge without S3 and uses the ADR 0025 fallback as the pre-index behaviour |
| D6 | One rate-limit bucket pair **per route** (`doctors-search-*`, `doctors-profile-*`, `doctors-slots-*`) | contract states limits per operation; follows `specialties` |
| D7 | Tie-break `id` in every ordering is `doctor_profiles.id` (the `user_id` is the Redis member) | the partial indexes order by profile id |
| D8 | Interpretation of decision "window filters" for a derived bound: the derived `to` (`from + 14 d`) is clipped to `now + 14 d` before validation; only **supplied** values outside `[now, now + 14 d]` are `400` | otherwise `availableFrom` alone could only ever succeed when it equals `now` |

### 1.5 Glossary
- **Bookable**: Domain rule 6 (`approved` + `synced` + not suspended + accepting + at least one live active type).
- **Shortest active type**: the live active type with the smallest `duration_minutes`, ties lowest id. The index, free-map
  and profile preview are computed on it; the exact per-type answer is `/slots`.
- **Bucket**: 15 minutes, `floor(epochMs / 900000)`. **Free-map**: 173-byte bitmap, layout in 12.2.2.
- **NONE_SCORE** `1e15`: the rank-index score of a doctor known to have no free slot in the next 14 days.
- **Miss**: an index member that is absent or whose score is `<= now`.
- **Window (search)**: `[availableFrom, availableTo)` after defaulting (AV-R16). **Window (slots)**: `[from, to)`.

---

## 2. Database schema

**No table, column, constraint or grant is added.** One migration, in slice S2, adds the partial and composite indexes
whose creation was deferred ([data-model.md](../architecture/data-model.md) lists them, the code does not have them yet).
Every index below is for a query that exists in code (CLAUDE.md → "Database rules").

### 2.1 Migration `20261021120000_add_doctor_discovery_indexes` (S2, raw SQL, real `down`)
```sql
-- Candidate query, sort=price keyset (path A) and every unsorted candidate scan (path B):
--   SELECT dp.id, dp.user_id, dp.consultation_fee, dp.years_experience FROM doctor_profiles dp
--   WHERE <bookable predicate> [AND dp.consultation_fee BETWEEN $min AND $max] [AND (dp.consultation_fee, dp.id) > ($fee, $id)]
--   ORDER BY dp.consultation_fee, dp.id LIMIT $n + 1
--   (path B carries the same ORDER BY since the 2026-10-23 review, so the rows kept past the 10,001 cap are deterministic)
CREATE INDEX idx_doctor_profiles_bookable_fee_id ON doctor_profiles (consultation_fee, id)
    WHERE verification_status = 'approved' AND identity_sync_status = 'synced'
      AND suspended_at IS NULL AND is_accepting_patients AND deleted_at IS NULL;

-- sort=experience keyset (path A): ... ORDER BY dp.years_experience DESC, dp.id DESC
--   AND (dp.years_experience, dp.id) < ($years, $id) LIMIT $n + 1
CREATE INDEX idx_doctor_profiles_bookable_experience_id ON doctor_profiles (years_experience DESC, id DESC)
    WHERE verification_status = 'approved' AND identity_sync_status = 'synced'
      AND suspended_at IS NULL AND is_accepting_patients AND deleted_at IS NULL;

-- Search filter ?language=: EXISTS (SELECT 1 FROM doctor_languages dl WHERE dl.doctor_profile_id = dp.id AND dl.language_code = $1)
CREATE INDEX idx_doctor_languages_language_code_doctor_profile_id ON doctor_languages (language_code, doctor_profile_id);
```
- `down`: `DROP INDEX IF EXISTS` the three, in reverse order.
- **No grants** change (indexes carry none). No data change. Each index is created without `CONCURRENTLY` (the migration runs in a
  transaction with the owner role; the tables are small at launch).
- Already present and reused (no change): `uq_doctor_profiles_user_id`, `idx_doctor_specialties_specialty_id_doctor_profile_id`
  (specialty filter), `uq_specialties_slug` (slug to id), `idx_consultation_types_doctor_profile_id_active` (the `EXISTS` term and the
  shortest-type query), `idx_working_hours_doctor_profile_id`, `uq_schedule_exceptions_doctor_profile_id_date`,
  `idx_consultations_doctor_user_id_starts_at_id` and the GiST index of `excl_consultations_doctor_no_overlap` (busy query),
  `uq_doctor_languages_doctor_profile_id_language_code` and `uq_doctor_specialties_doctor_profile_id_specialty_id` (page view loads).
- The predicate in each partial index is written exactly as the candidate query spells it, so the planner can prove the
  implication; the migration test asserts the three names exist and `\d+` shows the predicate.
- No index for the headline prefix (`starts_with(lower(headline), $p)`): it runs only over the already-filtered bookable set
  (a few thousand rows). No trigram extension is added.
- A new migration test (`tests/integration/migrations.test.ts` extension) runs `latest`, `rollback`, `latest` and asserts the
  three index names and the `vcare_app` grants on the tables are unchanged.

### 2.2 Query-to-index map
| Query (module) | Statement shape | Served by |
|---|---|---|
| Candidates, path B (`doctors`) | bookable predicate + `EXISTS` active type + optional filters, `ORDER BY dp.consultation_fee, dp.id LIMIT 10001` (deterministic when truncated) | partial bookable indexes (either) + `idx_consultation_types_doctor_profile_id_active` per row |
| Page, path A price (`doctors`) | same + `(fee, id) > (...) ORDER BY fee, id LIMIT n+1` | `idx_doctor_profiles_bookable_fee_id` (no Sort node) |
| Page, path A experience (`doctors`) | same + `(years, id) < (...) ORDER BY years DESC, id DESC LIMIT n+1` | `idx_doctor_profiles_bookable_experience_id` (no Sort node) |
| Specialty filter | `ds.specialty_id = (SELECT id FROM specialties WHERE slug = $1)` | `uq_specialties_slug`, `idx_doctor_specialties_specialty_id_doctor_profile_id` |
| Language filter | `EXISTS` on `doctor_languages` | `idx_doctor_languages_language_code_doctor_profile_id` |
| Bookable list for sweep/refresh (`doctors`) | bookable predicate + `EXISTS` active type [+ `user_id = ANY($1)`] `ORDER BY id LIMIT 10001` | `uq_doctor_profiles_user_id` for the `ANY` form; primary key scan with the predicate for the full list |
| Slot inputs (`schedules`) | `working_hours`, `schedule_exceptions`, shortest-active-type, each `doctor_profile_id = ANY($1)` | `idx_working_hours_doctor_profile_id`, `uq_schedule_exceptions_doctor_profile_id_date`, `idx_consultation_types_doctor_profile_id_active` |
| Busy intervals (`consultations`) | `doctor_user_id = ANY($1) AND deleted_at IS NULL AND status IN (busy) AND starts_at >= $from - 240 min AND starts_at < $to AND ends_at > $from` | `idx_consultations_doctor_user_id_starts_at_id` (or the GiST index; `EXPLAIN` evidence in the S1 test) |
| Page view loads (`doctors`, `schedules`, `specialties`) | profiles `user_id = ANY`, languages / links / types `doctor_profile_id = ANY`, specialties `id = ANY` | the unique constraints above, PK |

---

## 3. API contract

All three routes: tag `doctors-discovery`, `security: bearerUser`, **guard `user`**, **roles `patient`, `admin`**,
**ownership `none`** (discovery data is public to those roles; the doctor role is `403` by `authorize`), account state
default (`status=active`; **no email-verified requirement**, that gates booking only), **idempotency: none** (all `GET`),
audit: none (no clinical data). No `Cache-Control` header beyond the application default: these routes are not in
`NO_STORE_PREFIXES` (non-clinical). Every response uses the standard envelope and echoes `X-Request-Id`.

### 3.0 Contract edits (step 0 of each slice; the contract wins, these land in `contracts/openapi.yaml` first)
Each edit is applied by the slice named; the contract test `tests/unit/contract/availability-contract.test.ts` reads them back.

**Slice S1**
- **C1 `getDoctorSlots` description** (replace the paragraph): keep the formula text and append: "A non-bookable doctor, an unknown doctor, and
  a `typeId` that is unknown, inactive, deleted or belongs to another doctor all return `404 NotFound` for every role. `to` must be after
  `from` and at most 14 days after it, else `400 ValidationFailed`. The effective window is clipped to `[now, now + 60 days]`; a window
  entirely in the past or beyond the horizon returns `200` with `data: []` and the clipped `meta.from` / `meta.to`. A slot is listed when its
  start lies in the effective window; a slot's end may fall after `to`. `timezone` is validated as an IANA zone (`400` otherwise)."
- **C2 `SlotWindowMeta.from` / `to`** descriptions: "Effective window start/end after clipping to
  `[now, now + 60 days]`; for a window entirely outside that range both equal the nearest bound and `count` is 0."
- **C3 `SlotTypeId`** description: append "A type that is unknown, inactive, deleted or another doctor's is `404 NotFound`."
- Response set unchanged: `200, 400, 401, 403, 404, 429, 500` (404 already listed).

**Slice S2**
- **C4 `searchDoctors` description** (replace the `sort=earliest_availability ...` sentence, append the rest):
  "`sort=earliest_availability` ranks the whole filtered candidate set from a derived Redis index (never slot computation per row); a schedule
  change is reflected in the order within one 120 s sweep at worst. When Redis is unavailable the response is still `200`: the parts that
  cannot be honoured are ignored and named in `meta.degraded`. Fee filters compare the profile `consultationFee` amount only (currency is
  not compared). `minFee > maxFee` is `400`. A `cursor` issued under another effective sort (including one issued while `meta.degraded`
  contained `sort`) is `400 ValidationFailed`; restart the list without a cursor. Rate limit 60/min per IP and 120/min per user."
- **C5 `searchDoctors` 200 `meta`** becomes:
  ```yaml
  meta:
    allOf:
      - $ref: '#/components/schemas/PaginationMeta'
      - type: object
        properties:
          degraded:
            type: array
            uniqueItems: true
            items:
              type: string
              enum: [sort, availabilityFilter, nameFilter]
            description: >-
              Present only when a requested part could not be honoured. `sort`: earliest availability was served in price order.
              `availabilityFilter`: the `availableFrom`/`availableTo` filter was ignored, or applied only to doctors whose availability was
              known. `nameFilter`: the name filter matched headlines only.
  ```
- **C6 params**: `SearchSort` gets `description: 'earliest_availability: earliest free slot first (ties by id; doctors with no slot in the next 14 days last). price: lowest consultation fee first (ties by id). experience: most years of experience first (ties by id, descending).'`;
  `NameFilter` description (as amended 2026-10-23, slice 3 review; mirrors the contract): "Case-insensitive prefix match on the whole display name
  or on the headline. The name index is rebuilt by the worker about every 5 minutes at sweep granularity from Identity data that is itself cached
  for up to 5 minutes, so a renamed or newly bookable doctor can take up to about 11 minutes to appear under the new name. A missing or expired
  index falls back to the headline only and `meta.degraded` contains `nameFilter`. Control characters are rejected, and at least 2 code points
  must remain after trimming and collapsing whitespace, else `400 ValidationFailed`."; `MinFee` / `MaxFee` append "Compared with the profile
  consultation fee only; currency is ignored."; `AvailableFrom` / `AvailableTo` descriptions replaced by: "Availability window `[availableFrom, availableTo)`,
  applied with every sort. A missing `availableFrom` means now; a missing `availableTo` means `availableFrom + 14 days`, clipped to now + 14 days.
  Supplied values must lie in `[now, now + 14 days]`, `availableTo` after `availableFrom`, at most 14 days apart, else `400 ValidationFailed`.
  Matching is exact to 15 minutes."
- **C7 `DoctorProfile`**: `nextAvailableAt` description "Earliest free slot start of the doctor's shortest active consultation type within the next 14 days;
  null when there is none or it is not yet known. In search it can be up to one sweep (about 2 minutes) old; in the profile it is exact."; `consultationTypes`
  description "Active types only."; `nextAvailableSlots` description "Present only on GET /api/doctors/{doctorUserId}: the first 5 free slots of the
  shortest active type (ties: lowest id) within the next 14 days, rendered in `timezone`; empty for a non-bookable doctor."; `status` description
  "Present only on GET /api/doctors/{doctorUserId} for an admin caller."
- **C8 `getDoctor`**: description appends "Rate limit 60/min per IP and 120/min per user. `timezone` is validated as an IANA zone (`400` otherwise)."; the
  inline `timezone` query parameter gains `maxLength: 64`. A path id that is not a positive integer is `404 NotFound`. Response set unchanged
  (`200, 400, 401, 403, 404, 429, 500`).

**Slice S3**: none. The `NameFilter` wording of C6 is already true in S2 (headline-only plus `meta.degraded:["nameFilter"]`, the documented fallback); S3 only makes the index-backed match available. Slice 3 review (2026-10-23) changed the `NameFilter` wording only (the real staleness bound is about 11 minutes, see above and ADR 0025 "Amendment 2026-10-23").

Contract test assertions (per slice): operation ids, `x-roles: [patient, admin]`, `x-ownership: none`, `bearerUser`, the exact response-code sets, the
`meta.degraded` enum, `maxLength: 64` on both timezone parameters, the `SearchSort` enum and default.

### 3.1 `GET /api/doctors/{doctorUserId}/slots` (S1)
| | |
|---|---|
| operationId | `getDoctorSlots` |
| Guard / roles / ownership | `userGuard` -> `authorize(AVAILABILITY_POLICIES.slots)` -> rate limit; roles `patient`, `admin`; ownership `none`; doctor -> `403 Forbidden` |
| Rate limits | `doctors-slots-ip` 60/min per IP (before `userGuard`), `doctors-slots-user` 120/min per user (after `authorize`) |
| Path | `doctorUserId`: positive integer; anything else `404 NotFound` |
| Query DTO `DoctorSlotsQueryDto` | `typeId` `@ToInt() @IsInt() @Min(1)` required · `from`, `to` `@IsString() @MaxLength(40) @IsIsoDateTimeWithOffset()` required · `timezone` `@IsOptional() @IsIanaTimezone()` (<= 64) · unknown keys rejected (`forbidNonWhitelisted`) |
| 200 | `{ success, data: Slot[], meta: SlotWindowMeta }`, ascending by `startsAt`, bounded, not paginated |
| Errors | 400 `ValidationFailed` (DTO, `to <= from`, span > 14 days, bad timezone) · 401 · 403 · 404 `NotFound` (doctor unknown or not bookable, type unknown/inactive/foreign) · 429 `RateLimited` · 500 |

`Slot` = `{ startsAt, endsAt, startsAtLocal, endsAtLocal, timezone }`: UTC instants as `Date#toISOString()`, local fields via
`toIsoInZone(ms, renderTz)`. `SlotWindowMeta` = `{ from, to, timezone, doctorTimezone, count }`. The rendering zone `renderTz`
is `timezone` (canonicalised) else the caller's patient-profile zone (`PatientsService.findProfile`, patients only) else `UTC`.

**Check order:** path id parse (404) -> DTO validation (400) -> window rules (400) -> doctor + type lookup (404) -> window clip
(empty window -> 200 empty) -> cache read -> compute -> render.

### 3.2 `GET /api/doctors/{doctorUserId}` (S2)
| | |
|---|---|
| operationId | `getDoctor` |
| Guard / roles / ownership | as 3.1; policy `AVAILABILITY_POLICIES.getDoctor` |
| Rate limits | `doctors-profile-ip` 60/min, `doctors-profile-user` 120/min |
| Query DTO `GetDoctorQueryDto` | `timezone` `@IsOptional() @IsIanaTimezone()` (<= 64) |
| 200 | `{ success, data: DoctorProfile }` |
| Errors | 400 · 401 · 403 · 404 (patient: unknown or not bookable; any caller: bad path id) · 429 · 500 |

Viewer-aware DTO (`DiscoveryDoctorResponseDto.from(view, hydrated, preview, viewer)`): the public fields of `DoctorProfile`
(`userId, headline, bio, yearsExperience, languages (sorted), specialties (primary first, then name, then id), consultationFee {amount,currency},
timezone (the doctor's), isAcceptingPatients, consultationTypes (active only)`) + hydrated fields + `nextAvailableAt` + `nextAvailableSlots`
(<= 5, rendered in `renderTz`). **Admin viewers additionally get `status: "bookable" | "not_bookable"`.** No verification state, review note,
suspension, sync status or `defaultSlotMinutes` is ever exposed. A non-bookable doctor (admin only) returns `nextAvailableAt: null` and
`nextAvailableSlots: []` without any slot computation.

### 3.3 `GET /api/doctors` (S2; the `name` filter is index-backed from S3)
| | |
|---|---|
| operationId | `searchDoctors` |
| Guard / roles / ownership | as 3.1; policy `AVAILABILITY_POLICIES.search` |
| Rate limits | `doctors-search-ip` 60/min, `doctors-search-user` 120/min |
| Query DTO `SearchDoctorsQueryDto` (extends `PaginationQueryDto`: `cursor` <= 1024, `limit` 1..100 default 20) | `specialty` `@IsString() @MinLength(1) @MaxLength(100)` · `language` `@Matches(/^[a-z]{2}$/)` · `name` `@IsString() @MinLength(2) @MaxLength(100) @NoControlCharacters("all")` (after trim and whitespace collapse still >= 2 code points, else `400`) · `minFee`, `maxFee` `@ToInt() @IsInt() @Min(0) @Max(2147483647)` · `availableFrom`, `availableTo` `@IsString() @MaxLength(40) @IsIsoDateTimeWithOffset()` · `sort` `@IsIn(["earliest_availability","price","experience"])`, default `earliest_availability` · unknown keys rejected |
| 200 | `{ success, data: DoctorProfile[], meta: { nextCursor, hasMore, count, degraded? } }`, `limit + 1` fetched |
| Errors | 400 `ValidationFailed` (DTO, `minFee > maxFee`, window rules, bad/foreign/mismatched cursor) · 401 · 403 · 429 · 500; never 404, never 5xx for Redis or Identity |

Items are the public `DoctorProfile` **without** `nextAvailableSlots` and without `status`. `nextAvailableAt` is the rank-index score as a UTC
ISO instant, `null` for known-none and unknown. Row order and cursor semantics: AV-R17. After Case 2 hydration, rows whose Identity `status` is
not `active` are dropped from `data` (defence in depth, CLAUDE.md -> Case 1 note); the page may then be shorter than `limit`, `meta.count` is the
returned count and `nextCursor`/`hasMore` are computed from the fetched page before the drop.

---

## 4. Business rules

"Slice" = first slice that implements it. "Enforced by" says where the guarantee lives (DB, service, pure function, guard).

### 4.1 Slots and invalidation (S1)
| # | Rule | Enforced by |
|---|---|---|
| AV-R1 | Slots exist only for a bookable doctor: an unknown or non-bookable doctor, and a `typeId` that is unknown, inactive, deleted or another doctor's, are `404 NotFound` for both roles (decided 2026-10-21; same type check as booking). A bookable doctor means the base predicate (`approved`, `synced`, not suspended, accepting) **and** the requested type being live and active. | `AvailabilityService` using `DoctorDiscoveryReader.findForSlots` + `SchedulesService.findBookableType` |
| AV-R2 | Doctor role on any of the three routes -> `403`; patients and admins must have token `status=active`; no `emailVerified` requirement; a locally suspended doctor needs no check (doctors are not callers). | `authorize(policy)` |
| AV-R3 | Inside the effective window `[from', to')` (AV-R6; `to' <= now + BOOKING_HORIZON_DAYS`), a start `m` is listed **iff booking would accept it**: `m > now`, on the grid of one open interval (`isSlotOnGrid` semantics: the interval holds the whole slot, `(m - intervalStart) % duration == 0`), and `[m, m + duration)` overlaps no busy interval. (A start exactly at `now + horizon` is accepted by booking but lies outside `[from', to')`: listing is stricter by that single instant.) | `pkg/slots` (`computeSlots`) built on `resolveOpenIntervals`; property test (9.1) |
| AV-R4 | Busy = consultations with every status the exclusion constraint `excl_consultations_doctor_no_overlap` holds, i.e. all but `cancelled` and `no_show` (`booked`, `waiting`, `in_progress`, `completed`), and `deleted_at IS NULL`, half-open `[starts_at, ends_at)`. Only `cancelled` and `no_show` release the interval: `complete` does not change `ends_at`, so an early-completed consultation keeps its planned interval busy (decided 2026-10-23, review 20261023-1130; no migration). Busy load window: `starts_at >= from - 240 min` (the longest possible consultation, `chk_consultation_types_duration`) and `starts_at < to` and `ends_at > from`. | `BusyIntervalsReader` SQL |
| AV-R5 | The grid is anchored on the working interval's start and busy intervals never move it. Intervals are per doctor-local date and never merged across dates, so a slot cannot straddle local midnight. DST gap/overlap handling is that of `resolveOpenIntervals`/`localInstant`. | `subtractBusy` keeps `anchorMs`; `sliceSlots` steps from the anchor |
| AV-R6 | Window (slots): `to <= from` -> `400`; `to - from > 14 days` -> `400` (both on the **original** values). The effective window is `from' = min(max(from, now), horizon)`, `to' = min(max(to, from'), horizon)` with `horizon = now + BOOKING_HORIZON_DAYS`; if `from' >= to'` the response is `200`, `data: []`, `meta.from/to = from'/to'`, `count: 0`. | `clipWindow` (pure) + service |
| AV-R7 | `timezone` must be a valid IANA zone <= 64 chars on `/slots` and on `getDoctor` (`400` otherwise). Rendering zone: `timezone` (canonicalised) > the patient's profile zone > `UTC` (admins have no patient profile -> `UTC`). Rendering is applied **after** the cache. | DTO `@IsIanaTimezone`, `canonicalIanaTimezone`, service |
| AV-R8 | Duration comes from the consultation type, never from the client. | service |
| AV-R9 | The slot list is cached as a UTC list per doctor-local date range: key `slots:<doctorUserId>:<ver>:<typeId>:<fromDate>:<toDate>`, `ver` = `slots-ver:<doctorUserId>` (absent = `0`), TTL `SLOT_CACHE_TTL_SECONDS` (default and max 60). Request-specific filtering (`start > now`, `start <= horizon`, `[from', to')`) happens **after** the cache read. The `404` checks run before the cache read, so a cached list is never served for a doctor who stopped being bookable. | `NextAvailableIndex` + service |
| AV-R10 | After commit, every input change runs four operations: bump `slots-ver`, `ZREM` the doctor from the index, delete the free-map, `SADD` the doctor to the refresh set. Sources: working hours / exception / consultation type (`ScheduleChangeListener`), book / reschedule / cancel / complete / no-show (`ConsultationChangeListener`; `complete` does not change the busy set, the bump is harmless), timezone change / accepting toggle / suspension / reinstatement (`DoctorChangeListener`). A listener failure, or Redis down, never fails the write: it is logged and skipped. | `AvailabilityChangeListener`; callers already guard (`notifyChanged`) |
| AV-R11 | `DoctorChangeListener` is fired only by `doctors` (`PATCH /doctors/me` when `timezone` or `isAcceptingPatients` actually changed) and `admin-doctors` (suspend `applied`, reinstate `applied`; no-ops do not fire). It is **not** fired by `verification` or `identity-sync`: a doctor who becomes bookable appears as a miss and is computed on demand, the sweep covers it within about 2 minutes. | `DoctorsService.notifyDoctorChanged` (the one guarded home), call sites |
| AV-R12 | Redis unavailable (down, breaker open, command error) never changes the answer of `/slots`: it is computed from Postgres, version bump / cache write skipped and logged. | `tryRedis` |
| AV-R13 | No audit row, no clinical data, no Identity call on `/slots`. | design |

### 4.2 Search and profile (S2)
| # | Rule | Enforced by |
|---|---|---|
| AV-R14 | The candidate set is exactly Domain rule 6, spelled once in SQL: `verification_status='approved' AND identity_sync_status='synced' AND suspended_at IS NULL AND is_accepting_patients AND deleted_at IS NULL AND EXISTS (live active type)`. A parity test asserts the candidate ids equal the set of profiles for which `isBookable(profile, hasActiveConsultationType)` is true on a mixed fixture. | `DoctorDiscoveryReader` SQL + test |
| AV-R15 | Filters: `specialty` (slug; an unknown slug matches nothing, `200` empty), `language` (code), `minFee`/`maxFee` inclusive on `doctor_profiles.consultation_fee` only (currency ignored; **known limitation**, correct while `ALLOWED_CURRENCIES` has one entry), `name` (AV-R27). `minFee > maxFee` -> `400` with `details[].field = "minFee"`. | SQL + service |
| AV-R16 | Window filter, applied with every sort: `availableFrom` only -> `to = min(from + 14 d, now + 14 d)`; `availableTo` only -> `from = now`; both -> as given. Supplied values must lie in `[now, now + 14 d]`; `to > from`; `to - from <= 14 d`; otherwise `400` (`details[].field` = the offending parameter). A past `availableFrom` is therefore `400` (clients send a value >= their request time). Matching is exact to 15 minutes: a doctor matches when a free slot **start** lies in a bucket overlapping `[from, to)`. | `resolveSearchWindow` (pure, `rules.ts`) |
| AV-R17 | Order and cursor. `earliest_availability`: `(score ASC, profileId ASC)`, known-none and unknown both rank last at `NONE_SCORE`; `price`: `(consultation_fee ASC, id ASC)`; `experience`: `(years_experience DESC, id DESC)`. The cursor is signed (`encodeSignedCursor`, secret `SERVICE_CLIENT_SECRET`) and carries `{k, v, id}` with `k` in `earliest, price, experience, degraded`. The expected `k` for a request is `earliest` (index usable) or `degraded` (earliest sort served in price order) or the sort name; a cursor with another `k` -> `400 ValidationFailed` (`details[0] = {field:"cursor", issue:"does not match the requested sort"}`), a tampered cursor -> the standard `cursor is invalid`. Plain `price`/`experience` without a window filter page with a SQL keyset (path A); every other case pages the in-memory candidate array (path B). With a window filter the order is by the doctor's overall earliest start, not the earliest start inside the window (ADR 0024; known limitation). | `rules.ts` (pure), `discovery-cursor.ts` |
| AV-R18 | Freshness. A rank-index entry is a **miss** if the member is absent or its score is `<= now`. At most `AVAILABILITY_INLINE_MISS_CAP` (default 20) doctors per request are computed inline (ascending profile id), single-flighted per doctor in process, and written back version-guarded; the rest rank last (`nextAvailableAt: null`). Under a window filter a candidate whose free-map is needed but absent is a miss too; beyond the cap it is **excluded** (availability is never claimed without proof) and `meta.degraded` gets `availabilityFilter`. | `DiscoveryService`, `NextAvailableComputer` |
| AV-R19 | The index, the free-map and the profile preview are computed on the doctor's shortest active type (ties lowest id) over `[now + 1 ms, (baseBucket + 1344) * 900000)` (about 14 days). A doctor with no slot in that range is stored with `NONE_SCORE` and an all-zero map. A doctor whose only active type disappeared between the candidate query and the computation is removed from the index (not written). | `NextAvailableComputer`, `pkg/slots` |
| AV-R20 | Redis degradation (ADR 0026), decided per request from `isRedisUsable` and from the first failing Redis command: sort `earliest_availability` -> price order, `degraded` cursor kind, `meta.degraded += sort`, page rows get `nextAvailableAt` computed inline (<= cap, rest `null`); window filter -> ignored, `meta.degraded += availabilityFilter`; `name` -> headline only, `meta.degraded += nameFilter`. `meta.degraded` is absent when empty and ordered `sort, availabilityFilter, nameFilter`. A cursor of kind `earliest` presented while Redis is unusable is `400` (the client restarts the list). Search never returns a 5xx for Redis. | `DiscoveryService`, `tryRedis` |
| AV-R21 | Profile: a patient gets `404` unless the doctor is bookable; an admin sees any live profile and gets `status`. `consultationTypes` lists active types only. `nextAvailableAt` / `nextAvailableSlots` come from the shortest active type's slot list for `[now, now + 14 d)` (cache-first, same code as `/slots`), first 5 slots, rendered in `renderTz`. | `DiscoveryService`, `AvailabilityService.listSlots` |
| AV-R22 | Hydration is Case 2: one batched `hydrateUsersOrEmpty` per page (`getUsersBatch`, <= 100 ids per chunk, `identity:user:<id>` cache); failure -> `displayName:null`, `avatarUrl:null`, `profileHydrated:false`; a hydrated row with Identity `status != 'active'` is dropped from search results. Identity status is never used for authorization and is not exposed. | `DiscoveryService` |
| AV-R23 | Sweep: every `AVAILABILITY_SWEEP_INTERVAL_SECONDS` (120) and once at worker boot, singleton by session advisory lock namespace **1104** (id 0); recomputes every bookable doctor in batches of 100 (4 Postgres queries per batch, the doctor list is read once up front), writes version-guarded, removes index members that are no longer bookable (the stale ids are re-checked against Postgres first, so a doctor who became bookable during a long pass is kept), then writes `next-available:swept-at`. Lock not obtained, Redis unreachable, a batch that could not be written, a truncated doctor list (> 10,000), or aborted -> `"incomplete"` (`--once` exits 1) and `swept-at` is left alone. | `AvailabilitySweepService`, `withSessionAdvisoryLock` |
| AV-R24 | Refresh: every 2 s drains `next-available:refresh` with `SPOP 50` per batch (<= 10 batches per tick), recomputes and writes version-guarded; ids that could not be written are `SADD`ed back; a doctor who is no longer bookable is just dropped. | `AvailabilityRefreshService` |
| AV-R25 | `care-worker` owns its own Redis client (`createRedis(env.REDIS_URL, {name:"care-worker"})`), passed to every loop and to its `IdentityClient`, closed in `closeAll`. Both modes wait at most 3 s for the handshake (`connectWithin`) before the first tick, so the boot-time sweep finds a ready client; when Redis is down the loops still start (daemon) or the tick reports `"incomplete"` (`--once`). `--once availability-refresh` / `--once availability-sweep` work. | `worker.ts`, `worker-loops.ts` |
| AV-R26 | Each route has its own limiter pair: 60/min per IP (before `userGuard`) and 120/min per user (after `authorize`); values and names in 7.3. | `rateLimit` |

### 4.3 Name filter (S3)
| # | Rule | Enforced by |
|---|---|---|
| AV-R27 | `name` matches a doctor when the normalised query is a prefix of the normalised display name (name index) **or** of the lower-cased headline (`starts_with(lower(headline), $p)`), intersected with the candidates. Normalisation `normalizeName` = NFC, trim, collapse whitespace runs to one space, `toLowerCase()`. If the index is missing or expired, or Redis is unusable, only the headline matches and `meta.degraded` has `nameFilter`. (SQL `lower()` follows the database collation: case-insensitivity of non-ASCII headlines is not guaranteed under a `C` collation; names, matched in Node, are.) | `NameIndexReader`, `DoctorDiscoveryReader` SQL |
| AV-R28 | The index is rebuilt by the sweep when `name-index:built-at` is absent or older than `AVAILABILITY_NAME_REFRESH_SECONDS` (300): bookable doctors are hydrated through `lib/identity-client` (cache-first), only Identity-`active` users with a name are indexed, members `<normalised name>\u0000<userId>` with score 0 are written to `name-index:building`, then swapped with `RENAME` (the building key has the live 900 s TTL before the swap, `RENAME` carries it over; `name-index:built-at` is stamped with `EX 900` only after the `RENAME` succeeded). The building key gets its TTL (600 s) with every write chunk and is deleted on any failure, so names never outlive a failed build. If hydration is degraded (any chunk failed) or the swap fails the previous build is kept (no swap, no TTL extension, no stamp). A failed rebuild never fails the rest of the sweep. Env bound (checked at boot): `AVAILABILITY_NAME_REFRESH_SECONDS` + `AVAILABILITY_SWEEP_INTERVAL_SECONDS` + 60 s must be below the 900 s index TTL. **Staleness (as-built, review 2026-10-23):** names come through the `identity:user:*` cache (up to 300 s old) and rebuilds run on sweep ticks, so a renamed or newly bookable doctor can take up to about 11 minutes to appear (a new doctor still matches by headline meanwhile, without `meta.degraded`). | `NameIndexBuilder` |
| AV-R29 | Names exist only in Redis (`identity:user:*`, `name-index`) for at most 15 minutes; they are never written to Postgres, never logged (counts only), and never returned except as the effect of a filter. | design + log test |

---

## 5. Cross-service behavior

| Call | Integration case | Direction | Failure policy |
|---|---|---|---|
| `GET /internal/users?ids=` via `lib/identity-client.getUsersBatch` for each search page and for the profile | **Case 2** (batch hydration) | Care -> Identity | **degrade**: `profileHydrated:false`, never a 5xx; one retry; cached entries served; `identity_hydration_degraded` metric (existing client behaviour) |
| the same call from `care-worker` for the name index (S3) | Case 2 (derived cache, ADR 0025) | Care -> Identity | **degrade**: keep the last build until its 15-minute TTL, then headline-only (`meta.degraded:["nameFilter"]`) |

No Case 1, 3 or 4 call; no new Identity endpoint, scope or token. `/slots` and the index make no Identity call. The
worker's `IdentityClient` is constructed with the worker's Redis client so the `identity:user:*` read-through cache is
active there (today it silently has none).

---

## 6. Error codes

No new error code and no new `errors.ts`. Existing codes (stable, CLAUDE.md -> API conventions):
| Code | HTTP | When on these routes |
|---|---|---|
| `ValidationFailed` | 400 | DTO failure; unknown query key; `to <= from`; slots span > 14 days; bad IANA zone; `minFee > maxFee`; window outside `[now, now + 14 d]` / `to <= from` / span > 14 d; control characters or < 2 code points in `name`; invalid, tampered or mismatched `cursor` |
| `Unauthorized` / `TokenExpired` | 401 | missing, invalid or expired bearer token |
| `Forbidden` | 403 | role is `doctor`; token `status` not `active` |
| `NotFound` | 404 | slots: doctor unknown/non-bookable, type unknown/inactive/foreign; profile: patient and not bookable, unknown id, non-numeric id |
| `RateLimited` | 429 | a limiter tripped |
| `InternalError` | 500 | unhandled (never because of Redis or Identity) |

---

## 7. Security & privacy

### 7.1 RBAC summary
| Route | Patient | Doctor | Admin |
|---|:--:|:--:|:--:|
| `GET /api/doctors` | yes | 403 | yes |
| `GET /api/doctors/{id}` | yes (404 unless bookable) | 403 | yes (any live profile, plus `status`) |
| `GET /api/doctors/{id}/slots` | yes (404 unless bookable) | 403 | yes (404 unless bookable) |

Policies (`policies.ts`, `AvailabilityPolicies`): each route `{ kind: "user", roles: ["patient","admin"], owner: { kind: "none" } }`, no
`accountState` override, no `checks`, no `audit`. `authorize` is on every route (`assertRoutesAuthorized` at boot). The router is mounted
**after** `doctors` and `schedules` in `src/routes.ts` so `/doctors/me*` is matched first; a patient reaching `GET /doctors/me` gets that router's `403`.

### 7.2 Audit and logging
- **Audit events: none.** No clinical data is read; CLAUDE.md -> "Privacy and logging" lists no discovery action. The public DTO omits suspension,
  sync and verification state; only the admin `status` flag carries bookability.
- **Never logged**: display names, avatar URLs, the `name` query value, name-index members, cursors, `Authorization`. Logs and metrics carry counts, durations,
  ids of doctors only where noted (never in search logs), reasons from a fixed set.
- Log events (no PII): `availability_listener_skipped` (warn, throttled once per 60 s: Redis unusable), `availability_cache_unavailable` (warn, throttled),
  `availability_freemap_invalid`, `availability_sweep_done` (`{doctors, batches, durationMs}`), `availability_sweep_skipped` (debug: lock held),
  `availability_refresh_done` (`{doctors}` only when > 0), `availability_name_index_built` (`{members}`), `availability_name_index_stale`, `availability_name_index_failed`,
  `availability_candidates_truncated` (warn).
- Metrics (log-derived, ADR 0007): `availability_index_miss` (value = misses in the request, dims none), `availability_inline_compute_ms`, `availability_degraded`
  (dim `reason` = `sort|availabilityFilter|nameFilter`), `availability_sweep_duration_ms`, `availability_sweep_age_s` (emitted by the refresh loop, at most
  every 30 s), `availability_refresh_queue_depth` (same cadence).

### 7.3 Rate limits (module constants in `constants.ts`, per `specialties`)
`DISCOVERY_IP_LIMIT = 60`, `DISCOVERY_USER_LIMIT = 120`, `DISCOVERY_RATE_WINDOW_MS = 60_000`; limiter names `doctors-search-ip|user`,
`doctors-profile-ip|user`, `doctors-slots-ip|user`. The IP limiter is `byIp` placed before `userGuard`; the user limiter is `byUser` placed after
`authorize` (CLAUDE.md -> Security rules: search and slots 60/min per IP and 120/min per user). Redis down -> the existing per-instance fallback.
No env variable is added for them (the planned `RATE_LIMIT_SEARCH_*` rows of `infrastructure.md` are dropped).

### 7.4 Other
- No files, no upload or download URLs on these routes. The cursor is the existing signed cursor (a position, never a grant).
- `timezone` and `name` are validated before any I/O; the `name` value is only ever bound as a SQL parameter or compared in Node.
- Env additions have no secrets; the cursor secret is the existing `SERVICE_CLIENT_SECRET`.

---

## 8. Performance

Budgets (p95, CLAUDE.md -> Performance rules): search < 400 ms, 14-day slots < 300 ms (busy doctor, 150 consultations, cache hit **and** miss).
Never `SELECT *`; every query backed by an index (2.2); no N+1.

| Path | Postgres | Redis | Identity |
|---|---|---|---|
| `/slots`, cache miss | 5: profile, type, hours, exceptions, busy (+1 patient zone when no `timezone` param, patients only) | `GET slots-ver`, `GET slots:...`, `SET slots:... EX` | none |
| `/slots`, cache hit | 2 (profile, type; +1 zone) | 2 `GET` | none |
| search, path B, steady state | 1 candidate query + 5 page-view queries (profiles, languages, links, specialties by id, active types) | 1 `ZMSCORE` (+ `MGET free-map` chunks only for window-filter candidates whose earliest start is before the window) | 1 batched call, cache-first |
| search, path A | 1 page query + 5 page-view queries | 1 `ZMSCORE` over the page rows | 1 batched call |
| search, misses | + 5 per inline batch (the doctors' timezones via `listBookableForIndex(ids)`, then hours, exceptions, shortest type, busy; run one after the other) | + guarded `EVAL` per computed doctor (one pipeline) | none |
| profile | 5 view queries + 3 (hours, exceptions, busy; type known) on a slot-cache miss (+1 zone) | slot cache ops | 1 batched call |
| sweep, per batch of 100 doctors | 4 (+ 1 doctor-list query per sweep, + 1 stale-member re-check when the index holds members that are no longer in the list) | 1 `MGET slots-ver`, 1 pipeline of `EVAL`s | none |
| refresh, per batch of up to 50 doctors | 5 (`listBookableForIndex(ids)` + the 4 of a batch) | `SPOP`, 1 `MGET`, 1 pipeline of `EVAL`s | none |

- Inline computation, the sweep and the refresh share one code path (`NextAvailableComputer`): loader batch -> `computeSlots`-based `computeDiscoveryEntry` -> guarded write.
- A search never computes slots per row beyond the cap; Redis outage costs at most one cap-sized batch (<= 20 doctors, 5 queries).
- The candidate query returns narrow rows (`id, user_id, fee, years`) and is hard-capped at `CANDIDATE_HARD_CAP = 10_000` rows (`LIMIT 10001`, `availability_candidates_truncated`
  if hit); the revisit triggers (bookable doctors > 6 k, sweep > 60 s, search p95 > 300 ms) are in [capacity.md](../architecture/capacity.md).
- Sweep CPU about 15 to 20 s per cycle at 2.5 k doctors on the 0.5 vCPU worker; worker pool 6 connections, one pinned by the sweep lock.
- **Evidence required before merge** (tests in 9.1 and 9.2): `EXPLAIN` of each candidate/page statement on a seeded 20 k-profile / 2.5 k-bookable table (no `Seq Scan` on
  `doctor_profiles` beyond the bookable subset, no `Sort` node for the keyset paths, the `EXISTS` term on `idx_consultation_types_doctor_profile_id_active`), of the busy statement
  (no `Seq Scan` on `consultations`), and wall-clock p95 over 100 requests for search (2.5 k doctors, three sorts, one filter combination, warm and cold index) and `/slots` (14 days, 150 busy).

---

## 9. Test plan outline

Names `should <behaviour> when <condition>`. Unit tests mock collaborators (readers, Redis, identity client, clock). Integration tests use real Postgres (`btree_gist`),
real Redis, a fake Identity HTTP server (`tests/helpers/fake-identity-server.ts`, including slow/failing modes), `tests/helpers/fake-jwks.ts` tokens, a controllable clock; they never mock services or
repositories. Truncate tables and flush the prefixes `slots:`, `slots-ver:`, `next-available:`, `free-map:`, `name-index`, `rl:`, `identity:user:` per suite (`flushByPrefix` extended).

### 9.1 Slice S1
**Unit (`tests/unit/pkg/slots/`)**
- `subtract-busy.test.ts`: no busy; busy in the middle; touching busy; busy covering the interval; busy starting before and ending inside; unsorted/overlapping busy; anchor preserved; empty days.
- `slice-slots.test.ts`: grid anchored on interval start; resume at next grid point after an off-grid busy end; duration longer than any segment -> none; split shift gap; `[from, to)` bounds with the slot straddling `to` still listed; `start > now` exclusion; dedupe by UTC start.
- `compute-slots.test.ts`: `day_off`, `custom_hours` replaces weekday hours, shift crossing UTC midnight (22:00-24:00 + 00:00-02:00), spring-forward (no start inside the gap, real-minute durations), fall-back (no duplicate UTC starts), `Africa/Cairo` slot rendered on the previous local date for `America/New_York`, half-hour zones (`Asia/Kolkata`, `Australia/Lord_Howe`), `24:00` ends.
- `clip-window.test.ts`: past start clipped to now; beyond horizon clipped; entirely past -> empty with `from'=to'=now`; entirely beyond -> empty at horizon; boundaries.
- **`slot-property.test.ts` (the booking-parity property, AV-R3)**: seeded PRNG (no new dependency), >= 500 generated cases per run across timezones (`UTC, Africa/Cairo, America/New_York, Europe/London, Asia/Kolkata, Australia/Lord_Howe, America/St_Johns`), `now` placed within two days of a DST transition for half of them, split shifts, `24:00` ends, exceptions, busy intervals that are off-grid and cross interval edges, durations `5, 10, 15, 20, 30, 45, 60, 90, 240`. For every case: (a) every listed slot start satisfies the oracle `bookable(m)`; (b) for **every whole minute `m`** in the window, `bookable(m) === listed.has(m)`. Windows are produced by `clipWindow`, so `toMs <= now + horizon`. The oracle composes only production booking pieces: `m > now && fromMs <= m < toMs && isSlotOnGrid(resolveOpenIntervals(...days), m, duration) && no busy overlap`. This is "list every slot and book it, none outside".
- `free-map.test.ts`: layout bytes (version 1, big-endian base bucket, 168 bits MSB first, 173 total); `toFreeMap`/`testFreeMap` round trip against a naive bucket-overlap oracle for random starts and windows; bucket edges (`from` exactly on a boundary, `to` one ms past); window before base / past the 1344th bucket -> false; wrong version or length -> `undefined`.
**Unit (`tests/unit/app/availability/`, `tests/unit/lib/`)**
- `availability.service.test.ts`: 404 matrix (unknown doctor, not bookable, unknown/inactive/foreign/deleted type); 400 window rules; empty effective window -> 200 empty; cache hit skips loader; Redis unusable -> computes; rendering zone precedence; viewer-independent cache payload.
- `availability-change.listener.test.ts`: the four operations in one `MULTI`; Redis down -> resolves, logs once; each of the three ports delegates.
- `next-available.index.test.ts` (slots part): key shapes, `ver` default `0`, TTL arguments, `slots-ver` `EXPIRE`.
- `doctors.service.test.ts` additions: `notifyDoctorChanged` swallows listener errors; `update` fires `timezone_changed` / `accepting_changed` only when the field changed; no event on a no-op patch. `admin-doctors.service.test.ts` additions: fires after the decision commit, not on a no-op.
- `try-redis.test.ts` (`lib/redis`): not usable -> `{ok:false}` without a command; success; failure records the breaker.
- Policies and controller tests per module conventions (`AVAILABILITY_POLICIES.slots` roles/owner; controller validates then delegates).
- `availability-contract.test.ts` (S1 part): `getDoctorSlots` block, roles, ownership, codes, C1 to C3 wording.
**Integration (`tests/integration/availability-slots*.test.ts`)**
- RBAC: patient 200, admin 200, doctor 403, unauthenticated 401, expired token 401, non-active patient 403; bookable-doctor matrix 404 (suspended, not accepting, unapproved, `sync pending`, no active type) for **both** roles; foreign type 404.
- Contract conformance: status, error codes and the shapes of `Slot` and `SlotWindowMeta` against the contract helper.
- Computation: DST day in `Africa/Cairo`/`America/New_York`; cross-midnight rendering; a booked slot disappears, cancel/reschedule/no-show reappear, a `completed` consultation with a future `ends_at` keeps its interval busy (no listed start is refused by booking); exception and hours change visible within the TTL and **immediately** through the listener; type duration change.
- **Book-every-listed-slot**: for a small fixture doctor, book (via `POST /consultations`) a sample of listed slots -> all `201`; for unlisted minutes (off-grid, outside hours, over a busy interval, past, beyond horizon) -> `422`/`409`.
- Invalidation: each source (hours, exception, type, book, reschedule, cancel, complete, no-show, timezone change, accepting toggle, suspend, reinstate) bumps `slots-ver` and removes the index member; a failing listener never fails the write; Redis down (`createUnreachableRedis`) -> write succeeds, `/slots` still `200` from Postgres.
- Cache: second identical request is a hit (assert via spy on loader); key contains `ver`; a change makes the next request a miss; TTL <= 60 s.
- `EXPLAIN` (`availability-slots-explain.test.ts`): busy statement on 50 k consultations / 200 doctors uses an index, no `Seq Scan` on `consultations`; slot inputs statements index-backed.
- **Budget**: 14-day window, busy doctor with 150 consultations, p95 < 300 ms for cache miss and hit (100 runs, warm-up excluded).
- Logs: captured logs contain no clinical fixture strings; request bodies/queries not logged.

### 9.2 Slice S2
**Unit**
- `rules.test.ts` (pure): `resolveSearchWindow` (every default and every 400, D8 clip, boundaries at exactly `now`, `now + 14 d`, span 14 d), effective-kind selection, cursor encode/decode/mismatch/tamper, in-memory ordering + keyset skip for the three sorts including ties, unknown/none ranking, window matching by bucket math with the `sB < fromB` shortcut equal to map-only evaluation.
- `next-available.computer.test.ts`: shortest type selection (ties lowest id); known-none sentinel; doctor without active type removed; version-guard rejects a write after a concurrent `INCR`; single-flight collapses concurrent computations for one doctor; cap of 20.
- `discovery.service.test.ts`: path A/B selection; Redis down per AV-R20 (each `degraded` combination and order); `earliest` cursor with Redis down -> 400; miss accounting and metrics; hydration failure -> `profileHydrated:false`, rows kept; non-active Identity status dropped; admin `status`; patient 404; no names logged.
- `availability-refresh.service.test.ts` / `availability-sweep.service.test.ts`: batch of 100 -> 4 reader calls; stale members removed; `swept-at` written only on a full pass; lock not obtained -> `"incomplete"`; abort between batches -> `"incomplete"`; Redis failure -> `"incomplete"`; failed batch re-`SADD`s ids; queue-depth/age metric throttle.
- Loop builders: names `availability-refresh` / `availability-sweep`, intervals 2000 ms / `AVAILABILITY_SWEEP_INTERVAL_SECONDS * 1000`.
- `env.test.ts` additions: defaults, `SLOT_CACHE_TTL_SECONDS` max 60, `AVAILABILITY_INLINE_MISS_CAP` bounds, `NEXT_AVAILABLE_CACHE_TTL_SECONDS` no longer accepted/needed.
- `single-flight.test.ts` (`lib/async`), worker wiring test (redis in `WorkerLoopDeps`, `closeAll` closes it, `--once` with both new names).
- `availability-contract.test.ts` (S2 part): `searchDoctors` and `getDoctor` blocks, `meta.degraded` enum, `maxLength: 64`, wording C4 to C8.
**Integration (`tests/integration/availability-search*.test.ts`)**
- RBAC per route (doctor 403, patient/admin 200, 401), admin sees non-bookable profile with `status:"not_bookable"` and patient 404.
- Candidate parity (AV-R14) with `isBookable`; every filter alone and combined (specialty, language, fee range, unknown slug -> empty); `minFee > maxFee` 400.
- **Pagination page 2 on each sort** (earliest, price, experience), with ties, with a window filter, with `limit` boundaries; `hasMore` exact; cursor tamper / wrong sort / cursor from degraded mode -> 400.
- Window filter exact to 15 minutes including a DST day, a doctor free today and tomorrow, cross-midnight (doctor 22:00-24:00), `availableTo`-only, `availableFrom`-only, every 400.
- Freshness: lost invalidation repaired by one sweep (`--once availability-sweep` or direct tick); change removes member immediately; refresh drains the set; inline miss cap (25 cold doctors -> 20 computed, others last); version guard (compute started before an invalidation does not write).
- **Degradation**: Redis down -> `200`, `meta.degraded:["sort"]`, price order, `nextAvailableAt` computed for <= 20 rows; Redis down + window -> `availabilityFilter`; worker down (empty index) -> `200`, unknowns last, cap respected; Identity down -> `200` with `profileHydrated:false` (Case 2), never 5xx; Identity slow (> 2 s) -> same.
- Worker: `node dist/worker.js --once availability-refresh|availability-sweep` exit 0 (and 1 for lock held / Redis down); sweep singleton under two concurrent ticks; `worker_started` lists both loops; shutdown closes the worker Redis client.
- `EXPLAIN` (`availability-search-explain.test.ts`): path A price and experience use their partial index with no Sort node; unfiltered candidate scan on a 20 k-profile table stays within the bookable subset; language/specialty filters use their indexes; `EXPLAIN` evidence is written to the test output.
- Migration test: three index names exist, `down` removes them.
- **Budget**: search p95 < 400 ms at 2.5 k bookable doctors for each sort, warm index and one cold-index run (cap applied); logs contain no display names or avatar URLs.
- Listener fan-in: a `PATCH /doctors/me` timezone change and an admin suspend/reinstate remove the doctor from the index.

### 9.3 Slice S3
**Unit**: `normalizeName` (NFC, whitespace, case, Arabic text unchanged); `prefixRange` (`[p`, `[p\u{10FFFF}`, UTF-8 ordering against Arabic and CJK members); `NameIndexBuilder` (only active users with names, degraded hydration keeps previous build, empty set deletes the key, building key TTL, swap atomicity via `MULTI`); `NameIndexReader` (limit 5000, member parsing, missing key -> unavailable); sweep due-logic from `name-index:built-at`; `DiscoveryService` name paths (union with headline, intersection with candidates, fallback flag).
**Integration**: `name` prefix on display name (index) and on headline; case-insensitive; rename visible after the next rebuild (fake Identity changes the name); Identity down -> last build served until its TTL, then headline-only with `meta.degraded:["nameFilter"]`; Redis down -> same fallback; index key and `identity:user:*` reuse (assert Identity call count per rebuild); **no names or avatar URLs in captured logs**; name in Postgres never (scan every text column of every table for the fixture names after a run).

### 9.4 Rule-to-test index
Every rule AV-R1..AV-R29 has at least one named test above; the mapping is kept as a comment header in each test file (`AV-Rn`).

---

## 10. Out of scope
Booking, reschedule, cancel (built); doctor-initiated follow-up booking; ratings and reviews; geo or "near me" search; free-text search over bio; word-internal name matching;
per-type availability in search (the index uses the shortest active type; `/slots` is exact per type); a Postgres table of derived values; read replicas (the reads may move to
`DATABASE_READ_URL` later); the Phase-2 booking agent's tools; currency-aware fee filtering; `help-articles`; any hub deployment, capacity or ownership change (already rolled up);
`Cache-Control: no-store` (non-clinical routes); a real email, video or storage change.

---

## 11. Open questions

None. The contract edits are decided and specified in 3.0 (applied at step 0 of each slice); no Identity contract change; **Platform changes required (/system-design): none** (the hub
already lists `availability-refresh`/`availability-sweep`, the worker's own Redis and the name-index Identity load; Redis >= 6.2 is met by the local and test images, Redis 7).

Doc updates owed by `/update-docs`: **slices 1 and 2 done** (2026-10-21 and 2026-10-23): `CLAUDE.md` (status line and module list, the `slots:` key gains `<ver>`),
`docs/architecture/{availability,scheduling-slots,api,overview,infrastructure,data-model,deployment,resilience,capacity}.md`, `docs/runbook.md` (`AvailabilitySweepStale`, `AvailabilityDegradedHigh`,
`--once availability-*`), `.claude/skills/timezone-slot-computation/SKILL.md`, `docs/service-card.md` (see 13.4), `docs/INDEX.md`, `.env.example`. **Left for slice 3:** the name-index parts of the same files
(`name-index` rows and the S3 wording in `availability.md`, `data-model.md` is unaffected, the `AVAILABILITY_NAME_REFRESH_SECONDS` variable is already declared), the CLAUDE.md status wording "name index not built".

---

## 12. Component design by slice

### 12.1 Slice S1 — Slots, listeners, `DoctorChangeListener`

#### 12.1.1 New and changed files
| File | Change |
|---|---|
| `src/pkg/slots/types.ts` | add `SlotRange`, `FreeSegment`, `StartBounds`, `ComputeSlotsInput`, `ClippedWindow` |
| `src/pkg/slots/busy.ts` | `subtractBusy` |
| `src/pkg/slots/slice.ts` | `sliceSlots`, `firstFreeStart` |
| `src/pkg/slots/compute.ts` | `computeSlots` |
| `src/pkg/slots/window.ts` | `clipWindow` |
| `src/lib/redis/try-redis.ts` | `tryRedis` |
| `src/lib/config/env.ts`, `types` | `SLOT_CACHE_TTL_SECONDS` |
| `src/app/schedules/service/slot-inputs.reader.ts` + `repository/slot-inputs.repo.ts` | batch hours / exceptions / shortest active type |
| `src/app/consultations/service/busy-intervals.reader.ts` + `repository/busy-intervals.repo.ts` | batch busy intervals |
| `src/app/doctors/service/doctor-discovery.reader.ts` + `repository/doctor-discovery.repo.ts` | `findForSlots` (S1); candidate / list / view queries (S2) |
| `src/app/doctors/{types,enums}.ts`, `service/noop-doctor-change-listener.ts` | `DoctorChangeListener` port, `DoctorChangeKind`, no-op default |
| `src/app/doctors/service/doctors.service.ts` | `notifyDoctorChanged`; `update` fires events (`applyChanges` reports the changed fields) |
| `src/app/admin-doctors/service/admin-doctors.service.ts` | inject `DoctorsService`; call `notifyDoctorChanged` after the suspend / reinstate decision commit |
| `src/app/availability/...` | module files below |
| `src/lib/di/tokens.ts`, `src/bootstrap.ts`, `src/routes.ts` | tokens, registrations, mount |

New DI tokens: `DoctorChangeListener, DoctorDiscoveryReader, SlotInputsReader, BusyIntervalsReader, SlotInputsLoader, NextAvailableIndex, AvailabilityChangeListener, AvailabilityService, AvailabilityController`.

Module skeleton `src/app/availability/`: `constants.ts`, `enums.ts` (string enums `DegradedPart` and `SearchSortKind`, S2), `types.ts`, `policies.ts`, `routes.ts`,
`controller/availability.controller.ts`, `dto/availability.request.dto.ts`, `dto/availability.response.dto.ts`, `service/{availability.service,slot-inputs.loader,next-available.index,availability-change.listener}.ts`.
No `entity/` (no table) and no `errors.ts` (no new code).

#### 12.1.2 `pkg/slots` additions (pure: no clock, no I/O, no env; luxon only inside `resolveOpenIntervals`)
```ts
export interface SlotRange { startMs: number; endMs: number }                       // half-open [startMs, endMs)
export interface FreeSegment { anchorMs: number; startMs: number; endMs: number }   // piece of an open interval left after busy; anchor = the open interval's start
export interface StartBounds { fromMs: number; toMs: number }                        // a slot is kept when fromMs <= start < toMs
export interface ClippedWindow { fromMs: number; toMs: number; empty: boolean }
export interface ComputeSlotsInput { timezone: string; weekly: readonly WeeklyHoursRule[]; exceptions: readonly ExceptionRule[];
                                     busy: readonly UtcInterval[]; durationMinutes: number; bounds: StartBounds }

export function subtractBusy(days: readonly OpenDay[], busy: readonly UtcInterval[]): FreeSegment[];
export function sliceSlots(segments: readonly FreeSegment[], durationMinutes: number, bounds: StartBounds): SlotRange[];
export function firstFreeStart(segments: readonly FreeSegment[], durationMinutes: number, bounds: StartBounds): number | null;
export function computeSlots(input: ComputeSlotsInput): SlotRange[];
export function clipWindow(fromMs: number, toMs: number, nowMs: number, horizonMs: number): ClippedWindow;
```
- `subtractBusy`: merge busy (`mergeUtcIntervals`); flatten all `days[].intervals` sorted by `startMs`; one linear sweep with a monotonic busy pointer; each output piece keeps the **original** interval's `startMs` as `anchorMs`. Drops empty pieces. Input arrays are not mutated.
- `sliceSlots`: for each segment, first grid index `k = max(0, ceil((max(seg.startMs, bounds.fromMs) - anchor) / step))`, `step = durationMinutes * 60000`; emit `[anchor + k*step, +step)` while `start + step <= seg.endMs` and `start < bounds.toMs`; sort by start and drop equal starts. `RangeError` for a non-integer or < 1 duration.
- `firstFreeStart` = `sliceSlots(...)[0]?.startMs ?? null` implemented with early exit (same result, tested equal).
- `computeSlots`: resolves open days for `[localDateOf(bounds.fromMs) - 1, localDateOf(bounds.toMs - 1) + 1]` (the same margin as booking, `OPEN_DAYS_MARGIN`), `subtractBusy`, `sliceSlots`. Callers build `bounds` from the clipped window: `fromMs = max(from', now + 1)` (strict `start > now`, booking's `BookingInPast`) and `toMs = to'` (exclusive, `<= now + horizon`). A start exactly at `now + horizon`, which booking would accept, is therefore not listed: listing is stricter by that single instant (AV-R3).
- `clipWindow(fromMs, toMs, nowMs, horizonMs)`: `from' = min(max(fromMs, nowMs), horizonMs)`, `to' = min(max(toMs, from'), horizonMs)`, `empty = from' >= to'`; `horizonMs = now + BOOKING_HORIZON_DAYS * 86400000`.
- `computeSlots` for the slot cache uses whole doctor-local dates: `bounds.fromMs = localInstant(fromDate, 0, tz, "start")`, `bounds.toMs = localInstant(addDays(toDate, 1), 0, tz, "start")`.

#### 12.1.3 Readers and loader
- `SlotInputsReader` (`schedules`; `constructor(db: Knex)`; `@injectable()` with `@inject(TOKENS.Db)`), methods taking a `conn: Knex = this.db`. The batch form is S2, the single-doctor form is S1:
  `loadSlotInputs(profileIds: readonly number[], fromDate, toDate, conn?) -> Map<profileId, { weekly: WeeklyHoursRule[]; exceptions: ExceptionRule[]; shortestType: {id:number; durationMinutes:number} | null }>`: **3 statements** (`working_hours ... = ANY`, `schedule_exceptions ... = ANY AND date BETWEEN`, shortest active type via
  `SELECT DISTINCT ON (doctor_profile_id) id, doctor_profile_id, duration_minutes FROM consultation_types WHERE doctor_profile_id = ANY($1) AND is_active AND deleted_at IS NULL ORDER BY doctor_profile_id, duration_minutes, id`);
  rows map through the existing `toWeeklyRules` / `toExceptionRules`. `loadHoursAndExceptions(profileId, fromDate, toDate, conn?)` is the single-doctor form for `/slots` (2 statements; the type is already known).
- `BusyIntervalsReader` (`consultations`; `constructor(db)`): `listBusy(doctorUserIds, fromMs, toMs, conn?) -> Map<userId, UtcInterval[]>`: one statement (AV-R4), rows ordered `(doctor_user_id, starts_at)`.
- `DoctorDiscoveryReader` (`doctors`; `constructor(db)`): S1 `findForSlots(userId, conn?) -> { profileId, userId, timezone, bookableBase } | undefined` (live profile; `bookableBase` = approved && synced && not suspended && accepting).
- `SlotInputsLoader` (`availability`; `constructor(doctors, schedules, busy)` taking the three readers): `loadForSlots(doctor, type, window) -> DoctorSlotInputs` (2 + 1 statements) and (S2) `loadShortestType(doctors: IndexDoctor[], window) -> Map<userId, DoctorSlotInputs>` (3 + 1 statements per call; callers chunk at <= 100). `DoctorSlotInputs = { timezone, weekly, exceptions, busy, durationMinutes, typeId }`. The exceptions date range of a batch is `[utcDate(from) - 2, utcDate(to) + 2]` (doctors differ by at most one day from UTC).

#### 12.1.4 `NextAvailableIndex` (the one place that touches the module's Redis keys) — S1 part
`@injectable()`, `constructor(@inject(TOKENS.Redis) redis, @inject(TOKENS.Logger) logger, @inject(TOKENS.Env) env)`. Every command goes through `tryRedis` (usable check + breaker accounting + swallow); a failed or skipped command yields `{ ok: false }` and the caller degrades.

| Operation | Exact commands | TTL | On failure |
|---|---|---|---|
| read version | `GET slots-ver:<id>` (absent = `"0"`) | none | treat as unusable cache: compute, skip write |
| read slot list | `GET slots:<id>:<ver>:<typeId>:<fromDate>:<toDate>` (JSON `[[startMs,endMs],...]`) | | miss |
| write slot list | `SET slots:<id>:<ver>:<typeId>:<fromDate>:<toDate> <json> EX <SLOT_CACHE_TTL_SECONDS>` | <= 60 s | skipped, logged (throttled) |
| invalidate (one `MULTI`) | `INCR slots-ver:<id>`; `EXPIRE slots-ver:<id> 604800`; `ZREM next-available:index <id>`; `DEL free-map:<id>`; `SADD next-available:refresh <id>` | version key 7 days | log `availability_listener_skipped`, return normally |

Version keys never get `DEL`/prefix scans; the 7-day expiry is safe because slot entries live <= 60 s. A malformed cached JSON is a miss.

Generic helper (`lib/redis/try-redis.ts`, the one home of "fail-soft Redis command", unit-tested): 
```ts
export type RedisOutcome<T> = { ok: true; value: T } | { ok: false };
export function tryRedis<T>(client: Redis, command: () => Promise<T>): Promise<RedisOutcome<T>>;
// !isRedisUsable(client) -> { ok: false } without sending; otherwise withRedis(client, command) (breaker accounting); a rejection -> { ok: false }
```

#### 12.1.5 `AvailabilityService.getSlots` / `listSlots`
`getSlots(actor, doctorUserId, query)`: AV-R6 window checks (400) -> `DoctorDiscoveryReader.findForSlots` (undefined -> `NotFound`) -> `SchedulesService.findBookableType(profileId, typeId)` (undefined -> `NotFound`) -> `bookableBase` false -> `NotFound` -> zone resolution (`query.timezone` canonical, else `PatientsService.findProfile(actor.userId)?.timezone` for patients, else `UTC`) -> `clipWindow` -> empty -> 200 empty -> `listSlots` -> filter `start > now && fromMs' <= start < toMs'` -> render.
`listSlots(doctor, type, fromDate, toDate)` (shared with the profile): `ver` -> cache read -> on miss `SlotInputsLoader.loadForSlots` + `computeSlots` over whole local dates -> cache write. Returns `SlotRange[]` (UTC). Time comes from `TOKENS.Clock`.

#### 12.1.6 Listeners and wiring
- `AvailabilityChangeListener implements ScheduleChangeListener, ConsultationChangeListener, DoctorChangeListener`: three methods, each `await this.index.invalidate(event.doctorUserId)`; never throws.
- `bootstrap.ts`: `registerSingleton(TOKENS.NextAvailableIndex, NextAvailableIndex)` and `registerSingleton(TOKENS.AvailabilityChangeListener, AvailabilityChangeListener)` **before** `NotificationsService`/`SchedulesService` registrations; `container.register(TOKENS.ScheduleChangeListener, { useToken: TOKENS.AvailabilityChangeListener })`, same for `ConsultationChangeListener` and the new `DoctorChangeListener`. The three `Noop*` classes stay exported (unit tests bind them).
- `DoctorsService.notifyDoctorChanged(kind, doctorUserId)`: calls the port, catches, logs `doctor_change_listener_failed {requestId, kind}` (no data), never throws. `DoctorChangeKind = timezone_changed | accepting_changed | suspended | reinstated` (string enum in `doctors/enums.ts`).
- Routes (S1 state): `router.get("/doctors/:doctorUserId/slots", rateLimit(doctors-slots-ip, byIp), userGuard(), authorize(p.slots), rateLimit(doctors-slots-user, byUser), controller.slots)`; `buildAvailabilityRouter()` is mounted in `src/routes.ts` right after `buildAdminDoctorsRouter()` and returned through `sealRouter`.

### 12.2 Slice S2 — Index, free-map, loops, search, profile, degradation

#### 12.2.1 Env, constants, worker wiring
- `env.ts`: `SLOT_CACHE_TTL_SECONDS` (int 1..60, default 60; added in S1), `AVAILABILITY_SWEEP_INTERVAL_SECONDS` (`positiveSeconds`, default 120), `AVAILABILITY_NAME_REFRESH_SECONDS` (`positiveSeconds`, default 300; declared in S2 so the env surface is complete, used from S3), `AVAILABILITY_INLINE_MISS_CAP` (int 0..100, default 20). No defaults on secrets.
- `constants.ts`: `NONE_SCORE = 1e15`, `LOOKAHEAD_DAYS = 14`, `SWEEP_LOCK_NAMESPACE = 1104`, `SWEEP_LOCK_ID = 0`, `REFRESH_LOOP_NAME = "availability-refresh"`, `SWEEP_LOOP_NAME = "availability-sweep"`, `REFRESH_INTERVAL_MS = 2000`, `REFRESH_BATCH = 50`, `REFRESH_MAX_BATCHES_PER_TICK = 10`, `SWEEP_BATCH = 100`, `FREE_MAP_TTL_SECONDS = 600`, `PREVIEW_SLOT_COUNT = 5`, `SLOTS_MAX_SPAN_DAYS = 14`, rate-limit constants (7.3), metric and log names. `CANDIDATE_HARD_CAP = 10_000` lives in `doctors/constants.ts` (the `doctors` repository applies it; `availability` does not import a foreign constant).
- `WorkerLoopDeps` gains `redis: Redis`. `worker.ts`: `const redis = createRedis(env.REDIS_URL, { name: "care-worker" })`; in both modes the connection is awaited for at most 3 s through `connectWithin(redis, 3_000)` (`lib/redis/redis.ts`) before the first tick (the daemon logs `redis_unavailable` and starts its loops anyway; `--once` runs its tick, which reports `"incomplete"` without Redis); `new IdentityClient({ env, redis })`; `closeAll` also `await closeRedis(redis)`. `buildWorkerLoops` constructs the readers with `deps.db`, `NextAvailableIndex`, `SlotInputsLoader`, `NextAvailableComputer`, `AvailabilityRefreshService`, `AvailabilitySweepService` and returns the two new loops (appended to the list). `docker-compose.yml` already gives `care-worker` `REDIS_URL`.

#### 12.2.2 Free-map and rank-index values
- **Free-map (173 bytes):** byte 0 = version `1`; bytes 1-4 = big-endian `uint32` base bucket = `floor(computationInstantMs / 900000)`; bytes 5-172 = 168 bytes of bits, MSB first: bit `i` (byte `5 + (i >> 3)`, mask `0x80 >> (i & 7)`) is set when 15-minute bucket `base + i` contains a free slot start; 1344 buckets = 14 days. `FREE_MAP_BYTES = 173`, `FREE_MAP_BUCKETS = 1344`, `FREE_MAP_BUCKET_MS = 900_000`, `FREE_MAP_VERSION = 1`.
- `toFreeMap(startsMs, baseBucket) -> Uint8Array` (starts outside `[base, base + 1344)` ignored); `testFreeMap(map, fromMs, toMs) -> boolean | undefined`: `fromB = floor(fromMs / B)`, `toB = floor((toMs - 1) / B)`, clamp to `[base, base + 1343]`, true if any bit set in range; `undefined` when length != 173 or version != 1 (the caller treats it as absent and logs `availability_freemap_invalid`). `baseBucketOf(nowMs) = floor(nowMs / 900000)`.
- Computation window of an index entry: `fromMs = nowMs + 1`, `toMs = (baseBucket + 1344) * 900000`; score = first start or `NONE_SCORE`.
- **Window-match shortcut** (pure, in `rules.ts`, equal to map-only evaluation by construction): with `sB = floor(score / B)`: `sB > toB` -> no match, no map read; `fromB <= sB <= toB` -> match, no map read; `sB < fromB` -> read the map; `score = NONE_SCORE` -> no match.

#### 12.2.3 `NextAvailableIndex` — S2 additions
| Operation | Exact commands | Notes |
|---|---|---|
| scores | `ZMSCORE next-available:index <userId>...` (one call; <= 10 000 args) | absent -> `null` -> miss; Redis error -> degrade (AV-R20) |
| maps | `MGETBUFFER free-map:<id>...` in chunks of 500 | `null` -> miss; invalid layout -> miss + log |
| version snapshot | `MGET slots-ver:<id>...` before loading inputs (absent -> `"0"`) | worker and API use the same read |
| **guarded write** | `EVAL` (registered with `defineCommand("writeNextAvailable", { numberOfKeys: 3 })`): keys `slots-ver:<id>`, `next-available:index`, `free-map:<id>`; args `expectedVer, userId, score, mapBytes, ttl`. Lua: `local v = redis.call('GET', KEYS[1]); if not v then v = '0' end; if v ~= ARGV[1] then return 0 end; redis.call('ZADD', KEYS[2], ARGV[3], ARGV[2]); redis.call('SET', KEYS[3], ARGV[4], 'EX', ARGV[5]); return 1` | batches go in one pipeline; `0` = a concurrent invalidation won, the entry is discarded and the doctor is in the refresh set already |
| remove | `ZREM next-available:index <ids>` | sweep: members not in the bookable set |
| members | `ZRANGE next-available:index 0 -1` | sweep only |
| refresh set | `SPOP next-available:refresh 50`, `SCARD next-available:refresh`, `SADD next-available:refresh <ids>` | lost on Redis loss; the sweep covers it |
| sweep stamp | `SET next-available:swept-at <epochMs>`; read with `GET` | no TTL (alerting reads its age) |

No `SCAN`, no `KEYS`. `ZSET` members are decimal user ids; scores are epoch ms (exact doubles) or `1e15`.

#### 12.2.4 `NextAvailableComputer` (shared by API inline path, refresh, sweep)
`compute(doctors: readonly IndexDoctor[], nowMs) -> Promise<ComputedEntry[]>`:
`IndexDoctor = { profileId, userId, timezone }`, `ComputedEntry = { userId, score, map, ver }`. Steps: snapshot versions (`MGET`) -> `SlotInputsLoader.loadShortestType` -> per doctor `computeSlots`-based entry (no type -> `removed`) -> returns entries; `write(entries)` pipelines the guarded `EVAL`s. Single-flight: an in-process `Map<userId, Promise<ComputedEntry>>` (`lib/async/single-flight.ts`: `createSingleFlight<K, V>(): { run(key: K, start: () => Promise<V>): Promise<V> }`, the entry is removed when the promise settles); a batch registers one promise per doctor derived from the batch promise, doctors already in flight are awaited instead of recomputed. Inline path: choose <= cap misses by ascending profile id, load their `IndexDoctor` rows with `listBookableForIndex(userIds)` (1 query, which also re-proves they are still bookable), then `refresh` (= `compute` + `write`; 4 more queries), metric `availability_inline_compute_ms`, count into `availability_index_miss`. So an inline batch costs 5 Postgres queries (spec 8).

#### 12.2.5 Candidate and page SQL (`doctor-discovery.repo.ts`; the only statements with the `consultation_types` term)
```sql
-- bookable base (inlined constants, spelled exactly like the partial indexes)
FROM doctor_profiles dp
WHERE dp.verification_status = 'approved' AND dp.identity_sync_status = 'synced' AND dp.suspended_at IS NULL
  AND dp.is_accepting_patients AND dp.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM consultation_types ct WHERE ct.doctor_profile_id = dp.id AND ct.is_active AND ct.deleted_at IS NULL)
-- optional, bound parameters only:
  AND dp.consultation_fee >= $minFee AND dp.consultation_fee <= $maxFee
  AND EXISTS (SELECT 1 FROM doctor_specialties ds WHERE ds.doctor_profile_id = dp.id AND ds.specialty_id = (SELECT s.id FROM specialties s WHERE s.slug = $slug))
  AND EXISTS (SELECT 1 FROM doctor_languages dl WHERE dl.doctor_profile_id = dp.id AND dl.language_code = $language)
  AND (starts_with(lower(dp.headline), $namePrefix) OR dp.user_id = ANY($nameMatchedUserIds))   -- name filter (S2: headline term only)
```
Shapes: `listCandidates(filters)` -> `SELECT dp.id, dp.user_id, dp.consultation_fee, dp.years_experience ... ORDER BY dp.consultation_fee, dp.id LIMIT 10001`; `pageCandidates(filters, kind, after, fetch)` -> `ORDER BY dp.consultation_fee, dp.id` with `(dp.consultation_fee, dp.id) > ($v, $id)` or `ORDER BY dp.years_experience DESC, dp.id DESC` with `(dp.years_experience, dp.id) < ($v, $id)`, `LIMIT $fetch`; `listBookableForIndex(userIds?)` -> `SELECT dp.id, dp.user_id, dp.timezone ... ORDER BY dp.id LIMIT 10001` [`AND dp.user_id = ANY($1)`]. Rows are exported query builders (`...Query`) so `EXPLAIN` tests inspect exactly what runs (repo convention).
Page views: `DoctorsService.findPublicViews(userIds)` = profile rows (`user_id = ANY`), languages, links, `SpecialtiesService.findByIds`, `SchedulesService.listActiveTypesFor(profileIds)` (new batched read on `schedules`, uses `idx_consultation_types_doctor_profile_id_active`) assembled into `PublicDoctorView { profile, languages, specialties, activeTypes, bookable }`.

#### 12.2.6 `DiscoveryService`
`search(query)` (no actor: discovery data is the same for patient and admin, the policy already filtered the role): (1) validate cross-field rules (`minFee`/`maxFee`, `resolveSearchWindow`) -> (2) mode: `usable = isRedisUsable(redis)`, effective cursor kind, decode + compare cursor -> (3) name ids (S2: none) -> (4) path A or B (AV-R17) -> (5) page rows -> `findPublicViews` -> `nextAvailableAt` (scores already in hand for path B; `ZMSCORE` for path A page rows; inline for misses within the cap) -> (6) `hydrateUsersOrEmpty` once -> drop non-active -> (7) DTOs + `meta` (`degraded` ordered, absent when empty) + metrics. Any `tryRedis` failure in step 4 switches the remainder of the request to the degraded plan (cursor rule AV-R20).
`getDoctor(actor, doctorUserId, query)`: `findPublicViews([id])` -> viewer rule (AV-R21) -> if bookable: `AvailabilityService.listSlots(shortest active type, [now, now + 14 d))`, first 5, `nextAvailableAt` = first start -> hydrate -> DTO.
Pure helpers (`rules.ts`, unit-tested without I/O): `resolveSearchWindow`, `effectiveKind`, `orderCandidates`, `applyCursor`, `matchesWindow`.

#### 12.2.7 Worker loops
**`availability-refresh`** — `intervalMs 2000`, no lock (SPOP is atomic). Tick: if Redis unusable -> return; up to `REFRESH_MAX_BATCHES_PER_TICK` times: `SPOP next-available:refresh 50`; empty -> stop; `listBookableForIndex(ids)`; `compute` (4 queries) + guarded `write`; on error `SADD` the popped ids back and rethrow (the runner logs `worker_tick_failed`); log `availability_refresh_done {doctors}`. Every >= 30 s also emit `availability_refresh_queue_depth` (`SCARD`) and `availability_sweep_age_s` (now - `swept-at`, omitted when absent).
**`availability-sweep`** — `intervalMs AVAILABILITY_SWEEP_INTERVAL_SECONDS * 1000`; the runner runs the first tick at boot. Tick body inside `withSessionAdvisoryLock(db, 1104, 0, ...)`; returns `"incomplete"` when the lock is not obtained (`ran ?? "incomplete"`, like `upload-intent-purge`):
1. Redis usable? else `"incomplete"`. 2. `listBookableForIndex()` (1 query). 3. For each batch of 100 (abort check between batches): `compute` (4 queries) + guarded `write`. 4. `ZRANGE` members, `ZREM` those not in the bookable set. 5. `SET next-available:swept-at`. 6. (S3) name-index step. 7. metrics `availability_sweep_duration_ms`, log `availability_sweep_done`. Aborted or any Redis failure -> `"incomplete"` and `swept-at` is not written.
`--once availability-refresh` runs one tick (up to 10 batches); `--once availability-sweep` runs one full sweep (and, in S3, the name rebuild if due or `built-at` absent); exit 1 on `"incomplete"`.

### 12.3 Slice S3 — Name index and name filter
- `pkg/utils/name.ts`: `normalizeName(value: string): string`. `lib/redis/lex.ts`: `prefixRange(prefix) -> [min, max] = ["[" + prefix, "[" + prefix + "\u{10FFFF}"]` (bytes compare; U+10FFFF encodes as `F4 8F BF BF`, above every valid lead byte).
- `NextAvailableIndex` additions: `readNameMatches(prefix) -> number[] | undefined` (`EXISTS name-index`; false -> `undefined`; else `ZRANGEBYLEX name-index <min> <max> LIMIT 0 5001`, user id = text after the last `\u0000`; **known limitation (as-built):** at most `NAME_MATCH_LIMIT` = 5000 matches are used, in name order; the 5001st member only detects the cut and is logged count-only as `availability_name_index_truncated {limit}`, `meta.degraded` is not changed. Unreachable at the planned 2.5 k doctors; reachable only above the 6 k revisit trigger, see `docs/architecture/capacity.md`); `replaceNameIndex(members)` (`DEL name-index:building`; per chunk of 500 one `MULTI` of `ZADD name-index:building 0 <m> ...` + `EXPIRE name-index:building 600`, any failure -> `DEL name-index:building`; then `EXPIRE name-index:building 900` (0 = key vanished -> false), a plain `RENAME name-index:building name-index`, and only after it succeeded `SET name-index:built-at <epochMs> EX 900`); empty member list -> `MULTI DEL name-index`, `SET name-index:built-at`; `readNameBuiltAt()`.
- `NameIndexBuilder(identity: IdentityClient, index, logger, now)`: `rebuild(doctors) ` -> `identity.getUsersBatch(userIds, randomUUID())` (100 per chunk, `identity:user:*` cache-first); `degraded` -> keep the last build, log `availability_name_index_stale`; else members for users with `status === 'active'`, swap. `AvailabilitySweepService` calls it when `built-at` is absent or older than `AVAILABILITY_NAME_REFRESH_SECONDS`; any error is caught, logged `availability_name_index_failed`, and does not affect the rest of the tick.
- `DiscoveryService`: with `name`, `index.readNameMatches(normalizeName(name))`; `undefined` (missing/expired/Redis unusable) -> headline-only and `meta.degraded += nameFilter`; otherwise pass the user ids as `$nameMatchedUserIds` next to the headline term. The `meta.degraded` flag is **set whenever the filter fell back**, never set otherwise.

---

## 13. Tasks and exit gates by slice

Tasks follow CLAUDE.md -> "Build order for a new module" (step number in brackets). A task is `[x]` only with typecheck and tests green. Each slice is a branch/PR that can merge alone.

### 13.1 Slice S1 — Slots and listeners
Tasks
- [x] S1-01 [0] Apply contract edits C1 to C3 (3.0) and write `availability-contract.test.ts` (S1 part).
- [x] S1-02 [2] `env.ts` + `Env` type: `SLOT_CACHE_TTL_SECONDS`; `availability` constants, enums, types; `DoctorChangeKind` + port types in `doctors`.
- [x] S1-03 [pkg] `pkg/slots` additions (12.1.2) with the unit tests of 9.1 including the property test.
- [x] S1-04 [lib] `lib/redis/try-redis.ts` + tests.
- [x] S1-05 [6] Readers and repos: `SlotInputsReader`, `BusyIntervalsReader`, `DoctorDiscoveryReader.findForSlots`; register tokens; EXPLAIN test for the busy statement.
- [x] S1-06 [7] `NextAvailableIndex` (slots part), `SlotInputsLoader`, `AvailabilityService`, `AvailabilityChangeListener`; `DoctorsService.notifyDoctorChanged` and the call sites in `doctors` / `admin-doctors`; `bootstrap.ts` rebinding.
- [x] S1-07 [4,5] `DoctorSlotsQueryDto`, slot response DTOs (`SlotResponseDto`, `SlotWindowMetaDto`).
- [x] S1-08 [8] `policies.ts` (`slots`).
- [x] S1-09 [9,10,11] controller, `routes.ts` (limiters named in 7.3), mount in `src/routes.ts`.
- [x] S1-10 [12] Integration, RBAC, contract, invalidation, cache, book-every-listed-slot, budget tests (9.1).
- [x] S1-11 [13] `/manual-qa availability` slots section (`scripts/curl-test-availability.sh`).
- [x] S1-12 [14] Docs: `docs/availability/tasks.md`, INDEX, as-built notes in this spec.
Exit gate: `npm run typecheck`, `npm run lint` (restricted-imports), `npm test`, `npm run test:integration` green; the S1 contract test passes against the edited contract; the property test, the cache/invalidation tests, the book-every-listed-slot test, the `EXPLAIN` test and the 14-day budget test (< 300 ms p95, hit and miss) pass; Redis-down `/slots` returns 200; RBAC matrix complete (doctor 403, patient/admin 200, non-bookable 404 for both); no existing suite changed behaviour (the three `Noop*` listeners still satisfy their old tests).

### 13.2 Slice S2 — Search, profile, loops, degradation
Tasks
- [x] S2-01 [0] Contract edits C4 to C8; contract test S2 part.
- [x] S2-02 [1] Migration `20261021120000_add_doctor_discovery_indexes` (+ migration test); `EXPLAIN` fixtures.
- [x] S2-03 [2] Env vars `AVAILABILITY_*`; constants; `DegradedPart`; types; remove `NEXT_AVAILABLE_CACHE_TTL_SECONDS` from the plan.
- [x] S2-04 [pkg/lib] `pkg/slots` free-map functions; `lib/async/single-flight.ts`; tests.
- [x] S2-05 [6] `doctor-discovery.repo.ts` (candidates, page, bookable list, view loads), `SchedulesService.listActiveTypesFor` + `SlotInputsReader.loadSlotInputs`, `DoctorsService.findPublicViews`; parity test with `isBookable`.
- [x] S2-06 [7] `NextAvailableIndex` (index part), `NextAvailableComputer`, `rules.ts` + `discovery-cursor.ts`, `DiscoveryService`, `AvailabilityRefreshService`, `AvailabilitySweepService`.
- [x] S2-07 [4,5] `SearchDoctorsQueryDto`, `GetDoctorQueryDto`, `DiscoveryDoctorResponseDto` (viewer-aware), `PaginationMeta` + `degraded`.
- [x] S2-08 [8,9,10,11] policies (`search`, `getDoctor`), controller methods, routes with limiters.
- [x] S2-09 [worker] `WorkerLoopDeps.redis`, `worker.ts` Redis lifecycle, `worker-loops.ts` registration, `--once` for both loops.
- [x] S2-10 [12] Unit + integration + RBAC + contract + degradation + pagination + freshness + worker + EXPLAIN + budget tests (9.2).
- [x] S2-11 [13] `/manual-qa availability` search/profile sections incl. Redis stop/start, worker stop, fake Identity down.
- [x] S2-12 [14] Docs, runbook alerts, as-built notes.
Exit gate: all of S1's gate plus: contract test S2 part; the three migration indexes exist and the `EXPLAIN` evidence shows partial-index keyset scans with no Sort node and no `Seq Scan` beyond the bookable subset; search p95 < 400 ms at 2.5 k doctors for each sort (warm and one cold run); pagination page 2 passes on all three sorts; Redis-down, worker-down and Identity-down tests return 200 with the documented `meta.degraded` / `profileHydrated:false`; `--once availability-refresh|availability-sweep` exit 0; the sweep singleton test passes with two concurrent ticks; `name` works headline-only with `meta.degraded:["nameFilter"]`; logs contain no names.

### 13.3 Slice S3 — Name filter
Tasks
- [ ] S3-01 [pkg/lib] `normalizeName`, `prefixRange`; tests.
- [ ] S3-02 [7] `NextAvailableIndex` name operations, `NameIndexBuilder`, sweep step, `DiscoveryService` name path.
- [ ] S3-03 [12] Unit + integration tests of 9.3 (rename, Identity down TTL expiry, Redis down, no names logged or stored).
- [ ] S3-04 [13/14] Manual QA of the name filter; docs; rolls up the Identity call figure (already in capacity.md).
Exit gate: S2's gate stays green; prefix on display name and headline works case-insensitively; the stale-until-TTL and headline-only fallbacks are covered; a full-database scan finds no fixture display name; captured logs contain no names.

### 13.4 Service card
`docs/service-card.md` **is affected** after the build (update in `/update-docs`, then the hub re-sync via `../vcare-hub/scripts/sync-from-spoke.sh`): status text (availability built, per slice), endpoints (the three routes become live), runtime (`care-worker` loops `availability-refresh`, `availability-sweep`; the worker now holds a Redis connection), owned data (derived Redis keys), dependencies unchanged (Identity Case 2 already listed).

## 14. As-built notes

- Slice 1 includes the pure `toFreeMap`, `testFreeMap` and `baseBucketOf` functions. They have no Redis caller until slice 2; this follows the explicit slice 1 build instruction and leaves rank-index and free-map persistence for slice 2.
- Slice 1 writes `next-available:refresh` (a Redis set of doctor user ids) and runs `ZREM next-available:index` / `DEL free-map:<id>` on every input change. This is specified behaviour (AV-R10, 12.1.4: the listener's four operations are one `MULTI`), not slice-2 leakage. Until the slice-2 refresh loop exists nothing consumes the set, and the index and free-map keys are never written, so the `ZREM`/`DEL` are no-ops. The set holds at most one member per doctor (bounded by the doctor count, ids only, no PII) and is deliberately left ungated so slice 2 can drain it without a backfill. Integration suites that assert "no clinical data in Redis" therefore allow the derived prefixes `slots-ver:`, `slots:`, `next-available:` and `free-map:` (`DERIVED_AVAILABILITY_PREFIXES` in `tests/helpers/redis.ts`).
- The busy-interval EXPLAIN fixture uses the existing doctor relationship index chosen by Postgres for its data distribution. The query remains index-backed and has no sequential scan on `consultations`.
- `AvailabilityChangeListener` (`src/app/availability/service/availability-change.listener.ts`) wraps `NextAvailableIndex.invalidate` in its own `try`/`catch` and swallows an unexpected rejection, in addition to the index's own fail-soft contract (12.1.4: `invalidate` runs through `tryRedis` and logs `availability_listener_skipped`, so it already never throws). The extra guard is defence in depth, found by a unit test that makes the index reject: a cache-maintenance failure must never change the outcome of a committed domain write (AV-R10). The three listener methods (`onScheduleChanged`, `onConsultationChanged`, `onDoctorChanged`) share one private `invalidate`. The callers keep their own guards and log lines (`schedule_change_listener_failed`, `consultation_change_listener_failed`, `doctor_change_listener_failed`), so nothing is logged by the listener itself on this path.
- The opt-in benchmark config `jest.bench.config.js` (`npm run test:bench`) now also runs the integration global setup (`tests/integration/global-setup.ts`) and `tests/setup.ts` (`setupFilesAfterEnv`), so the HTTP benchmark `tests/bench/availability-slots-http.bench.test.ts` runs against the real wiring with real Postgres and real Redis (prerequisite: the test infra from `npm run test:infra:up`). Before, the config ran the pure benchmarks only. The pure benchmark `tests/bench/availability-slots.bench.test.ts` is unchanged in kind.
- Measured budgets (2026-10-21, local dev machine, a doctor with 150 busy consultations, a 14-day window, p95 of 100 measured in-process supertest requests after 10 warm-up requests, budget < 300 ms): HTTP cache miss about 19 ms, HTTP cache hit about 11 ms, pure `computeSlots` about 4 ms. Both HTTP cases assert `< 300` in the benchmark. These numbers are well below the budget and are indicative only (one machine, no concurrent load); the benchmark is the repeatable check.
- Slice 1 environment surface: only `SLOT_CACHE_TTL_SECONDS` (integer 1..60, default 60) is added; it is declared in `src/lib/config/env.ts` and `src/lib/config/types.ts`. No migration, no worker change, no new contract operation. Contract check (2026-10-21): `getDoctorSlots` in `contracts/openapi.yaml` (C1 to C3 applied) matches the controller, request DTO (`typeId`, `from`, `to`, `timezone`; `timezone` `maxLength: 64`), response DTOs (`Slot`, `SlotWindowMeta`), policy (roles `patient`, `admin`; ownership none), limiter pair and response-code set `200, 400, 401, 403, 404, 429, 500`; no drift.

### Slice 2 as-built notes (2026-10-23, spec version 0.2.0)

Slice 2 is built on branch `feature/availability-slice2` (search, profile, rank index, free-map, refresh and sweep loops, worker Redis, migration `20261021120000`). Contract check: `searchDoctors` and `getDoctor` in `contracts/openapi.yaml` (C4 to C8 applied, plus the review-time `MinFee`/`MaxFee` `maximum: 2147483647` and `SpecialtyFilter` `minLength: 1`) match the as-built controller, request DTOs, response DTOs, policies, limiter pairs and response-code sets (`200, 400, 401, 403, 404, 429, 500`); no drift. Deviations from the plan above, all intentional:

1. **Name filter uses a local `resolveNamePrefix` (`src/app/availability/rules.ts`)** until slice 3 provides the shared `normalizeName` (`pkg/utils/name.ts`, 12.3). Same normalisation (NFC, trim, collapse whitespace, lower-case) and the same `>= 2` code-point rule (`400` with `details[].field = "name"`), applied to the headline term only. A request with `name` always reports `meta.degraded: ["nameFilter"]` in S2 (`DiscoveryService.nameDegradation`); slice 3 replaces `resolveNamePrefix` with `normalizeName` and makes the flag conditional (AV-R27).
2. **`CANDIDATE_HARD_CAP = 10_000` lives in `src/app/doctors/constants.ts`**, not in `availability/constants.ts`: the cap is applied inside the `doctors` repository, and `availability` would otherwise import a foreign module's constant (or duplicate it). `listCandidates` carries `ORDER BY dp.consultation_fee, dp.id` so the rows kept past the cap are deterministic (review 20261023-1130); a truncated sweep list makes the sweep `"incomplete"`.
3. **Batch loads run sequentially, not in `Promise.all`** (`SlotInputsReader.loadSlotInputs`: hours, then exceptions, then shortest types; `SlotInputsLoader.loadShortestType`: schedule inputs, then busy). One batch holds one pool connection at a time: the worker pool is 6 and the sweep pins one with its advisory lock, so parallel statements would starve the other loops. The statement count is unchanged. (`loadForSlots` for a single `/slots` request keeps its two-way `Promise.all`.)
4. **The inline path costs 5 Postgres queries per batch, not 4** (sections 8 and 12.2.4 updated). The inline computation first loads the `IndexDoctor` rows of the chosen misses with `listBookableForIndex(userIds)` (`id, user_id, timezone`, which also re-proves bookability), then runs the 4-statement `NextAvailableComputer.refresh`. `availability-refresh` pays the same 5 per batch of up to 50 popped ids. The sweep lists all bookable doctors once and then pays 4 per batch of 100 (plus one re-check query for stale members, see 8).
5. **A mid-request index failure reruns the whole request on the degraded plan** (`selectIndexed` returns `undefined` when the `ZMSCORE` or the free-map read fails, and `search` then calls `selectDegraded`; a failed write-back is ignored and the computed value is still used). Consequence beyond AV-R20: a client that sent a cursor of kind `earliest` and hit such a failure gets `400 ValidationFailed` (`details[0].field = "cursor"`), exactly as when Redis is unusable at the start; restarting the list without a cursor works. Price and experience cursors survive the switch (their kind does not change).
6. **The "span more than 14 days" `400` of AV-R16 is unreachable over HTTP.** Both supplied bounds must already lie in `[now, now + 14 d]`, and a missing bound is derived inside that range, so the span can never exceed 14 days. The rule stays in `resolveSearchWindow` as a guard and its exactly-14-day boundary is unit-tested; the contract wording ("at most 14 days apart") remains true.
7. **`DiscoveryService.search(query)` takes no actor**; `getDoctor(actor, id, query)` does (viewer-aware `status`, patient `404`). The policy already restricts the role and the item DTO is identical for patient and admin.
8. **Two helpers beyond the plan, both in `lib/`:** `lib/async/yield-to-event-loop.ts` (the computer yields to the event loop every 10 doctors so a 100-doctor batch does not hold the event loop for its whole duration) and `connectWithin(client, timeoutMs, onFailure?)` in `lib/redis/redis.ts` (bounded Redis handshake used by `worker.ts` in both modes, see AV-R25). Both are generic and unit-tested.
9. **AV-R4 now counts `completed` as busy** (it mirrors the exclusion constraint; review 20261023-1130, fixed on this branch). Spec 4.1, 9.1 and `architecture/scheduling-slots.md` already say so; the busy statement, the free-map, the index and the profile preview all use it.
10. **Sweep hardening from the review:** stale index members are re-checked against Postgres before `ZREM`, and the worker waits for its Redis connection before the first (boot) tick (AV-R23, AV-R25 above).

Measured (2026-10-23, local dev machine, real Postgres and Redis, in-process supertest, 2,500 bookable doctors among 20,000 profiles, 100 measured requests after 10 warm-up, budget 400 ms; `npm run test:bench`, `tests/bench/availability-search-http.bench.test.ts`):

| Measure | Result |
|---|---|
| Search p95, warm index, every sort | 12 to 48 ms |
| Search p95, cold index (inline cap of 20 applies) | 68 to 97 ms |
| Search p95, Redis down | about 64 ms (one run) |
| `/slots` p95 at the same scale, miss / hit | 14 ms / 7 ms (budget 300 ms) |
| One full `availability-sweep` of 2,500 doctors (`--once`) | 6.4 to 6.7 s on the dev machine (unconstrained CPU; the 0.5 vCPU planning figure in [capacity.md](../architecture/capacity.md) stays the conservative derivation) |

`EXPLAIN` findings (`tests/integration/availability-search-explain.test.ts`, 20,000 profiles of which 2,500 bookable). Path A price and experience pages use their partial index with no `Sort` node; the language and specialty filters use their indexes; the busy statement has no `Seq Scan` on `consultations`. Two planner choices differ from section 8 and are **accepted** (scans stay inside the bookable subset, no defect): (a) the **unfiltered path B candidate scan** plans as a hash semi join that hashes the active-type set with a `Seq Scan` on `consultation_types` (about 13 ms for 2,500 candidates) instead of probing `idx_consultation_types_doctor_profile_id_active` per candidate; every keyset page and every selective filter does use the index; (b) the **specialty slug lookup** reads the 10-row `specialties` table directly instead of `uq_specialties_slug`. The sweep list (`ORDER BY id`) sorts a bitmap scan of the bookable partial index.

Test caveat: the graceful SIGTERM case of `tests/integration/availability-worker.test.ts` is skipped on win32 (like `process.test.ts`) and runs on CI; the worker's client-observation logic was exercised here with `SIGKILL`.
