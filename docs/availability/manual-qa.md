---
title: availability — Slice 1 Manual QA
owner: care-team
service: care-service
module: availability
status: verified
diataxis: how-to
last_verified: 2026-10-21
tags: [availability, slots, manual-qa, curl]
related: [availability-spec, availability-tasks, availability-brainstorm]
---

# availability — Slice 1 Manual QA (CURL)

_Run: 2026-10-21 • Server: http://127.0.0.1:3031 (Redis up) and http://127.0.0.1:3032 (Redis down) • Result: 14 pass / 0 fail with Redis up; 8 pass / 0 fail with Redis down_

Scope: `GET /api/doctors/{doctorUserId}/slots` only (slice S1; spec sections 3.1, 4.1, 7.3). The search and profile routes are not built yet and are not covered.

## Environment

- Care API started from source with `tsx src/server.ts` (so the run reflects the working tree, not a stale `dist/`), `NODE_ENV=development`, public port 3031 (internal 3131), Postgres 5499 database `care_test` (migrated; app connected as `care_app`), Identity JWKS and token mint served by `scripts/schedules-qa-fake-identity.mjs` on 3021 (in-memory Ed25519 key, synthetic tokens, `ev=true`).
- **Run A, Redis up:** `REDIS_URL=redis://127.0.0.1:6380/14`. The server logged `redis_recovered` at boot.
- **Run B, Redis down:** a second Care server on 3032 with `REDIS_URL` pointing at an unreachable port (6399). It logged `redis_unavailable` at boot; `/api/health/ready` stayed 200.
- Git Bash ran the script this time (`bash scripts/curl-test-availability.sh`); `psql`, `curl` and `node` were all available in it. `redis-cli` is not installed, so Redis assertions use `ioredis` from `node_modules` inside the script.
- Fixture: synthetic doctor user 208 (UTC, approved, synced, accepting), one active 30-minute type, working hours 09:00-11:00 on the next UTC day (four slots); patient 101 (verified email), admin 1, doctor 208 token. All data and tokens are synthetic and none is recorded here. Every call sent a fresh UUID `X-Request-Id`; the response header was compared.

Repeat:

```
node scripts/schedules-qa-fake-identity.mjs
# Run A: Care on 3031 with REDIS_URL pointing at a live Redis; Run B: another Care on 3032 with an unreachable REDIS_URL
CARE_URL=http://127.0.0.1:3031 REDIS_URL=<same redis as the server> CARE_OWNER_DATABASE_URL=<owner url of a *_test db> bash scripts/curl-test-availability.sh
CARE_URL=http://127.0.0.1:3032 CARE_OWNER_DATABASE_URL=<owner url of a *_test db> bash scripts/curl-test-availability.sh   # Redis-down mode: REDIS_URL unset, base cases only
```

## Cases

| # | Method | Path | Role | Scenario | Expected | Run A (Redis up) | Run B (Redis down) |
|---|--------|------|------|----------|----------|------------------|--------------------|
| 1 | GET | /api/doctors/208/slots | none | unauthenticated | 401 Unauthorized | 401 Unauthorized, PASS | 401 Unauthorized, PASS |
| 2 | GET | /api/doctors/208/slots | doctor | wrong role | 403 Forbidden | 403 Forbidden, PASS | 403 Forbidden, PASS |
| 3 | GET | /api/doctors/208/slots | patient | happy path | 200, four slots, local fields present | 200, PASS | 200, PASS |
| 4 | GET | /api/doctors/208/slots | admin | happy path | 200 | 200, PASS | 200, PASS |
| 5 | GET | /api/doctors/208/slots | patient | `timezone=Invalid/Zone` | 400 ValidationFailed | 400 ValidationFailed, PASS | 400 ValidationFailed, PASS |
| 6 | GET | /api/doctors/208/slots | patient | unknown `typeId` | 404 NotFound | 404 NotFound, PASS | 404 NotFound, PASS |
| 7 | GET | /api/doctors/208/slots | patient | window entirely in the past | 200, empty list | 200, PASS | 200, PASS |
| 8 | GET | /api/doctors/208/slots | admin | doctor not accepting patients (Run A: a cache key for the doctor exists at this moment) | 404 NotFound | 404 NotFound, PASS | 404 NotFound, PASS |
| 9 | GET | /api/doctors/208/slots | patient | (a) first call writes `slots:208:<ver>:<type>:<from>:<to>`; TTL 1..60 | 200, 4 slots, key present, TTL <= 60 | 200, 4 slots, key `slots:208:0:<type>:<date>:<date>`, TTL 59 s, PASS | not run (no Redis) |
| 10 | GET | /api/doctors/208/slots | patient | (a) second identical request | identical body (data and meta) | identical, PASS | not run |
| 11 | GET | /api/doctors/208/slots | patient | (a) cache-hit proof: working hours edited in Postgres behind the cache (no version bump), request again | still 4 slots (served from cache) | 4 slots, PASS | not run |
| 12 | POST then GET | /api/consultations, /api/doctors/208/slots | patient | (b) book the first slot with `Idempotency-Key`, then list again | 201; `slots-ver:208` increments; booked start gone (3 slots) | 201, version 0 -> 1, 3 slots, start absent, PASS | not run |
| 13 | PATCH then GET | /api/consultations/{id}/cancel, /api/doctors/208/slots | patient | (c) cancel the booking with `Idempotency-Key`, then list again | 200; version increments again; start reappears (4 slots) | 200, version 1 -> 2, 4 slots, start listed, PASS | not run |
| 14 | GET | /api/doctors/208/slots | patient, admin | (d) `X-Request-Id` echoed on each call in 9-13 and on an admin cached read | echoed | echoed, PASS | echoed on cases 1-8, PASS |

Case 8 in Run A is the evidence for AV-R9 (the 404 checks run before the cache read): the cached list for a doctor who stopped being bookable was not served.

Run B observation: with Redis unreachable the base cases produce the same answers as with Redis up, no 5xx, and the server logged `availability_cache_unavailable` and `rate_limiter_degraded` warnings only (AV-R12).

Both runs left no `error`-level or 5xx entries in the server logs.

## Failures / notes

- No failing case.
- Script defect found and fixed while extending it: the fixture reset could not delete the booking's consultation rows because `trg_notification_outbox_delete_sent_only` refuses to delete `pending` outbox rows (booking queues two `booking_confirmed` rows; no worker was running). The script now marks that fixture's outbox rows `sent` before deleting them. The first Redis-up run left the user 208 profile and one consultation row behind; they were removed and the second Redis-up run ended with zero 208 rows. `curl-test-consultations.sh` has a similar reset (`DELETE FROM notification_outbox ...`) that was not run here and may hit the same trigger on a database with pending rows; not investigated.
- `audit_logs` rows written by the booking and cancel (ids and statuses only) are left in place: the table is append-only by design and the script does not delete them.
- Cleanup performed by the script on exit: Postgres rows for doctor 208 (consultations, outbox, type, hours, profile) and Redis `slots:208:*`, `slots-ver:208`, `free-map:208`, member 208 of `next-available:index` and `next-available:refresh`. After the final run a scan of Redis db 14 for `*208*` returned nothing.
- The `dist/` build under the repo predates the last edits in `src/app/availability/dto`; this run used `tsx` from source, so rebuild before running the compiled server.
