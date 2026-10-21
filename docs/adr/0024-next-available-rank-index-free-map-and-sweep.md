---
title: "ADR 0024: next-available is a Redis rank index with a free-slot map, kept fresh by remove-on-change, refresh and a sweep"
owner: care-team
service: care-service
status: accepted
date: 2026-10-21
diataxis: explanation
last_verified: 2026-10-21
tags: [adr, decision, search, availability, caching, slots, redis]
related: [availability, scheduling-slots, capacity, adr-0002-slots-never-stored, adr-0008-care-worker-component, adr-0010-next-available-lazy-cache-worker-refresh, adr-0025-derived-name-index, adr-0026-discovery-degradation-when-redis-is-down]
---

# ADR 0024 — `next-available` is a Redis rank index with a free-slot map, kept fresh by remove-on-change, refresh and a sweep

- **Status:** Accepted • **Date:** 2026-10-21 • **Deciders:** care-team • **Supersedes:** [ADR 0010](./0010-next-available-lazy-cache-worker-refresh.md)

## Context
Search sorts by earliest availability and filters by an availability window (`availableFrom` / `availableTo`), within a
400 ms p95 budget, at ~25 rps peak. Slots are never stored ([ADR 0002](./0002-slots-never-stored.md)), and SQL cannot
order by a value that lives in Redis. [ADR 0010](./0010-next-available-lazy-cache-worker-refresh.md) chose one key per
doctor with a TTL; that cannot give a keyset sort over the whole filtered set, and an "earliest slot" value cannot answer
"is there a free slot between 09:00 and 17:00 tomorrow" for a doctor who is also free today.

## Decision
- **Rank index.** Redis sorted set `next-available:index`: member = doctor user id, score = epoch ms of the earliest free
  slot start in the next 14 days, computed on the doctor's **shortest active consultation type**; a known "no slot in the
  window" is stored as the sentinel score `1e15`. Search reads it with one `ZMSCORE` over the SQL candidate ids.
- **Free-slot map.** `free-map:<doctorUserId>`: a base instant plus one bit per 15-minute bucket for 14 days (about 170 B),
  TTL 600 s, written in the same worker computation as the index. A window filter reads it (pipelined `GET`) for the
  surviving candidates only, and is exact to 15 minutes.
- **Freshness.** (1) Every input change (booking, reschedule, cancel, no-show, completion, hours, exceptions, types,
  timezone, accepting toggle, suspension, reinstatement) runs after commit: bump `slots-ver:<doctorUserId>`, `ZREM` the
  member, delete the free-map, `SADD` the doctor to `next-available:refresh`. (2) `care-worker` drains the refresh set
  within seconds and writes the index and free-map. (3) A sweep every 120 s recomputes every bookable doctor, removes
  members that are no longer bookable, and writes `next-available:swept-at`. (4) A reader treats an **absent member or a
  score before `now`** as a miss and computes it inline, at most `AVAILABILITY_INLINE_MISS_CAP` (default 20) doctors per
  request, single-flighted per doctor; doctors still unknown rank last.
- **Slot-list cache keys** carry a per-doctor version: `slots:<doctorUserId>:<ver>:<typeId>:<fromDate>:<toDate>`,
  TTL 60 s; an input change bumps `slots-ver:<doctorUserId>` instead of deleting by prefix (no `SCAN`).
- Window filters must lie inside `[now, now + 14 days]` and be at most 14 days; anything else is `400 ValidationFailed`.
- Keyset cursor for the earliest sort is the signed `(score | none, id)`; price and experience sorts without a window
  filter use a plain SQL keyset on `(consultationFee, id)` / `(yearsExperience, id)`.

## Consequences
- ➕ Exact ordering over the whole filtered set; the contract's window filter keeps its meaning; no Postgres table of
  derived values; the sweep bounds every lost invalidation to about 2 minutes.
- ➕ `ZREM`-on-change makes a stale order impossible between a change and the next computation.
- ➖ Two more Redis key families (index, free-map) plus a refresh set to operate; the worker does about 15 to 20 s of CPU per
  120 s at 2.5 k doctors, and the unfiltered candidate query grows linearly with doctors (revisit triggers in
  [capacity.md](../architecture/capacity.md)).
- ➖ Pages of the earliest sort can skip or repeat a doctor whose value changes between two page requests (accepted).
- ➖ The index answers "can this doctor see me at all" for the shortest type only; the exact per-type answer is `/slots`.
- ➖ `CLAUDE.md` names the slot key as `slots:<doctorId>:<typeId>:<fromDate>:<toDate>`; the `<ver>` segment is a refinement
  that `/update-docs` carries into `CLAUDE.md` when the module is built.

## Alternatives considered
- **Per-doctor keys with a TTL, ranked in memory (the ADR 0010 shape):** rejected; no cheap way to read every candidate's
  value in one round trip and no place for the window bitmap.
- **A derived Postgres table of next-available values:** rejected; contradicts "slots are never stored", and a worker writing
  profile-adjacent rows contends with the booking `FOR SHARE` profile lock.
- **`availableTo` only, or "earliest slot inside the window":** rejected; the first cannot express "tomorrow", the second
  hides doctors who are free both today and tomorrow.
- **Keep the entry on change and only enqueue a refresh:** rejected; search could show a just-taken slot until the worker
  caught up, and correctness would lean on the worker.
