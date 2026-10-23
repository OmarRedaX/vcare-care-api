---
title: availability — Manual QA (CURL), slices 1 and 2
owner: care-team
service: care-service
module: availability
status: verified
diataxis: how-to
last_verified: 2026-10-23
tags: [availability, slots, search, profile, worker, manual-qa, curl]
related: [availability-spec, availability-tasks, availability-brainstorm]
---

# availability — Manual QA (CURL)

_Run: 2026-10-23 • Servers: http://127.0.0.1:3031 (Redis up) and http://127.0.0.1:3032 (Redis down) • Result, slice 1 + slice 2 together: Redis-up run 193 pass / 0 fail / 1 skipped; Redis-down run 163 pass / 0 fail / 1 skipped (final clean runs of `scripts/curl-test-availability.sh`)_

Scope: slice 1 `GET /api/doctors/{doctorUserId}/slots` (summary below) and slice 2 `GET /api/doctors` (`searchDoctors`), `GET /api/doctors/{doctorUserId}` (`getDoctor`) and the `care-worker` loops `availability-refresh` and `availability-sweep` (spec sections 3.2, 3.3, 4.2, 7, 9.2, 12.2.7). The name filter is index-backed only from slice 3, so `name` is exercised in its documented headline-only fallback (`meta.degraded:["nameFilter"]`).

## Environment

- Care API from source with `node --import tsx src/server.ts` (equivalent to `npx tsx`, one process), `NODE_ENV=development`, Postgres 5499 `care_test` (migrated, app connected as `care_app`), dummy `STORAGE_*` and `VIDEO_*` values, `AVAILABILITY_INLINE_MISS_CAP` at its default 20.
- **Run A, Redis up:** public port 3031, `REDIS_URL=redis://127.0.0.1:6380/14`. Boot logged `redis_recovered`.
- **Run B, Redis down:** a second server on 3032 with `REDIS_URL=redis://127.0.0.1:6399/14` (nothing listens). Boot logged `redis_unavailable`; `/api/health/ready` stayed 200. Only one Care server ran at a time.
- Identity: `scripts/availability-qa-fake-identity.mjs` on 3021 (new in slice 2). It serves the JWKS, `/mint` (patient, admin, `doctor-NNNN`, `patient-NNNN`, `expired`, a pending patient), the client-credentials token, and the batch `GET /internal/users?ids=` with synthetic names `Synthetic QA Doctor <id>` and `https://avatars.example.test/qa/<id>.png`, plus a loopback control surface (`/control/mode?users=up|down|slow`, `/control/user`, `/control/stats`, `/control/reset`) so the script can flip Identity down or slow and count batch calls. The schedules fake used in slice 1 has no `/internal/users`; slice 2 needs this one.
- Worker: `node --import tsx src/worker.ts --once availability-refresh|availability-sweep` and one long-running `node --import tsx src/worker.ts` (stopped with `taskkill /F`, see notes).
- Fixture (all synthetic; slice 1 doctor 208, slice 2 doctors 8201-8208, 8240-8243 and 8210-8234, patient profile 8301, specialties `qa-avail-a|b|c`): 8201 fee 300, 08:00-12:00; 8202 fee 100, 14:00-18:00; 8203 and 8204 identical 20:00-22:00 hours (ties on earliest, fee 200); 8205 bookable with no working hours (known-none); 8206 not accepting; 8207 suspended; 8208 10:00-11:00; 8203 also has a 60-minute, a 30-minute and an inactive 15-minute type; 8240 sync pending, 8241 no active type, 8242 soft-deleted, 8243 application submitted; 8210-8234 are 25 cold doctors for the inline-miss cap. Expected orders are derived by an independent oracle (the slice 1 `/slots` route plus the fixture fees and years), never read back from the search itself.
- Every call sent a fresh UUID `X-Request-Id`; the echoed header (and `error.requestId` on errors) was compared on every response. No token, cursor, email or personal data is recorded here.

Repeat (Git Bash; the worker cases need the server's env exported, including `DATABASE_URL`; `psql`, `curl` and `node` required):

```
node scripts/availability-qa-fake-identity.mjs
# Run A: Care on 3031 with a live REDIS_URL; run the script with the SAME REDIS_URL
CARE_URL=http://127.0.0.1:3031 REDIS_URL=<same redis> CARE_OWNER_DATABASE_URL=<owner url of a *_test db> \
  CARE_LOG_FILE=<server stdout file> CURSOR_FILE=<path> [DEGRADED_CURSOR=<from run B>] bash scripts/curl-test-availability.sh
# Run B: Care on 3032 with an unreachable REDIS_URL; REDIS_URL unset for the script (it paces itself under the 30/min in-memory limiter, about 5 minutes)
CARE_URL=http://127.0.0.1:3032 CARE_OWNER_DATABASE_URL=<owner url> CARE_LOG_FILE=<server stdout file> CURSOR_FILE=<path> EARLIEST_CURSOR=<from run A> bash scripts/curl-test-availability.sh
```

Run A writes `EARLIEST_CURSOR=...` and run B writes `DEGRADED_CURSOR=...` into `CURSOR_FILE`, which makes the cross-mode cursor cases work without two servers alive at once. Restart Care whenever the fake Identity is restarted (it mints a new signing key under the same `kid`, which Care's JWKS cache would reject).

## Slice 1 summary (behaviour unchanged, re-verified)

`GET /api/doctors/{id}/slots`: 401; 403 for the doctor; 200 for patient and admin; 400 bad timezone; 404 unknown type and non-bookable doctor (also while a cache key exists); 200 empty for a past window. Redis up: cache key `slots:208:<ver>:<type>:<from>:<to>` with TTL <= 60, identical second body, a cache hit proven by an edit behind the cache, booking and cancel through the API bump `slots-ver:208` and remove or restore the slot. Results: 14 of 14 with Redis up, 8 of 8 base cases with Redis down. The slice 1 fixture reset still marks `notification_outbox` rows `sent` before deleting them (`trg_notification_outbox_delete_sent_only`).

## Cases (slice 1 and slice 2)

Every row is one assertion of the script (status, error envelope or `success:true`, `X-Request-Id` echo, and the body check named). "n/a" = the case exists only in the other mode (rank index, free-map, worker and cache cases need Redis; degraded-answer cases need Redis down). The row count differs from the pass counts above because rows are merged across the two runs by scenario.


### Slice 1: base cases (Redis independent; same answers with Redis up or down)

| # | Scenario | Redis-up run | Redis-down run |
|---|----------|--------------|----------------|
| 1 | S1 unauthenticated | PASS 401 | PASS 401 |
| 2 | S1 doctor denied | PASS 403 | PASS 403 |
| 3 | S1 patient slots | PASS 200 | PASS 200 |
| 4 | S1 admin slots | PASS 200 | PASS 200 |
| 5 | S1 invalid timezone | PASS 400 | PASS 400 |
| 6 | S1 unknown type | PASS 404 | PASS 404 |
| 7 | S1 past window empty | PASS 200 | PASS 200 |

### Slice 1: Redis-backed cases (user 208 keys only)

| # | Scenario | Redis-up run | Redis-down run |
|---|----------|--------------|----------------|
| 8 | S1 (a) first call 200, 4 slots, cache key exists with a TTL <= 60 | PASS | n/a (not applicable in this mode) |
| 9 | S1 (a) second identical request returns an identical body (data and meta) | PASS | n/a (not applicable in this mode) |
| 10 | S1 (a) cache hit proven: edit of working hours behind the cache (no version bump) is not visible within the TTL | PASS | n/a (not applicable in this mode) |
| 11 | S1 (b) booking 201 , slots-ver:208 0 -> 1, booked start no longer listed (3 slots) | PASS | n/a (not applicable in this mode) |
| 12 | S1 (c) cancel 200, slots-ver:208 1 -> 2, start listed again (4 slots) | PASS | n/a (not applicable in this mode) |
| 13 | S1 (d) X-Request-Id echoed on every call in (a)-(c) and on an admin cached read | PASS | n/a (not applicable in this mode) |
| 14 | S1 non-bookable doctor (cache key present when Redis is up) | PASS 404 | PASS 404 |

### Slice 2: RBAC, envelope, shape

| # | Scenario | Redis-up run | Redis-down run |
|---|----------|--------------|----------------|
| 15 | search: unauthenticated | PASS 401 | PASS 401 |
| 16 | search: expired token | PASS 401 | PASS 401 |
| 17 | search: doctor role is denied | PASS 403 | PASS 403 |
| 18 | search: patient with non-active token status is denied | PASS 403 | PASS 403 |
| 19 | profile: unauthenticated | PASS 401 | PASS 401 |
| 20 | profile: doctor role is denied | PASS 403 | PASS 403 |
| 21 | profile: patient reaching /doctors/me gets the doctors router 403 | PASS 403 | PASS 403 |
| 22 | search: patient 200, exactly the 6 bookable doctors (suspended and not-accepting excluded) | PASS 200 | PASS 200 |
| 23 | search: item shape matches DoctorProfile and leaks no verification, suspension, status or slot-preview field | PASS 200 | PASS 200 |
| 24 | search: 8203 lists only its active types, primary specialty first, languages sorted | PASS 200 | PASS 200 |
| 25 | search: admin 200 with the same set | PASS 200 | PASS 200 |

### Slice 2: sorts, default sort, cursors and page 2

| # | Scenario | Redis-up run | Redis-down run |
|---|----------|--------------|----------------|
| 26 | sort=earliest_availability | PASS 200 | PASS 200 |
| 27 | default sort equals earliest_availability | PASS 200 | PASS 200 |
| 28 | sort=price (fee ASC, ties by id) | PASS 200 | PASS 200 |
| 29 | sort=experience (years DESC, ties by id DESC) | PASS 200 | PASS 200 |
| 30 | sort=bogus -> 400 | PASS 400 | PASS 400 |
| 31 | search: nextAvailableAt equals the oracle first free slot for 5 doctors; the doctor without hours has null | PASS | PASS |
| 32 | search (Redis up): the doctor with no slot (known-none) ranks last | PASS 200 | n/a (not applicable in this mode) |
| 33 | pagination limit=2 sort=earliest_availability: 3 pages, ids 8201,8208,8202,8203,8204,8205, hasMore/nextCursor exact, request id echoed | PASS | n/a (not applicable in this mode) |
| 34 | pagination limit=2 sort=price: 3 pages, ids 8202,8208,8205,8203,8204,8201, hasMore/nextCursor exact, request id echoed | PASS | PASS |
| 35 | pagination limit=2 sort=experience: 3 pages, ids 8203,8204,8201,8208,8205,8202, hasMore/nextCursor exact, request id echoed | PASS | PASS |
| 36 | limit=0 -> 400 | PASS 400 | PASS 400 |
| 37 | limit=101 -> 400 | PASS 400 | PASS 400 |
| 38 | limit=abc -> 400 | PASS 400 | PASS 400 |
| 39 | limit=100 -> 200 | PASS 200 | PASS 200 |
| 40 | cursor: tampered payload -> 400 | PASS 400 | PASS 400 |
| 41 | cursor: garbage -> 400 | PASS 400 | PASS 400 |
| 42 | cursor from sort=price replayed on sort=experience -> 400 | PASS 400 | PASS 400 |
| 43 | cursor mismatch names the cursor field in details | PASS | PASS |
| 44 | cursor is a position, not a grant: a price cursor from one filter set is accepted on another (200, never 5xx) | PASS 200 | PASS 200 |
| 45 | cursor from experience replayed on price -> 400 | PASS 400 | PASS 400 |
| 46 | cursor from earliest_availability replayed on price -> 400 | PASS 400 | n/a (not applicable in this mode) |
| 47 | cursor issued while Redis was down (meta.degraded sort) is 400 on a healthy server (restart the list) | PASS 400 | n/a (not applicable in this mode) |
| 48 | degraded-cursor rejection names the cursor field | PASS | n/a (not applicable in this mode) |
| 49 | unknown query parameter -> 400 | PASS 400 | PASS 400 |

### Slice 2: filters

| # | Scenario | Redis-up run | Redis-down run |
|---|----------|--------------|----------------|
| 50 | specialty=qa-avail-b -> 8203, 8204 (earliest/price order with ties by id) | PASS 200 | PASS 200 |
| 51 | specialty=unknown-slug -> 200 empty | PASS 200 | PASS 200 |
| 52 | specialty empty value -> 400 | PASS 400 | PASS 400 |
| 53 | language=en within spec a -> 8203, 8201 (price order) | PASS 200 | PASS 200 |
| 54 | language=fr -> empty | PASS 200 | PASS 200 |
| 55 | language=EN (uppercase) -> 400 | PASS 400 | PASS 400 |
| 56 | language=eng -> 400 | PASS 400 | PASS 400 |
| 57 | minFee=150&maxFee=200 inclusive -> 8205, 8203, 8204 | PASS 200 | PASS 200 |
| 58 | minFee=100&maxFee=100 -> 8202 | PASS 200 | PASS 200 |
| 59 | minFee=301 -> empty | PASS 200 | PASS 200 |
| 60 | minFee > maxFee -> 400 naming minFee | PASS 400 | PASS 400 |
| 61 | minFee > maxFee: details[].field = minFee | PASS | PASS |
| 62 | minFee=-1 -> 400 | PASS 400 | PASS 400 |
| 63 | minFee=abc -> 400 | PASS 400 | PASS 400 |
| 64 | maxFee above int range -> 400 | PASS 400 | PASS 400 |
| 65 | combined: spec a + language ar + fee 100..150 -> 8202, 8208, 8205 | PASS 200 | PASS 200 |
| 66 | name=QA Alpha (headline prefix, case-insensitive) -> 8201 with meta.degraded nameFilter | PASS 200 | PASS 200 |
| 67 | name with repeated and surrounding spaces is trimmed and collapsed -> 8201 | PASS 200 | PASS 200 |
| 68 | name=QA%20ALPHA upper case -> 8201 | PASS 200 | PASS 200 |
| 69 | name=QA Cardiology is not a prefix -> empty, still degraded nameFilter | PASS 200 | PASS 200 |
| 70 | name on the Identity display name does not match yet (headline-only, S3 pending) -> empty + nameFilter | PASS 200 | PASS 200 |
| 71 | name of one character -> 400 | PASS 400 | PASS 400 |
| 72 | name with a control character -> 400 | PASS 400 | PASS 400 |
| 73 | name of 101 characters -> 400 | PASS 400 | PASS 400 |
| 74 | name with only spaces -> 400 | PASS 400 | PASS 400 |
| 75 | search: duplicate sort parameter -> 400 (array rejected) | PASS 400 | PASS 400 |
| 76 | search: duplicate language parameter -> 400 | PASS 400 | PASS 400 |
| 77 | search: cursor longer than 1024 characters -> 400 | PASS 400 | PASS 400 |
| 78 | search: SQL metacharacters in specialty are bound, not executed -> empty 200 | PASS 200 | PASS 200 |
| 79 | search: non-ASCII name prefix (2 code points) -> empty 200 with nameFilter marker | PASS 200 | PASS 200 |
| 80 | search: candidate parity -- sync pending, no active type, soft-deleted, submitted doctors (8240-8243, spec a) are absent | PASS 200 | PASS 200 |

### Slice 2: availableFrom / availableTo

| # | Scenario | Redis-up run | Redis-down run |
|---|----------|--------------|----------------|
| 81 | window [tomorrow 21:30, 22:30) (exact) -> 8203,8204 | PASS 200 | n/a (not applicable in this mode) |
| 82 | window 21:30-22:30: exactly the two doctors free from 20:00-22:00 | PASS | n/a (not applicable in this mode) |
| 83 | window [21:30, 21:45): the 21:30 start lies in this 15-minute bucket -> 8203, 8204 | PASS 200 | n/a (not applicable in this mode) |
| 84 | window [21:45, 22:30): no start in any overlapping bucket -> empty (exact to 15 minutes) | PASS 200 | n/a (not applicable in this mode) |
| 85 | window with a +02:00 offset (23:30+02:00 = 21:30Z) equals the UTC window | PASS 200 | n/a (not applicable in this mode) |
| 86 | window + sort=price keeps the window and orders by price (tie by id) | PASS 200 | n/a (not applicable in this mode) |
| 87 | availableFrom only (tomorrow 21:30; to = from + 14 d clipped to now + 14 d) -> 8201,8208,8202,8203,8204 | PASS 200 | n/a (not applicable in this mode) |
| 88 | availableTo only (tomorrow 09:15; from = now) -> 8201,8208,8202,8203,8204 | PASS 200 | n/a (not applicable in this mode) |
| 89 | availableTo = now + 13 days -> every doctor with a slot (8201,8208,8202,8203,8204) | PASS 200 | n/a (not applicable in this mode) |
| 90 | window filter: page 2 via nextCursor continues the same order | PASS 200 | n/a (not applicable in this mode) |
| 91 | availableFrom in the past -> 400 | PASS 400 | PASS 400 |
| 92 | availableFrom past: details[].field = availableFrom | PASS | PASS |
| 93 | availableTo in the past (from defaults to now) -> 400 | PASS 400 | PASS 400 |
| 94 | availableFrom beyond now + 14 d -> 400 | PASS 400 | PASS 400 |
| 95 | availableTo beyond now + 14 d -> 400 | PASS 400 | PASS 400 |
| 96 | availableTo equal to availableFrom -> 400 | PASS 400 | PASS 400 |
| 97 | availableTo before availableFrom -> 400 | PASS 400 | PASS 400 |
| 98 | availableFrom without an offset -> 400 | PASS 400 | PASS 400 |
| 99 | availableFrom not a date -> 400 | PASS 400 | PASS 400 |
| 100 | availableTo longer than 40 characters -> 400 | PASS 400 | PASS 400 |

### Slice 2: profile

| # | Scenario | Redis-up run | Redis-down run |
|---|----------|--------------|----------------|
| 101 | profile: patient, bookable doctor -> 200 with nextAvailableSlots <= 5 and no admin status | PASS 200 | PASS 200 |
| 102 | profile: nextAvailableAt equals the oracle first free slot (exact, not the index) | PASS | PASS |
| 103 | profile: preview uses the shortest ACTIVE type (30 min of 60/30, inactive 15 ignored); consultationTypes active only | PASS 200 | PASS 200 |
| 104 | profile: patient, not accepting (8206) -> 404 | PASS 404 | PASS 404 |
| 105 | profile: patient, suspended (8207) -> 404 | PASS 404 | PASS 404 |
| 106 | profile: patient, unknown id -> 404 | PASS 404 | PASS 404 |
| 107 | profile: admin, bookable -> 200, status=bookable, 5 slots | PASS 200 | PASS 200 |
| 108 | profile: admin, non-bookable (not accepting) -> 200, status=not_bookable, empty slots, nextAvailableAt null | PASS 200 | PASS 200 |
| 109 | profile: admin, suspended -> 200, status=not_bookable, no suspension field exposed | PASS 200 | PASS 200 |
| 110 | profile: admin, bookable doctor with no working hours -> bookable, empty slots, null | PASS 200 | PASS 200 |
| 111 | profile: admin, unknown id -> 404 | PASS 404 | PASS 404 |
| 112 | profile: patient, non-bookable 8240 (sync pending / no active type / application submitted) -> 404 | PASS 404 | PASS 404 |
| 113 | profile: admin, non-bookable 8240 -> 200 status=not_bookable with empty preview | PASS 200 | PASS 200 |
| 114 | profile: patient, non-bookable 8241 (sync pending / no active type / application submitted) -> 404 | PASS 404 | PASS 404 |
| 115 | profile: admin, non-bookable 8241 -> 200 status=not_bookable with empty preview | PASS 200 | PASS 200 |
| 116 | profile: patient, non-bookable 8243 (sync pending / no active type / application submitted) -> 404 | PASS 404 | PASS 404 |
| 117 | profile: admin, non-bookable 8243 -> 200 status=not_bookable with empty preview | PASS 200 | PASS 200 |
| 118 | profile: patient, soft-deleted doctor (8242) -> 404 | PASS 404 | PASS 404 |
| 119 | profile: admin, soft-deleted doctor (8242) -> 404 (live profiles only) | PASS 404 | PASS 404 |
| 120 | profile: admin, doctor without an active type (8241) lists no consultation types | PASS 200 | PASS 200 |
| 121 | profile: path id 'abc' -> 404 (patient) | PASS 404 | PASS 404 |
| 122 | profile: path id '0' -> 404 (patient) | PASS 404 | PASS 404 |
| 123 | profile: path id '-5' -> 404 (patient) | PASS 404 | PASS 404 |
| 124 | profile: path id '1.5' -> 404 (patient) | PASS 404 | PASS 404 |
| 125 | profile: path id '007x' -> 404 (patient) | PASS 404 | PASS 404 |
| 126 | profile: path id '99999999999999999999999' -> 404 (patient) | PASS 404 | PASS 404 |
| 127 | profile: path id 'abc' -> 404 (admin) | PASS 404 | PASS 404 |
| 128 | profile: timezone=Africa/Cairo renders slots in that zone (offset +02:00 or +03:00) | PASS 200 | PASS 200 |
| 129 | profile: admin with timezone=Pacific/Auckland renders in that zone | PASS 200 | PASS 200 |
| 130 | profile: no timezone param -> rendered in the patient profile zone (Asia/Tokyo, +09:00) | PASS 200 | PASS 200 |
| 131 | profile: explicit timezone beats the patient profile zone | PASS 200 | PASS 200 |
| 132 | profile: patient without a patient profile defaults to UTC | PASS 200 | PASS 200 |
| 133 | profile: admin (no patient profile) defaults to UTC | PASS 200 | PASS 200 |
| 134 | profile: timezone=Invalid/Zone -> 400 | PASS 400 | PASS 400 |
| 135 | profile: timezone of 65 characters -> 400 | PASS 400 | PASS 400 |
| 136 | profile: unknown query parameter -> 400 | PASS 400 | PASS 400 |
| 137 | profile: invalid timezone on a non-bookable doctor is still 400 (validation before lookup) | PASS 400 | PASS 400 |

### Slice 2: Identity hydration (Case 2)

| # | Scenario | Redis-up run | Redis-down run |
|---|----------|--------------|----------------|
| 138 | hydration: names and avatars hydrated, profileHydrated=true | PASS 200 | PASS 200 |
| 139 | hydration: ONE batched Identity call for the page (6 distinct ids) | PASS | PASS |
| 140 | hydration: second identical page is served from the identity:user:* cache (no new Identity call) | PASS | n/a (not applicable in this mode) |
| 141 | hydration: a doctor whose Identity status is not active is dropped from search (defence in depth), count reflects the drop | PASS 200 | PASS 200 |
| 142 | profile: admin still sees the doctor whose Identity status is suspended (status only hides from search) | PASS 200 | PASS 200 |
| 143 | Identity down: search still 200, displayName/avatarUrl null, profileHydrated=false, doctors, fees and slots intact | PASS 515 | PASS 437 |
| 144 | Identity down: profile still 200 with profileHydrated=false and the slot preview | PASS 200 | PASS 200 |
| 145 | Identity down: search answered within the 8 s sanity bound | PASS 515 | PASS 437 |
| 146 | Identity slow (4 s): search 200 with profileHydrated=false | PASS 200 | PASS 200 |
| 147 | Identity back up: hydration resumes (no negative caching) | PASS 200 | PASS 200 |

### Slice 2: freshness, index, worker loops (Redis up)

| # | Scenario | Redis-up run | Redis-down run |
|---|----------|--------------|----------------|
| 148 | cold index, worker down: 25 doctors returned, exactly 20 computed inline (cap), the rest null and last | PASS 200 | n/a (not applicable in this mode) |
| 149 | cold index, second request: the remaining misses are computed (all 25 have nextAvailableAt) | PASS 200 | n/a (not applicable in this mode) |
| 150 | 8 parallel searches on a cold index: all 200 with identical (id, nextAvailableAt) lists | PASS | n/a (not applicable in this mode) |
| 151 | index after a lazy search: 8201 score = first slot ms, 8205 = NONE_SCORE (1e15), non-bookable 8206 absent | PASS | n/a (not applicable in this mode) |
| 152 | free-map:8201 written with TTL 599s (<= 600) | PASS | n/a (not applicable in this mode) |
| 153 | API: doctor 8201 replaces working hours with 22:00-23:00 | PASS 200 | n/a (not applicable in this mode) |
| 154 | invalidation: slots-ver:8201 0 -> 1, index member removed, doctor queued in next-available:refresh | PASS | n/a (not applicable in this mode) |
| 155 | oracle: the first free slot of 8201 moved after the hours change | PASS | n/a (not applicable in this mode) |
| 156 | worker down, lazy repair: the very next search shows the new order and the new nextAvailableAt | PASS 200 | n/a (not applicable in this mode) |
| 157 | lazy repair wrote the recomputed score back to the index | PASS | n/a (not applicable in this mode) |
| 158 | API: doctor 8201 restores 08:00-12:00 | PASS 200 | n/a (not applicable in this mode) |
| 159 | before the worker: member removed and queued | PASS | n/a (not applicable in this mode) |
| 160 | worker --once availability-refresh: exit 0, queue drained, 8201 recomputed to the oracle first slot with no search | PASS | n/a (not applicable in this mode) |
| 161 | worker --once availability-refresh on an empty queue: exit 0 | PASS | n/a (not applicable in this mode) |
| 162 | lost invalidation: SQL-only change to 8203 is NOT visible yet (stale index value served, within one sweep of staleness) | PASS | n/a (not applicable in this mode) |
| 163 | worker --once availability-sweep: exit 0, swept-at stamped, 8203 repaired to the oracle value, stray non-bookable member 8206 removed | PASS | n/a (not applicable in this mode) |
| 164 | after the sweep: search order matches the oracle again (victim 8203 moved to 03:00 hours) | PASS 200 | n/a (not applicable in this mode) |
| 165 | sweep log carries availability_sweep_done (counts only) | PASS | n/a (not applicable in this mode) |
| 166 | sweep singleton: session advisory lock (namespace 1104, id 0) held elsewhere -> --once exits 1 (incomplete), swept-at not advanced | PASS | n/a (not applicable in this mode) |
| 167 | sweep with Redis unreachable: --once exits 1 (incomplete), no crash | PASS | n/a (not applicable in this mode) |
| 168 | refresh with Redis unreachable: --once ends cleanly (exit 1), no crash | PASS | n/a (not applicable in this mode) |
| 169 | long-running worker: worker_started lists availability-refresh and availability-sweep | PASS | n/a (not applicable in this mode) |
| 170 | long-running worker: the boot sweep filled the index with no search request | PASS | n/a (not applicable in this mode) |
| 171 | API (worker running): doctor 8202 moves to 05:00-06:00 | PASS 200 | n/a (not applicable in this mode) |
| 172 | long-running worker: refresh loop recomputed 8202 with no search | PASS 819 | n/a (not applicable in this mode) |
| 173 | search after the worker refresh: order matches the oracle | PASS 200 | n/a (not applicable in this mode) |
| 174 | worker log carries availability_refresh_done | PASS | n/a (not applicable in this mode) |
| 175 | no name-index key exists (slice 3 not built) | PASS | n/a (not applicable in this mode) |

### Slice 2: write-through (booking and accepting toggle reach search and profile)

| # | Scenario | Redis-up run | Redis-down run |
|---|----------|--------------|----------------|
| 176 | booking the first free slot of 8208 -> 201 | PASS 201 | PASS 201 |
| 177 | booking removed 8208 from the rank index immediately (listener fan-in) | PASS | n/a (not applicable in this mode) |
| 178 | search right after the booking: 8208 nextAvailableAt is the SECOND slot (no wait for a sweep) | PASS 200 | PASS 200 |
| 179 | profile right after the booking: preview starts at the second slot and excludes the booked one | PASS 200 | PASS 200 |
| 180 | admin cancels the booking on behalf of the patient -> 200 | PASS 200 | PASS 200 |
| 181 | search after the cancel: the first slot is free again | PASS 200 | PASS 200 |
| 182 | doctor 8202 stops accepting patients -> 200 | PASS 200 | PASS 200 |
| 183 | 8202 vanishes from search at once | PASS 200 | PASS 200 |
| 184 | 8202 removed from the rank index by the doctor-change listener | PASS | n/a (not applicable in this mode) |
| 185 | patient profile of 8202 is now 404 | PASS 404 | PASS 404 |
| 186 | admin profile of 8202 is now status=not_bookable | PASS 200 | PASS 200 |
| 187 | doctor 8202 accepts patients again -> 200 | PASS 200 | PASS 200 |
| 188 | 8202 is back in search at once | PASS 200 | PASS 200 |

### Slice 2: privacy (server log)

| # | Scenario | Redis-up run | Redis-down run |
|---|----------|--------------|----------------|
| 189 | server log: no hydrated display name, avatar URL or name-filter value | PASS | PASS |
| 190 | server log: no error-level or 5xx entries | PASS | PASS |
| 191 | server log: no bearer token material | PASS | PASS |
| 192 | worker logs: no display names or avatar URLs | PASS | PASS |

### Slice 2: rate limit (profile route, per IP, runs last)

| # | Scenario | Redis-up run | Redis-down run |
|---|----------|--------------|----------------|
| 193 | rate limit: profile route answered 429 RateLimited (limit trips within the minute) | PASS | PASS |

### Slice 2: Redis down (this Care server cannot reach Redis)

| # | Scenario | Redis-up run | Redis-down run |
|---|----------|--------------|----------------|
| 194 | pagination limit=2 sort=earliest_availability: 3 pages, ids 8202,8208,8205,8203,8204,8201, hasMore/nextCursor exact, request id echoed | n/a (not applicable in this mode) | PASS |

### Slice 2: availableFrom / availableTo

| # | Scenario | Redis-up run | Redis-down run |
|---|----------|--------------|----------------|
| 195 | window [tomorrow 21:30, 22:30) (ignored) -> 8202,8208,8205,8203,8204,8201 | n/a (not applicable in this mode) | PASS 200 |
| 196 | availableFrom only (tomorrow 21:30; to = from + 14 d clipped to now + 14 d) -> 8202,8208,8205,8203,8204,8201 | n/a (not applicable in this mode) | PASS 200 |
| 197 | availableTo only (tomorrow 09:15; from = now) -> 8202,8208,8205,8203,8204,8201 | n/a (not applicable in this mode) | PASS 200 |
| 198 | availableTo = now + 13 days -> every doctor with a slot (8202,8208,8205,8203,8204,8201) | n/a (not applicable in this mode) | PASS 200 |

### Slice 2: Redis down (this Care server cannot reach Redis)

| # | Scenario | Redis-up run | Redis-down run |
|---|----------|--------------|----------------|
| 199 | Redis down: default sort -> 200, meta.degraded=["sort"], price order | n/a (not applicable in this mode) | PASS 200 |
| 200 | Redis down: rows get nextAvailableAt computed inline (equal to the oracle), the no-hours doctor null | n/a (not applicable in this mode) | PASS 200 |
| 201 | Redis down: inline nextAvailableAt equals the oracle for all 5 slotted doctors | n/a (not applicable in this mode) | PASS |
| 202 | Redis down: sort=price has no degraded marker | n/a (not applicable in this mode) | PASS 200 |
| 203 | Redis down: sort=experience has no degraded marker | n/a (not applicable in this mode) | PASS 200 |
| 204 | Redis down: window + default sort -> filter ignored, meta.degraded=["sort","availabilityFilter"] (ordered) | n/a (not applicable in this mode) | PASS 200 |
| 205 | Redis down: window + sort=price -> meta.degraded=["availabilityFilter"] | n/a (not applicable in this mode) | PASS 200 |
| 206 | Redis down: window + name + default sort -> all three markers in the documented order | n/a (not applicable in this mode) | PASS 200 |
| 207 | Redis down: window validation still applies (past availableFrom -> 400) | n/a (not applicable in this mode) | PASS 400 |
| 208 | Redis down: degraded page 1 carries meta.degraded=["sort"] and a cursor | n/a (not applicable in this mode) | PASS 200 |
| 209 | Redis down: degraded cursor continues the price order on page 2 | n/a (not applicable in this mode) | PASS 200 |
| 210 | Redis down: degraded cursor replayed with sort=price -> 400 | n/a (not applicable in this mode) | PASS 400 |
| 211 | Redis down: an 'earliest' cursor issued by a healthy server is 400 here (client restarts the list) | n/a (not applicable in this mode) | PASS 400 |
| 212 | earliest-cursor rejection names the cursor field | n/a (not applicable in this mode) | PASS |
| 213 | Redis down: profile 200 with 5 slots computed from Postgres | n/a (not applicable in this mode) | PASS 200 |
| 214 | Redis down: admin profile of a non-bookable doctor 200 | n/a (not applicable in this mode) | PASS 200 |


Skipped (both runs): the AV-R16 span rule (`availableTo - availableFrom > 14 days`) is unreachable over HTTP because both bounds must already lie in `[now, now + 14 d]`; its exactly-14-day boundary is covered by the unit tests. Without the `CURSOR_FILE` hand-off the cross-mode cursor cases report as skipped; the final runs had both cursors.

## Manual probes outside the script

- **Identity process killed mid-run** (not the control-surface "down" mode): with the fixture in place and the identity cache flushed, the fake Identity process was killed. A search (`sort=price&limit=2`) answered `200` in 338 ms and the profile `200` in 304 ms, both with `displayName:null`, `avatarUrl:null`, `profileHydrated:false`, `nextAvailableAt` intact and `X-Request-Id` echoed; the server logged `identity_hydration_degraded` (warn plus metric). Bearer tokens kept verifying from the cached JWKS. Warm, the same query returned the synthetic names with `profileHydrated:true`.
- **Raw input probes** (no fixture): repeated `sort`, `limit` and `language` parameters, a 1,100-character cursor, `minFee=1.5|1e3|blank|abc`, SQL metacharacters in `specialty`, an Arabic two-character `name`, path ids `%38201`, `00008201`, 2^63-1 and 2^63 all answered a handled `400 ValidationFailed` or `404 NotFound` (or `200` empty for the injection string); no 5xx.

## Failures / notes

- **No failing case in the final runs** (193/0/1 with Redis up, 163/0/1 with Redis down). Two script defects were found and fixed while building it, neither a product bug: (1) the profile `nextAvailableAt` comparison read a response body that the oracle fetch had overwritten; (2) the "lock held" case first used `pg_advisory_lock(1104, 0)`, but the sweep takes `pg_try_advisory_lock(hashtextextended('0', 1104))` (`src/lib/knex/session-advisory-lock.ts:19`), so the held lock was a different key and the sweep rightly ran.
- Observations, not defects:
  - `minFee=1.5`, `1e3`, a blank value and `abc` are correctly `400`, but `details[0].issue` reads "minFee must not be greater than 2147483647" (the `@Max` message is the one reported for a value that failed `ToInt`; `SearchDoctorsQueryDto.minFee`/`maxFee` in `src/app/availability/dto/availability.request.dto.ts`, `ToInt` in `src/lib/validation/transforms.ts:13`). Cosmetic: the field and status are right, the message is misleading.
  - Identity slow (4 s per call, above the 2 s client timeout): the search stays `200` with `profileHydrated:false` but takes about 4.5 s (two attempts of the Case 2 policy: 2 s timeout plus one retry). That is the documented Case 2 policy, yet it is more than ten times the 400 ms search budget whenever Identity is slow; the budget only holds with a healthy or fast-failing Identity.
  - `--once availability-refresh` with Redis unreachable exits 1; the spec states the exit-1 rule only for the sweep. The sweep exits 1 for both Redis unreachable and lock held, and neither stamps `next-available:swept-at`.
  - With Redis down the in-memory limiter allows 30 requests per minute per route (limit 60 divided by 2); the 429 case tripped after 29 more requests because earlier profile calls already counted.
  - Responses carry `Cache-Control: no-store` (the application default); the spec only says these routes are not in `NO_STORE_PREFIXES`.
  - A doctor whose Identity `status` is not `active` is dropped from search and the page is shorter than `limit` (`meta.count` 5 of 6) while `hasMore` and `nextCursor` come from the fetched page, as specified.
- **Not verifiable here:** the graceful SIGTERM shutdown of the worker (it closing its own Redis client); the long-running worker was stopped with `taskkill /F`, and the integration suite skips that case on win32. The `availability_sweep_age_s` and `availability_refresh_queue_depth` metrics (emitted at most every 30 s) were not asserted. The 400 ms / 2,500-doctor search budget is the benchmark's job (`npm run test:bench`), not a CURL case. A real Identity (suspension, reinstatement) was not available; their fan-in to the index is covered by the integration suite, and here by the accepting-patients toggle and by booking.
- Cleanup done by the script on exit, verified after the final Redis-up run (zero fixture rows in Postgres, zero keys in Redis db 14): Postgres rows for doctors 208 and 8201-8299, their consultations and outbox rows (marked `sent` before deletion), specialties `qa-avail-*` and patient profile 8301; Redis `slots:`, `slots-ver:`, `free-map:` and `identity:user:` keys of the fixture, their members of `next-available:index` and `next-available:refresh`, the `rl:doctors-*` and fixture-user write-limiter counters, the `idem:*` keys of its own booking and cancel calls, and `next-available:swept-at` when the run created it. `audit_logs` rows written by the booking, cancel and doctor API calls (ids and statuses only) stay by design (append-only table).
- Privacy: the Care server log of each final run contained no `Synthetic QA Doctor` name, no avatar URL, no name-filter value, no JWT material, no `error`-level entry and no 5xx status; worker logs contained no names or avatars. Log events seen: `request_completed`, `metric` (`availability_index_miss`, `availability_inline_compute_ms`, `availability_degraded` by reason, `identity_hydration_degraded`, `rate_limiter_degraded`), `availability_cache_unavailable`, `rate_limited`, `access_denied`.
