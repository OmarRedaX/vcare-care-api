---
title: "ADR 0002: Slots are computed, never stored"
owner: care-team
service: care-service
status: accepted
date: 2026-09-14
diataxis: explanation
last_verified: 2026-09-14
tags: [adr, decision, scheduling, slots, performance]
related: [scheduling-slots, data-model, adr-0003-db-exclusion-constraint]
---

# ADR 0002 — Slots are computed, never stored

- **Status:** Accepted • **Date:** 2026-09-14 • **Deciders:** care-team

## Context
Patients need available slots for a doctor and consultation type, in their own timezone, up to 60 days ahead.
Availability depends on weekly hours with split shifts, date exceptions (leave, custom hours), per-type durations,
existing consultations, and the doctor's IANA timezone including DST transitions. The PRD states slots are never
stored. Thousands of doctors, several types each, and a 60-day horizon would make materialized slots large, and
every schedule edit, duration change, DST shift, booking, or cancellation would have to rewrite them consistently.

## Decision
Store only the inputs (`working_hours`, `schedule_exceptions`, `consultation_types`, `consultations`, doctor
timezone) and compute slots per request in a pure module (`pkg/slots`) with a fixed number of queries, in the
doctor's timezone, returning UTC plus viewer-local rendering. Allow only **derived** Redis caches with short TTLs
(`slots:*` ≤ 60 s, `next-available:*` ≤ 5 min) invalidated after any input change. Booking re-validates with the same
pure functions inside the transaction; the exclusion constraint ([ADR 0003](./0003-db-exclusion-constraint.md)) is the
final guarantee.

## Consequences
- ➕ Availability is always consistent with the inputs; no backfill or repair jobs after schedule edits or DST.
- ➕ Storage grows with consultations, not with doctors × days × types.
- ➕ One implementation serves the slot endpoint, the profile preview, booking re-validation, and conflict detection.
- ➖ CPU per request; mitigated by bounded windows (≤ 14 days), fixed query count, in-memory computation, and caches.
- ➖ Search cannot `ORDER BY` a slot column; it uses the derived `next-available` cache, computed lazily per page.
- ➖ A budget test (14 days, busy doctor, < 300 ms) is mandatory to keep the approach honest.

## Alternatives considered
- **Pre-generated slot table** (one row per doctor/type/slot, status free/booked) — rejected: huge and write-heavy,
  goes stale on every edit and DST change, needs invalidation and regeneration logic, duplicates the source of truth,
  and a `SELECT … FOR UPDATE` on slot rows would still not express overlaps across types of different durations.
- **Calendar materialization job** (nightly job materializes N days of availability) — rejected: staleness between
  runs shows booked or blocked times as free, same-day edits need a second path, and the job becomes a Tier-1
  dependency for search.
