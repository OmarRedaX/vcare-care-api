---
title: "ADR 0003: Non-overlapping consultations guaranteed by a database exclusion constraint"
owner: care-team
service: care-service
status: accepted
date: 2026-09-14
diataxis: explanation
last_verified: 2026-09-14
tags: [adr, decision, database, concurrency, booking]
related: [data-model, scheduling-slots, resilience, adr-0002-slots-never-stored]
---

# ADR 0003 — Non-overlap guaranteed by a `btree_gist` exclusion constraint

- **Status:** Accepted • **Date:** 2026-09-14 • **Deciders:** care-team

## Context
Domain rule 1: a doctor can never have two overlapping consultations. Rule 5: concurrent attempts on one slot
must not both succeed. Bookings arrive concurrently at evening peaks, from multiple instances, with different
consultation types (so different durations) competing for overlapping intervals. Slots are not stored
([ADR 0002](./0002-slots-never-stored.md)), so there is no slot row to lock.

## Decision
Enforce non-overlap in PostgreSQL:
```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE consultations
  ADD CONSTRAINT excl_consultations_doctor_no_overlap
  EXCLUDE USING gist (doctor_user_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
  WHERE (status NOT IN ('cancelled', 'no_show') AND deleted_at IS NULL);
```
Half-open ranges allow back-to-back consultations; cancelled, no-show, and soft-deleted rows release their interval.
The service maps SQLSTATE `23P01` to `409 SlotUnavailable`. Application checks (slot computation, in-transaction
re-validation) remain as a courtesy for good error messages; **the constraint is the guarantee**. Reschedule updates
the same row, so the old interval is released atomically.

## Consequences
- ➕ Correct under any concurrency, any number of instances, and any mix of durations — proven by the
  "two concurrent bookings → one 201, one 409" integration test.
- ➕ No lock management, no lock ordering, no deadlock analysis in application code.
- ➕ The constraint's GiST index also serves the busy-interval overlap query on the slot hot path.
- ➖ Requires the `btree_gist` extension in every environment.
- ➖ The `WHERE` predicate must mirror the set of interval-releasing statuses; changing it is a new migration.
- ➖ Losers of a race do the transaction work before failing; acceptable given the booking budget and rate limits.

## Alternatives considered
- **`SELECT … FOR UPDATE` on a slot row** — rejected: there are no slot rows; creating them re-introduces stored slots,
  and locking one slot row does not prevent a longer consultation type from overlapping adjacent slots.
- **Advisory locks per doctor** (`pg_advisory_xact_lock(doctor_user_id)`) — rejected as the guarantee: correct only if
  every write path remembers to take the lock, serializes all bookings of a busy doctor, and is invisible to anyone
  writing SQL outside the service. Could complement the constraint later if contention demands it.
- **Application-level check then insert** — rejected: a classic check-then-act race across concurrent transactions
  and instances; would need `SERIALIZABLE` isolation with retries on every booking path to be correct.
