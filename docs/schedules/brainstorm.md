---
title: schedules — Brainstorm
owner: care-team
service: care-service
module: schedules
status: draft
diataxis: explanation
last_verified: 2026-10-08
tags: [brainstorm, schedules, working-hours, exceptions, consultation-types]
related: [doctors-spec, verification-spec, scheduling-slots, data-model, api, rbac, adr-0002-slots-never-stored, adr-0010-next-available-lazy-cache-worker-refresh]
---

# schedules — Brainstorm

Scope decided with the user on 2026-10-08 (branch `feature/schedules`, from `main` @ 9c8cd31 after the verification merge).

## Problem & purpose
A doctor must be able to say **when** they see patients and **what** they offer, before anyone can be booked.
This module owns the three *inputs* to availability: recurring weekly hours, per-date exceptions, and consultation
types (duration + price). Slots themselves are never stored ([ADR 0002](../adr/0002-slots-never-stored.md)); the
`availability` and `consultations` modules compute and consume these inputs, so `schedules` comes first.

## Actors
- **Doctor** (Identity `status=active`, not locally suspended) — manages their own hours, exceptions and types.
- **Patient / admin** — no route in this slice.
- No service callers, and **no Identity call** (nothing here touches `lib/identity-client`).

## In scope (this iteration)
The eight operations the contract already defines (tag `schedules`); the contract needs no new operation.

- `GET/PUT /api/doctors/me/working-hours` — weekly hours, split shifts, atomic replace.
- `GET/POST /api/doctors/me/exceptions`, `DELETE /api/doctors/me/exceptions/{id}` — `day_off` (range ≤ 60 days, one row per date) and `custom_hours` (one date, replaces that weekday's hours).
- `GET/POST /api/doctors/me/consultation-types`, `PATCH /api/doctors/me/consultation-types/{id}`.
- Tables `working_hours`, `schedule_exceptions`, `consultation_types` (one raw-SQL migration each, explicit grants to `vcare_app`; no `DELETE` grant is needed because everything is soft-deleted).
- **`pkg/slots` open-interval resolution** (pure, luxon): weekly hours + exceptions → open UTC intervals per doctor-local date, with DST gap/overlap handling, merged and sorted. Exhaustive unit tests. Busy subtraction and slicing stay in `availability`.
- **Conflict flow behind a port** (below): the full `confirmConflicts` contract path ships now.
- **`isBookable` wiring** in the `doctors` module: replace the hard-coded `false` active-type term (doctors spec D-R12) with a call to a `schedules` service method.

## Out of scope
- Slot endpoints, busy-interval subtraction, slicing, the `slots:*` and `next-available:*` caches, search → `availability`.
- The `consultations` table and lifecycle, `needs_admin_followup` flagging, patient notifications → `consultations`.
- Reacting to a doctor **timezone change** (PATCH `/doctors/me` already accepts it): re-interpreting existing hours and bookings is not done here; see Open questions.
- Admin editing of a doctor's schedule (doctors are independent; PRD §3).
- Consultation-type deletion (types are deactivated, never removed; the column `deleted_at` exists for the pattern but no route sets it).

## Key entities & relationships
Exactly as `architecture/data-model.md`; no schema change is proposed.
- `working_hours` — `doctor_profile_id`, ISO `weekday` 1–7, `TIME start_time/end_time` (`end_time` may be `24:00`, which Postgres `TIME` accepts), `CHECK (end_time > start_time)`. Several rows per weekday = split shifts. `PUT` soft-deletes the old set and inserts the new one in one transaction.
- `schedule_exceptions` — `doctor_profile_id`, `date`, `type ∈ day_off | custom_hours`, optional times, reason; one live row per `(doctor_profile_id, date)` (`uq_schedule_exceptions_doctor_profile_id_date`).
- `consultation_types` — `doctor_profile_id`, `name` (unique among live rows per doctor), `duration_minutes` 5–240, `price` (minor units), `currency`, `is_active`.
- All three hang off `doctor_profiles(id)` (`ON DELETE RESTRICT`, FK-covering indexes already designed). The wire never exposes the profile id; ownership is resolved from the token's `userId` → the caller's live profile.

## Primary flows / endpoints (with roles + ownership)
All routes: role `doctor`, ownership `self` (profile resolved from `auth.userId`, never from the body), `status=active` **and** not locally suspended (the existing `doctorNotSuspendedCheck`). A caller without a profile gets `404 NotFound`.

| Route | Behaviour | Audit actions |
|---|---|---|
| `GET /working-hours` | `{ timezone, days }` from the profile's timezone | — |
| `PUT /working-hours` | replace the set; overlap on one weekday → 400; impact check → 409 `ScheduleConflictsUnconfirmed` unless `confirmConflicts=true` | `schedule.hours_replaced`, `schedule.conflicts_confirmed` |
| `GET /exceptions` | keyset `(date, id)`, `fromDate` defaults to today in the doctor's timezone | — |
| `POST /exceptions` | create 1..60 rows; existing live exception on a date → 409 `Conflict`; impact check as above | `schedule.exception_created`, `schedule.conflicts_confirmed` |
| `DELETE /exceptions/{id}` | soft delete; foreign id → 404 | `schedule.exception_deleted` |
| `GET /consultation-types` | keyset by id, `isActive` filter | — |
| `POST /consultation-types` | create; duplicate live name → 409 `Conflict` | `consultation_type.created` |
| `PATCH /consultation-types/{id}` | partial update incl. `isActive`; duplicate name → 409 | `consultation_type.updated` |

Flow notes:
- Writes run as **one transaction**: write the rows, call the impact provider, write the audit row(s). Cache invalidation happens **after commit**.
- Hours/exceptions in the **past** (before today in the doctor's timezone) are rejected with 400 for exceptions; `PUT` hours has no date.
- `custom_hours` exceptions and the weekday's `working_hours` are never merged: the exception **replaces** that date (ADR 0002 / scheduling-slots).

## Business rules & state transitions
- Domain rule 2 (inputs): hours are doctor-local wall-clock; every date is evaluated in `doctor_profiles.timezone`.
- Domain rule 4: duration comes only from the type; `durationMinutes` 5–240.
- Domain rule 6: a doctor is bookable only with ≥ 1 **active** type → `isBookable` now reflects this; deactivating the last active type flips it to `false` immediately.
- Domain rule 22 / soft delete: replaced hours and removed exceptions set `deleted_at`.
- Changing a type's duration or price affects **future** bookings only; consultations keep their own times and a price snapshot (nothing to do here, consultations will snapshot).
- No state machine: all three entities are plain CRUD with soft delete.

## Cross-service touchpoints (case, direction, failure policy)
None. No Identity call, so no Case 1–4 policy applies. (Search-time Case 2 hydration belongs to `availability`.)

## Internal seams (decided)
Two DI tokens keep `schedules` complete without depending on modules that do not exist yet. Their defaults are explicit no-ops and are registered in `bootstrap.ts`; the later module rebinds them.

| Token | When | Default | Real implementation arrives with |
|---|---|---|---|
| `ScheduleImpactProvider` | inside the transaction, before audit | returns `[]` (no affected consultations) | `consultations`: finds future non-terminal consultations outside the new open intervals (via `pkg/slots` open-interval resolution), flags them `needs_admin_followup` with `followup_reason='schedule_blocked'`, enqueues patient notifications |
| `ScheduleChangeListener` | after commit | no-op | `availability`: invalidates `slots:*` and `next-available:*`, enqueues the coalesced refresh (ADR 0010) |

Consequence to be honest about in the spec: until `consultations` lands, the 409 `ScheduleConflictsUnconfirmed` path is covered by unit tests with a stub provider only; the real end-to-end test is a deliverable of the `consultations` module and goes into its spec's task list.

## Privacy & audit
- No PII or clinical data in this module. Hours, dates and prices are not sensitive; the optional exception `reason` is free text, so it is **not logged** and is **not** put in audit metadata (ids, counts, dates, and statuses only).
- Audit rows are written in the same transaction as the write (CLAUDE.md → Privacy and logging). `schedule.conflicts_confirmed` metadata carries the affected consultation **ids and count**.
- Responses carry no URLs; no admin role has a route here, so no admin DTO shaping is needed.

## Constraints & guideline notes
- **Currency (decided):** a consultation type's `currency` must equal the doctor's profile currency and be in `ALLOWED_CURRENCIES`, otherwise `400 ValidationFailed`. Profile fee and type price stay independent: the profile fee is the search "from" price, the type price is what a booking snapshots. No sync, documented divergence.
- No new runtime dependency (`luxon` is already pinned, ADR 0019) and no new env variable (`ALLOWED_CURRENCIES` exists). Constants: 60-day exception range, ≤ 6 intervals per weekday (both from the contract).
- `isBookable` wiring is service-to-service (`doctors` → `schedules` service), never a cross-module repository import. Cost: one more query on the doctors reads; doctors' "exactly 4 queries" assertion becomes 5.
- `pkg/slots` rules: pure, no clock, no env; `now` passed in; luxon only for zone maths.
- Rate limits: none specified for these routes; the global per-user limiter applies (open question below).
- Index/migration rules from CLAUDE.md apply: every FK covered, every index commented with its query, no defaults on critical columns (`duration_minutes`, `price`, `currency`, `is_active` set explicitly).

## Contract changes expected
- **None required to build.** Possible clarifications only: (a) the delete-exception edge case below, (b) a documented cap on types per doctor if one is chosen.

## Open questions
1. **Deleting a `custom_hours` exception can strand bookings** (the day reverts to weekly hours, which may not contain a booking made inside the override). The contract's `deleteMyException` has no 409. Recommendation: add `ScheduleConflictsUnconfirmed` and `confirmConflicts` (query parameter) to the delete operation, handled by the same port. Needs a contract edit before code. Deleting a `day_off` can never strand anything.
2. **Doctor timezone change** re-interprets all hours and every future booking. Recommendation: out of scope here; `consultations` (or a follow-up on `doctors`) runs the same impact check on `PATCH /doctors/me` when `timezone` changes. Record it in doctors' deferred list.
3. **Cap on types per doctor** (contract has none). Recommendation: 20, `409 Conflict` beyond it — a contract note, cheap to add now.
4. **Rate limit on schedule writes.** Recommendation: reuse the user-level write limiter at 30/min; not in CLAUDE.md's table, so confirm.
5. **Exceptions in the past:** reject (`400`) vs allow for record-keeping. Recommendation: reject; a past date cannot change availability.
6. **`24:00` end time** is accepted by the contract pattern and by Postgres `TIME`; `pkg/slots` must treat it as midnight of the next local day. Confirm with a DST-day unit test in the spec.
7. **Platform deltas for `/system-design`:** none (service scope only; no hub edit needed).

## Success criteria
- A doctor with status `active` can set split-shift weekly hours, block a date range, override one date, and define/deactivate consultation types; every response matches `contracts/openapi.yaml` (status codes, error codes, shapes).
- Non-doctors get 403, suspended doctors get 403 immediately, a doctor never reads or edits another's rows (foreign id → 404).
- `PUT working-hours` is atomic: a failed validation or a concurrent replace leaves exactly one coherent set (race test).
- `pkg/slots` open-interval tests cover DST forward/back, split shifts, `24:00`, custom-hours replacement, day-off, and cross-midnight UTC rendering.
- `isBookable` is `true` for an approved, synced, accepting, unsuspended doctor with an active type and `false` the moment the last active type is deactivated.
- The conflict flow works end-to-end against a stub provider; the default provider never blocks a write.
- Every write has an audit row in the same transaction; logs contain no exception `reason` text.
