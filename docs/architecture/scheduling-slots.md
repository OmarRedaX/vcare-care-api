---
title: Scheduling and Slot Computation
owner: care-team
service: care-service
status: draft
diataxis: explanation
last_verified: 2026-09-14
tags: [scheduling, slots, timezones, booking, caching, performance]
related: [data-model, consultation-lifecycle, resilience, adr-0002-slots-never-stored, adr-0003-db-exclusion-constraint]
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
| Busy intervals | consultations with status `booked`, `waiting`, `in_progress`, not deleted | UTC instants, half-open `[start, end)` |

`cancelled` and `no_show` release their interval — exactly the set the exclusion constraint ignores.

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
- No `Date` arithmetic for schedules; luxon only. Timezones are validated with `IANAZone.isValidZone`.

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
| Key | Value | TTL | Used by |
|---|---|---|---|
| `slots:<doctorUserId>:<typeId>:<fromDoctorDate>:<toDoctorDate>` | UTC slot list (not viewer-rendered) | ≤ 60 s | slots endpoint, doctor profile preview |
| `next-available:<doctorUserId>` | earliest free slot start in the next 14 days | ≤ 5 min | search `sort=earliest_availability`, `availableFrom/To` filters |

Invalidated by doctor prefix **after commit** on: booking, reschedule, cancel, no-show, working-hours change,
exception change, consultation-type change, timezone change, accepting toggle, suspension. Rendering per viewer
happens after the cache. A cache miss must still meet the budget.

**Search** never computes slots for every row: SQL filters on indexed columns produce the bookable candidate
page; `next-available` is read with one `MGET` and computed lazily only for misses on that page; names come from
one batched Identity call (Case 2).

## Budgets (p95)
| Path | Budget |
|---|---|
| Slot computation, 14-day window | < 300 ms (in-memory part < 5 ms for 14 days, 3 shifts/day, 150 busy) |
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
