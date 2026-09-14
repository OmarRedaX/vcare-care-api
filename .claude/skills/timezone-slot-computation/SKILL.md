---
name: timezone-slot-computation
description: Use when computing doctor availability or slots, validating or creating a booking or reschedule, handling working hours, split shifts, schedule exceptions, doctor-timezone vs patient-timezone conversion, DST edge cases, the booking horizon, or the slot-computation performance budget in the vcare Care service. Slots are never stored — this skill defines the algorithm, the booking rules, and the hot-path budget.
---

# Timezone-Aware Slot Computation (vcare Care)

## Overview

**Slots are never stored.** Availability is computed per request from four stored inputs:

```
slots = slice( WorkingHours − ScheduleExceptions − booked Consultations , by ConsultationType.duration )
        computed in the DOCTOR's timezone, returned in UTC + rendered in the PATIENT's timezone
```

**Why:** stored slots go stale on every schedule edit, duration change, DST shift, or cancellation, and they multiply storage by doctors × days × types. Inputs are small and authoritative; computation is cheap when done in memory with a fixed number of queries. The database exclusion constraint — not the computation — is the final guarantee against double-booking.

## Inputs

| Input | Stored as | Interpreted in |
|---|---|---|
| `doctor_profiles.timezone` | IANA zone (`Africa/Cairo`) | — |
| `working_hours` | `(weekday 1–7 ISO, start_time TIME, end_time TIME)`, many per weekday (split shifts) | doctor tz, per local date |
| `schedule_exceptions` | `(date DATE, type day_off \| custom_hours, start_time, end_time)` | doctor tz, that local date |
| `consultation_types` | `duration_minutes` | — |
| `consultations` | `starts_at, ends_at TIMESTAMPTZ`, status | UTC instants |
| Request | `from`, `to` (dates or instants), `typeId`, viewer `timezone` | patient tz for rendering |

Only non-terminal consultations block time: `status IN ('booked','waiting','in_progress')` and `deleted_at IS NULL` — exactly the set the exclusion constraint considers.

## The algorithm (pure — lives in `pkg/slots`, no DB, no env, `now` passed in)

```
computeSlots({ doctorTz, workingHours, exceptions, busy, durationMin, window, now, horizonDays, viewerTz }):

1. Clip the window
   earliest = max(window.start, now)                           # rule: no booking in the past
   latest   = min(window.end,   now + horizonDays)             # rule: 60-day horizon
   if earliest >= latest → []

2. Enumerate LOCAL dates in the doctor's timezone
   for localDate from toDoctorLocalDate(earliest) − 1 day to toDoctorLocalDate(latest) + 1 day
     (± 1 day so shifts crossing UTC midnight are not lost)

3. Build the day's open intervals (doctor-local wall clock)
   exception = exceptions[localDate]
   if exception.type == day_off         → intervals = []
   elif exception.type == custom_hours  → intervals = [(exception.start, exception.end)]
   else                                 → intervals = workingHours[isoWeekday(localDate)]   # split shifts = several
   merge overlapping/adjacent intervals; drop end <= start

4. Convert each local interval to a UTC instant interval
   startUtc = DateTime.fromISO(`${localDate}T${start}`, { zone: doctorTz })
   endUtc   = DateTime.fromISO(`${localDate}T${end}`,   { zone: doctorTz })
   DST rules:
     • nonexistent local time (spring-forward gap): luxon shifts forward — accept the shifted instant,
       but never produce a slot that starts inside the gap
     • ambiguous local time (fall-back overlap): use the EARLIER offset for starts and the LATER offset for ends,
       so the interval is the full wall-clock span; slices below dedupe by UTC instant
   clip to [earliest, latest]

5. Subtract busy intervals (UTC, half-open [start, end))
   free = intervals − union(busy)          # sort busy by start once; linear sweep

6. Slice each free interval by the type's duration
   cursor = alignedStart(freeInterval.start)     # align to the WORKING-HOURS interval start in doctor-local time,
                                                 # stepping by durationMin, so slots stay on a predictable grid
   while cursor + duration <= freeInterval.end:
       emit [cursor, cursor + duration)
       cursor += duration
   drop any slot with start < now (+ optional lead time)

7. Dedupe by UTC start (DST overlap), sort ascending

8. Render
   each slot → { startsAt: UTC ISO, endsAt: UTC ISO,
                 startsAtLocal: in viewerTz ISO with offset, endsAtLocal, timezone: viewerTz }
   group by the VIEWER's local date for display (a doctor's 23:30 slot may be "tomorrow" for the patient)
```

**Grid alignment:** slots start at the working interval's start and step by the consultation duration (a 09:00–12:00 shift with a 30-min type yields 09:00, 09:30, …). After a busy interval ends off-grid, the next slot starts at the next grid point ≥ the busy end — never at an arbitrary minute.

## Booking rules (validated again inside the booking transaction)

Computation shows what *looked* free. Booking must re-prove it at the moment of confirmation:

```
POST /consultations  (Idempotency-Key required)
BEGIN
  1. idempotency: same (patient_user_id, key) exists → return that consultation (same body) or 422 (different body)
  2. doctor bookable?  verification approved + identity synced + not suspended + accepting   → else 409 DoctorNotBookable
  3. patient emailVerified (token) → else 403 EmailNotVerified
  4. type belongs to doctor, live → duration from the TYPE (never from the client)
  5. starts_at > now → else 422 BookingInPast ; starts_at <= now + 60d → else 422 BeyondBookingHorizon
  6. [starts_at, starts_at + duration) lies inside the doctor's open intervals for that doctor-local date,
     after exceptions, and on the slot grid → else 422 OutsideWorkingHours
  7. INSERT consultation (status booked, patient_timezone, idempotency_key)
       → SQLSTATE 23P01 exclusion_violation → 409 SlotUnavailable
  8. invalidate caches (below); enqueue confirmation notification (async)
COMMIT
```

- Steps 2–6 reuse the **same pure functions** as `computeSlots` (open-interval builder + grid check) — one implementation, two callers.
- Concurrency is resolved by the exclusion constraint, not by `SELECT … FOR UPDATE` on a slot row (there is no slot row).
- **Reschedule** = same checks for the new interval + `UPDATE consultations SET starts_at, ends_at` on the same row in one transaction (old interval released atomically), + policy window (patients: not within 2 h of the **current** start).
- **Cancel** releases the interval by moving to `cancelled`; no slot bookkeeping.
- **Schedule changes** (hours, exceptions, types) never move or cancel existing consultations; conflicts are listed and require `confirmConflicts=true`, then flagged for admin follow-up.

## Hot-path budget: 14-day window < 300 ms p95

**Query plan — fixed number of queries regardless of window size:**
1. doctor profile (timezone, bookability) — PK lookup
2. working hours for the doctor — `idx_working_hours_doctor_profile_id` (tiny)
3. exceptions in `[fromDate−1, toDate+1]` — `uq_schedule_exceptions_doctor_profile_id_date` (partial, live rows)
4. consultation type — PK lookup (scoped to doctor)
5. busy consultations overlapping the UTC window — served by the GiST index of `excl_consultations_doctor_no_overlap`:
   `WHERE doctor_user_id = $1 AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2, $3, '[)') AND status IN ('booked','waiting','in_progress') AND deleted_at IS NULL`

Then pure in-memory computation: O(days × intervals + busy) — microseconds to low milliseconds.

**Caching (derived data only, never a source of truth):**
- `slots:<doctorId>:<typeId>:<fromDoctorDate>:<toDoctorDate>` → the UTC slot list (not viewer-rendered), TTL ≤ 60 s. Render per viewer after the cache.
- `next-available:<doctorId>` → earliest free slot start over the next 14 days, TTL ≤ 5 min, used for search sorting.
- **Invalidate** both on: booking, reschedule, cancel, no-show, working-hours change, exception change, type change, suspension, accepting toggle. Invalidation is by doctor prefix after commit.
- A cache miss must still meet the budget — the cache smooths peaks, it does not hide slow queries.

**Search** never computes full slots for every result row: filter/sort in SQL on indexed columns, use `next-available:<doctorId>` for "earliest availability" ordering (compute lazily for the page only on misses), and hydrate names with one batched Identity call.

## Edge cases that must have tests (pure unit tests in `pkg/slots`)
- Split shift (09:00–12:00 + 14:00–18:00) → no slots in the gap
- `day_off` exception removes the day; `custom_hours` replaces (not adds to) the weekday hours
- Busy consultation in the middle of an interval; back-to-back consultations; busy ending off-grid
- Duration longer than any free interval → no slots
- Spring-forward day in the doctor's zone (no slot starts inside the gap; durations stay real minutes)
- Fall-back day (no duplicate UTC slots)
- Doctor in UTC+3, patient in UTC−5: slot on doctor's Monday renders on patient's Sunday
- Window start in the past → clipped to `now`; window beyond 60 days → clipped
- Shift crossing UTC midnight (doctor 22:00–02:00 local is two local dates in working hours — model as 22:00–24:00 + 00:00–02:00 next weekday)
- Booking re-validation rejects a start that is off-grid or outside hours even if the slot was once shown
- Budget test: 14 days, 3 split shifts/day, 150 busy consultations → computation < 5 ms in-memory; endpoint < 300 ms against real Postgres

## Common mistakes

| Mistake | Fix |
|---|---|
| A `slots` table or pre-generated availability rows | Compute from inputs; cache derived results with a short TTL |
| Using the server's or client's local time | Always `doctorTz` for rules, `viewerTz` for rendering, UTC for storage |
| `new Date()` arithmetic across DST | `luxon` `DateTime` in a zone; durations in minutes on UTC instants |
| Duration from the request body | Duration from the consultation type |
| Checking availability then inserting without a DB guarantee | Exclusion constraint + map `23P01` to 409 |
| Querying consultations per day in a loop | One overlap query for the whole window |
| Rendering in patient tz before caching | Cache UTC, render per viewer |
| Treating `cancelled`/`no_show` as busy | Only `booked`/`waiting`/`in_progress` are busy |
| Closed intervals | Half-open `[start, end)` everywhere |
