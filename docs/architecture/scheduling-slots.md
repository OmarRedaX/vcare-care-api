---
title: Scheduling and Slot Computation
owner: care-team
service: care-service
status: draft
diataxis: explanation
last_verified: 2026-10-23
tags: [scheduling, slots, timezones, booking, caching, performance]
related: [consultations-spec, schedules-spec, data-model, consultation-lifecycle, resilience, capacity, availability, adr-0002-slots-never-stored, adr-0003-db-exclusion-constraint, adr-0010-next-available-lazy-cache-worker-refresh, adr-0024-next-available-rank-index-free-map-and-sweep]
---

# Scheduling and Slot Computation

Full algorithm, edge cases, and test list: the **`timezone-slot-computation`** skill
(`.claude/skills/timezone-slot-computation/SKILL.md`). This page is the architectural summary.

## The formula
```
slots = slice( WorkingHours − ScheduleExceptions − busy Consultations , by ConsultationType.duration )
        evaluated in the DOCTOR's timezone · stored/returned in UTC · rendered in the VIEWER's timezone
```
Slots are **never stored** ([ADR 0002](../adr/0002-slots-never-stored.md)). Only the inputs are: `working_hours`,
`schedule_exceptions`, `consultation_types`, `consultations`, and `doctor_profiles.timezone`.

## Inputs and where they are interpreted
| Input | Storage | Interpreted in |
|---|---|---|
| Weekly hours (split shifts = several rows per weekday) | `TIME` start/end, ISO weekday | doctor tz, per local date |
| Exceptions: `day_off` removes the date; `custom_hours` **replaces** that date's hours | `DATE` + optional `TIME`s | doctor tz |
| Duration | `consultation_types.duration_minutes` | — |
| Busy intervals | consultations with every status but `cancelled` and `no_show` (`booked`, `waiting`, `in_progress`, `completed`; mirrors `excl_consultations_doctor_no_overlap`), not deleted | UTC instants, half-open `[start, end)` |

`cancelled` and `no_show` release their interval — exactly the set the exclusion constraint ignores. A `completed` consultation keeps its planned `ends_at` (`complete` never shortens it), so it stays busy and a listed slot is never refused by booking (availability review 2026-10-23).

## Algorithm (pure, `pkg/slots`, `now` passed in)
1. **Clip** the window to `[max(from, now), min(to, now + 60 days)]` (`BOOKING_HORIZON_DAYS`).
2. **Enumerate doctor-local dates** from one day before to one day after the clipped window, so shifts that
   cross UTC midnight are not lost.
3. **Open intervals per date**: exception rules, else the weekday's shifts; merge overlaps.
4. **Convert to UTC** with luxon in the doctor's zone. DST gap: never emit a slot starting inside the gap.
   DST overlap: earlier offset for starts, later offset for ends; dedupe by UTC instant.
5. **Subtract busy** intervals with one linear sweep.
6. **Slice** on a grid anchored at the working interval's start, stepping by the type duration; after a busy
   interval ending off-grid, resume at the next grid point.
7. **Dedupe, sort, render**: `startsAt`/`endsAt` UTC plus `startsAtLocal`/`endsAtLocal` and `timezone` for the viewer.

A doctor in `Africa/Cairo` working Monday 09:00 shows that slot to a patient in `America/New_York` on Monday
02:00 — and a 23:30 Cairo slot appears on the previous local date for that patient. Grouping by day happens in the
viewer's timezone.

## Timezone rules
- Rules (working hours, exceptions, "for that date") are evaluated in `doctor_profiles.timezone`.
- Everything persisted is UTC (`TIMESTAMPTZ`); the wire carries ISO-8601 with offset.
- Rendering uses the `timezone` query parameter, else the patient's profile timezone, else UTC. Consultations
  render in `patient_timezone` for the patient and the doctor's timezone for the doctor.
- No `Date` arithmetic for schedules; luxon only. Timezones are validated with `IANAZone.isValidZone`, memoized per name (valid names only) in `pkg/slots/local-date.ts`.

## As built: `pkg/slots` after `schedules` (2026-10-09)
The `schedules` module ships only the **open-interval resolution** part of the algorithm (steps 2-4 above) in `src/pkg/slots`
(pure; imports only `luxon` and `pkg/utils`; no clock, no I/O). It does **not** subtract busy consultations or slice by duration:
both stay with `availability` (steps 1, 5-7) and `consultations` (booking re-validation). **Update 2026-10-21:** `availability` slice 1 added those steps to `pkg/slots` as pure functions: `clipWindow`, `subtractBusy`, `sliceSlots`, `firstFreeStart`, `computeSlots` (plus `toFreeMap`, `testFreeMap`, `baseBucketOf`, consumed by the rank index since slice 2, 2026-10-23). The slot list reuses the booking grid rules, and a property test books every listed slot. See [availability spec](../availability/spec.md) 12.1.2 and section 14.

| Function | Role |
|---|---|
| `resolveOpenIntervals({ timezone, weekly, exceptions, fromDate, toDate })` | one `OpenDay { date, intervals: UtcInterval[] }` per doctor-local date in `[fromDate, toDate]`; `day_off` empties the date, `custom_hours` replaces the weekday's hours, otherwise the merged weekly intervals; `RangeError` for an invalid zone, a reversed range, more than 400 dates, duplicate exception dates or a bad interval |
| `localInstant(date, minute, timezone, edge)` | UTC instant of a doctor-local wall time; DST gap maps to the transition instant at both edges, overlap maps to the earlier instant for `start` and the later for `end`; `minute = 1440` is the next local midnight |
| `mergeLocalIntervals` / `mergeUtcIntervals` | sort, merge overlapping and touching intervals, drop empty ones; cross-date merging is the caller's choice |
| `parseTimeOfDay` / `formatTimeOfDay` / `addDays` / `localDateOf` / `isoWeekday` / `isCalendarDate` | wall-clock and calendar helpers on `YYYY-MM-DD` strings and minutes since midnight (luxon; no `Date` arithmetic) |

Two in-process ports, both with no-op defaults registered in `bootstrap.ts`, are the seams for the next modules:
- `ScheduleImpactProvider` (`findAffected`, `flagAffected`; inside the write's transaction): **bound by `consultations` since 2026-10-12** (the no-op default remains for tests). `findAffected` reads the future `booked`/`waiting`/`in_progress` rows of the doctor (narrowed to the changed UTC window for an exception change), resolves the **new** open intervals through the write's transaction (`SchedulesService.resolveOpenDays`, 3 queries) and returns the ids whose interval is not contained in one open interval (`isCoveredByOpenIntervals`; the slot grid is deliberately not re-checked, so a shifted shift anchor does not flag every booking). `flagAffected` flags only rows not already flagged `schedule_blocked` and enqueues one `schedule_blocked` outbox row per newly flagged patient, so a patient is notified once; the `409` body still lists already-flagged ids.
- `ScheduleChangeListener` (after commit; a failure is logged and never fails the write): `availability` binds it to bump `slots-ver`, remove the doctor from the rank index and enqueue the refresh ([ADR 0024](../adr/0024-next-available-rank-index-free-map-and-sweep.md), superseding ADR 0010). The default does nothing.

A third port, `ScheduleOwnerResolver`, only breaks the `doctors` / `schedules` construction cycle.

**Resolved performance finding (2026-10-09).** `resolveOpenIntervals` (14 days x 3 shifts x 7 weekdays) took about 11 to 13 ms because `IANAZone.isValidZone` rebuilt an `Intl.DateTimeFormat` on every `assertValidZone` call. Validated zone names are now memoized in a pure module-level `Set` (successes only), `localInstant` skips the candidate re-check when there is no transition within a day, and the local midnight is computed arithmetically. Measured 3.4 to 4.3 ms in jest on the dev machine (isolated; up to 6 to 8 ms under full parallel suite load, hence the separate benchmark). The 5 ms budget is unchanged and is verified by `npm run test:bench` (opt-in, run alone: 3.07 to 3.30 ms best of 100); `npm test` keeps only deterministic guards (constant zone-validation count, < 50 ms regression guard).

## As built: booking re-validation (consultations, 2026-10-12)
Implemented by `ConsultationsService` ([spec](../consultations/spec.md) sections 3.6-3.7) with pure code in `pkg/slots/slot-fit.ts`; the order below supersedes the table that follows where they differ.
- Order inside the transaction: idempotency replay lookup → `SELECT … FOR SHARE` on the live doctor profile (`DoctorsService.lockBookingTarget`; suspension and schedule writes take `FOR UPDATE`, so a booking and a suspension serialize) → bookable → type (404 when absent or inactive) → past → horizon → grid → insert → outbox → audit. Everything the checks read is read **after** the lock. Patient email verification is a policy check (`authorize`), before the service.
- `isSlotOnGrid(days, startMs, durationMinutes)`: some single open interval has `start <= startMs`, `startMs + duration <= end`, and `(startMs - intervalStart) % duration === 0`. The grid is anchored on the working interval's start and busy consultations do **not** move it, so "resume at the next grid point" is the next point of the same grid; overlap is the exclusion constraint's job. Intervals are per doctor-local date and are **not merged across dates** (a slot cannot straddle local midnight). The future `availability` module must use these same functions so the slot list and the booking check cannot disagree.
- Days are resolved for `[localDate - 1, localDate + 1]` (`resolveOpenDays`: two queries, hours and exceptions in range, then `resolveOpenIntervals`); the timezone is the doctor's.
- Reschedule re-validates the same way using the **stored** interval length (a later type edit never changes an existing row) and the same lock order (profile, then consultation).
- `toIsoInZone(ms, timezone)` in `pkg/utils/time.ts` renders `startsAtLocal`/`endsAtLocal` (ISO with offset in the viewer zone).
- Cache invalidation after commit goes through the `ConsultationChangeListener` seam, bound since 2026-10-21 (`availability` slice 1) to `AvailabilityChangeListener`; the no-op default remains for tests.

## Booking re-validation
The slot list shows what *looked* free. `POST /api/consultations` re-proves it in one transaction:

| Step | Check | Failure |
|---|---|---|
| 1 | idempotency: `(patient_user_id, idempotency_key)` exists → replay (same body hash) | 422 `IdempotencyConflict` |
| 2 | doctor bookable (approved, synced, not suspended, accepting, active type) | 409 `DoctorNotBookable` |
| 3 | patient `emailVerified` (token) | 403 `EmailNotVerified` |
| 4 | type belongs to doctor and is active; `ends_at = starts_at + duration` | 404 / 400 |
| 5 | `starts_at > now`; `starts_at ≤ now + 60 d` | 422 `BookingInPast` / `BeyondBookingHorizon` |
| 6 | interval inside the doctor's open intervals for that doctor-local date, on the grid | 422 `OutsideWorkingHours` |
| 7 | `INSERT` → SQLSTATE `23P01` | 409 `SlotUnavailable` |
| 8 | after commit: invalidate caches, enqueue notification (async) | never fails the booking |

Steps 4–6 reuse the same pure functions as the slot endpoint. Concurrency is resolved by the exclusion
constraint ([ADR 0003](../adr/0003-db-exclusion-constraint.md)), not by locking a slot row — there is none.
**Reschedule** runs the same checks for the new start and updates the same row, releasing the old interval
atomically; patients additionally must be outside the policy window of the **current** start.

## Query plan (fixed count, independent of window size)
1. doctor profile by user id (timezone, bookability) — `uq_doctor_profiles_user_id`
2. working hours — `idx_working_hours_doctor_profile_id`
3. exceptions in `[fromDate − 1, toDate + 1]` — `uq_schedule_exceptions_doctor_profile_id_date`
4. consultation type — PK, scoped to the profile
5. busy consultations overlapping the UTC window — the GiST index of `excl_consultations_doctor_no_overlap`

Then in-memory computation, O(days × intervals + busy). Always the primary for booking re-validation; slot
reads may use a replica when one is introduced.

## Caching and invalidation (derived data only)
**Redesigned 2026-10-21; built: the `slots:` / `slots-ver:` part (`availability` slice 1) and the rank index and free-map (slice 2, 2026-10-23)** ([availability.md](./availability.md), [ADR 0024](../adr/0024-next-available-rank-index-free-map-and-sweep.md),
which supersedes ADR 0010). Summary; the key table, flows and failure handling live in the shard:

| Key | Value | Lifetime |
|---|---|---|
| `slots:<doctorUserId>:<ver>:<typeId>:<fromDoctorDate>:<toDoctorDate>` | UTC slot list (not viewer-rendered) | ≤ 60 s; `slots-ver:<doctorUserId>` is bumped on any input change instead of deleting by prefix |
| `next-available:index` (ZSET) and `free-map:<doctorUserId>` | earliest free start and a 15-minute free-slot bitmap for the next 14 days, on the shortest active type | removed on input change, rewritten by the worker refresh and a 120 s sweep |

Invalidated **after commit** on: booking, reschedule, cancel, no-show, completion, working-hours change, exception
change, consultation-type change, timezone change, accepting toggle, suspension, reinstatement. Rendering per viewer
happens after the cache. A cache miss must still meet the budget.

**Search** ranks the whole SQL-filtered bookable candidate set from the index (`ZMSCORE`), computes at most a small
capped number of misses inline, and hydrates the page with one batched Identity call (Case 2). Details, including the
Redis-down degradation, are in [availability.md](./availability.md).

## Budgets (p95)
| Path | Budget |
|---|---|
| Slot computation, 14-day window | < 300 ms (in-memory part < 5 ms for 14 days, 3 shifts/day, 150 busy). Measured 2026-10-21 for `GET .../slots` with 150 busy consultations: p95 about 19 ms on a cache miss, about 11 ms on a hit, pure `computeSlots` about 4 ms (opt-in `npm run test:bench`) |
| Doctor search | < 400 ms |
| Booking write | < 200 ms |
| Calendar/day view | < 200 ms |

Windows are bounded by the contract: slots ≤ 14 days, calendar ≤ 7 days.

## Schedule changes never move bookings
Changing hours, adding an exception, or changing types never cancels or moves existing consultations. If a
change leaves future non-terminal consultations outside open hours, the API returns
`409 ScheduleConflictsUnconfirmed` with their ids; resubmitting with `confirmConflicts=true` applies it, flags
them `needs_admin_followup` (`followup_reason='schedule_blocked'`), audits, and queues patient notifications.
Type changes (duration, price) affect future bookings only; existing rows keep their times and price snapshot.
