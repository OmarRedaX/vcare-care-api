---
title: sessions — Manual QA (CURL)
owner: care-team
service: care-service
module: sessions
status: passed
diataxis: how-to
last_verified: 2026-10-15
tags: [manual-qa, sessions, join, start, complete, no-show, waiting-room, calendar, video-port, case-2, rbac, no-store]
related: [sessions-spec, sessions-tasks, sessions-brainstorm, consultations-manual-qa, notifications-manual-qa, consultation-lifecycle, rbac, resilience]
---

# sessions — Manual QA (CURL)

_Run: 2026-10-15 • Server: http://127.0.0.1:3045 (real public app via `scripts/sessions-qa-server.ts`), fake Identity http://127.0.0.1:3023 • Result: 279 pass / 0 fail_

Every endpoint of the module is driven with CURL against the running server: `PATCH /api/consultations/{id}/join|start|complete|no-show`, `GET /api/consultations/waiting-room`, `GET /api/consultations/calendar`. Rows in the `check` method are database / fake-Identity / server-log assertions made with the owner login. Expected values come from `contracts/openapi.yaml` and `docs/sessions/spec.md`, not from "200". All data is synthetic (patients 501-599, doctors 601-699, admins 1 and 2); no token, join token, room id, complaint text or note text is recorded here (the script keeps join tokens only in a temp file to scan the server log, then deletes it).

## Environment
- Disposable database `vcare_care_sessions_qa` on the native Postgres (localhost:5432), migrated (26 migrations) as owner, `ensure-app-login` run; care-api connects as `care_app`. Redis `localhost:6379` db index 11 (flushed before every call; indexes 0, 1 and 9 untouched). Docker not used. The database was dropped afterwards.
- `node scripts/consultations-qa-fake-identity.mjs` (port 3023): JWKS, token minting, `GET /internal/users?ids=` with call log and `healthy|down|hang|slow` modes.
- `VIDEO_FAULT_FILE=<path> npx tsx scripts/sessions-qa-server.ts` (PORT 3045): the real app and routes; only `TOKENS.VideoProvider` is rebound to a wrapper around the fake provider that reads a fault mode (`ok|fail-room|fail-token|slow-room|slow-token`) from the file before each call. This is the only way to inject a provider outage without touching product code; the product code is unchanged. `VIDEO_PROVIDER=fake`, `NODE_ENV=development`, dummy `STORAGE_*` values.
- Run: `CARE_OWNER_DATABASE_URL=… VIDEO_PROVIDER_KEY=… VIDEO_FAULT_FILE=… SERVER_LOG=… QA_REPORT=… bash scripts/curl-test-sessions.sh` (about 18 minutes: the script flushes Redis and spawns node around every call).
- The server uses the real clock, so window boundaries are probed with a 30 s margin on each side (fixtures are owner-SQL rows created relative to the database clock right before each call). The exact millisecond boundaries (`opensAt`, `closesAt - 1 ms`, `closesAt`, `start + grace`) are covered by the unit and integration tests with a fake clock, not here.
- Windows (git-bash) host, Node 24.

## Coverage summary
Authentication (401 none / malformed / expired / service token) on all six routes; role denials (admin on join/start/complete and both doctor views, patient on start/complete/no-show/waiting-room/calendar); ownership (non-participant patient, other doctor, unknown and non-numeric ids all 404); account state from the token (pending patient/doctor, suspended admin); a doctor suspended locally (`suspended_at`) blocked on all six doctor paths while an admin's no-show still works; spoofed `X-User-Id` / `X-Role` ignored; the full lifecycle booked, waiting, in_progress, completed with audit rows, the `doctor_joined` outbox row and join-token binding (signature, user, role, room, expiry capped at window close and 300 s); doctor join on `booked` is token-only; window edges for join, start and the waiting room; terminal states answer `InvalidTransition` before `RoomNotOpen`; `complete` after the window closed; no-show grace edges for doctor and admin, interval release (exclusion constraint), note validation (blank, 1000, 1001, NUL, non-string, unknown member, malformed JSON) and audit `noteLength` only; waiting-room filtering and ordering; calendar window validation, ordering, every status, timezone override, exceptions by doctor-local date; Case 2 with Identity down (cold cache), warm cache, hanging (bounded), one batched call per response, and no Identity call from session writes; video provider outage (room failure before commit leaves state unchanged, token failure after commit leaves a valid state repaired by `join`, slow provider cut at the 2 s bound, other routes unaffected); concurrency (two starts, two joins, start racing a doctor cancel); the join/start rate-limit bucket (10/min then 429 with Retry-After); audit, outbox and server-log hygiene.

## Cases
| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 1 | PATCH | /api/consultations/197/join | none | none | 401 Unauthorized | 401 Unauthorized | PASS |
| 2 | PATCH | /api/consultations/197/start | none | none | 401 Unauthorized | 401 Unauthorized | PASS |
| 3 | PATCH | /api/consultations/197/complete | none | none | 401 Unauthorized | 401 Unauthorized | PASS |
| 4 | PATCH | /api/consultations/197/no-show | none | none | 401 Unauthorized | 401 Unauthorized | PASS |
| 5 | GET | /api/consultations/waiting-room | none | none | 401 Unauthorized | 401 Unauthorized | PASS |
| 6 | GET | /api/consultations/calendar?from=2026-10-15T06:29:41Z&to=2026-10-15T07:29:41Z | none | none | 401 Unauthorized | 401 Unauthorized | PASS |
| 7 | PATCH | /api/consultations/197/join | malformed | malformed | 401 Unauthorized | 401 Unauthorized | PASS |
| 8 | PATCH | /api/consultations/197/start | malformed | malformed | 401 Unauthorized | 401 Unauthorized | PASS |
| 9 | PATCH | /api/consultations/197/complete | malformed | malformed | 401 Unauthorized | 401 Unauthorized | PASS |
| 10 | PATCH | /api/consultations/197/no-show | malformed | malformed | 401 Unauthorized | 401 Unauthorized | PASS |
| 11 | GET | /api/consultations/waiting-room | malformed | malformed | 401 Unauthorized | 401 Unauthorized | PASS |
| 12 | GET | /api/consultations/calendar?from=2026-10-15T06:29:45Z&to=2026-10-15T07:29:45Z | malformed | malformed | 401 Unauthorized | 401 Unauthorized | PASS |
| 13 | PATCH | /api/consultations/197/join | expired | expired | 401 TokenExpired | 401 TokenExpired | PASS |
| 14 | PATCH | /api/consultations/197/start | expired | expired | 401 TokenExpired | 401 TokenExpired | PASS |
| 15 | PATCH | /api/consultations/197/complete | expired | expired | 401 TokenExpired | 401 TokenExpired | PASS |
| 16 | PATCH | /api/consultations/197/no-show | expired | expired | 401 TokenExpired | 401 TokenExpired | PASS |
| 17 | GET | /api/consultations/waiting-room | expired | expired | 401 TokenExpired | 401 TokenExpired | PASS |
| 18 | GET | /api/consultations/calendar?from=2026-10-15T06:29:49Z&to=2026-10-15T07:29:49Z | expired | expired | 401 TokenExpired | 401 TokenExpired | PASS |
| 19 | PATCH | /api/consultations/197/join | service-token | service-token | 401 Unauthorized | 401 Unauthorized | PASS |
| 20 | PATCH | /api/consultations/197/start | service-token | service-token | 401 Unauthorized | 401 Unauthorized | PASS |
| 21 | PATCH | /api/consultations/197/complete | service-token | service-token | 401 Unauthorized | 401 Unauthorized | PASS |
| 22 | PATCH | /api/consultations/197/no-show | service-token | service-token | 401 Unauthorized | 401 Unauthorized | PASS |
| 23 | GET | /api/consultations/waiting-room | service-token | service-token | 401 Unauthorized | 401 Unauthorized | PASS |
| 24 | GET | /api/consultations/calendar?from=2026-10-15T06:29:53Z&to=2026-10-15T07:29:53Z | service-token | service-token | 401 Unauthorized | 401 Unauthorized | PASS |
| 25 | check | auth | owner | unauthenticated calls changed nothing | booked | booked | PASS |
| 26 | PATCH | /api/consultations/197/join | admin | join-denied-admin | 403 Forbidden | 403 Forbidden | PASS |
| 27 | PATCH | /api/consultations/197/start | patient | start-denied-patient | 403 Forbidden | 403 Forbidden | PASS |
| 28 | PATCH | /api/consultations/197/start | admin | start-denied-admin | 403 Forbidden | 403 Forbidden | PASS |
| 29 | PATCH | /api/consultations/197/complete | patient | complete-denied-patient | 403 Forbidden | 403 Forbidden | PASS |
| 30 | PATCH | /api/consultations/197/complete | admin | complete-denied-admin | 403 Forbidden | 403 Forbidden | PASS |
| 31 | PATCH | /api/consultations/197/no-show | patient | no-show-denied-patient | 403 Forbidden | 403 Forbidden | PASS |
| 32 | GET | /api/consultations/waiting-room | patient | waiting-room-denied-patient | 403 Forbidden | 403 Forbidden | PASS |
| 33 | GET | /api/consultations/waiting-room | admin | waiting-room-denied-admin | 403 Forbidden | 403 Forbidden | PASS |
| 34 | GET | /api/consultations/calendar?from=2026-10-15T06:30:03Z&to=2026-10-15T07:30:03Z | patient | calendar-denied-patient | 403 Forbidden | 403 Forbidden | PASS |
| 35 | GET | /api/consultations/calendar?from=2026-10-15T06:30:03Z&to=2026-10-15T07:30:04Z | admin | calendar-denied-admin | 403 Forbidden | 403 Forbidden | PASS |
| 36 | PATCH | /api/consultations/197/join | patient-other | join-non-owner-patient | 404 NotFound | 404 NotFound | PASS |
| 37 | PATCH | /api/consultations/197/join | doctor-other | join-non-assigned-doctor | 404 NotFound | 404 NotFound | PASS |
| 38 | PATCH | /api/consultations/197/start | doctor-other | start-non-assigned-doctor | 404 NotFound | 404 NotFound | PASS |
| 39 | PATCH | /api/consultations/197/complete | doctor-other | complete-non-assigned-doctor | 404 NotFound | 404 NotFound | PASS |
| 40 | PATCH | /api/consultations/197/no-show | doctor-other | no-show-non-assigned-doctor | 404 NotFound | 404 NotFound | PASS |
| 41 | PATCH | /api/consultations/99999999/join | patient | join-bad-id-99999999 | 404 NotFound | 404 NotFound | PASS |
| 42 | PATCH | /api/consultations/99999999/start | doctor | start-bad-id-99999999 | 404 NotFound | 404 NotFound | PASS |
| 43 | PATCH | /api/consultations/99999999/complete | doctor | complete-bad-id-99999999 | 404 NotFound | 404 NotFound | PASS |
| 44 | PATCH | /api/consultations/abc/join | patient | join-bad-id-abc | 404 NotFound | 404 NotFound | PASS |
| 45 | PATCH | /api/consultations/abc/start | doctor | start-bad-id-abc | 404 NotFound | 404 NotFound | PASS |
| 46 | PATCH | /api/consultations/abc/complete | doctor | complete-bad-id-abc | 404 NotFound | 404 NotFound | PASS |
| 47 | PATCH | /api/consultations/0/join | patient | join-bad-id-0 | 404 NotFound | 404 NotFound | PASS |
| 48 | PATCH | /api/consultations/0/start | doctor | start-bad-id-0 | 404 NotFound | 404 NotFound | PASS |
| 49 | PATCH | /api/consultations/0/complete | doctor | complete-bad-id-0 | 404 NotFound | 404 NotFound | PASS |
| 50 | PATCH | /api/consultations/-1/join | patient | join-bad-id--1 | 404 NotFound | 404 NotFound | PASS |
| 51 | PATCH | /api/consultations/-1/start | doctor | start-bad-id--1 | 404 NotFound | 404 NotFound | PASS |
| 52 | PATCH | /api/consultations/-1/complete | doctor | complete-bad-id--1 | 404 NotFound | 404 NotFound | PASS |
| 53 | PATCH | /api/consultations/1.5/join | patient | join-bad-id-1.5 | 404 NotFound | 404 NotFound | PASS |
| 54 | PATCH | /api/consultations/1.5/start | doctor | start-bad-id-1.5 | 404 NotFound | 404 NotFound | PASS |
| 55 | PATCH | /api/consultations/1.5/complete | doctor | complete-bad-id-1.5 | 404 NotFound | 404 NotFound | PASS |
| 56 | PATCH | /api/consultations/99999999999999999999/join | patient | join-bad-id-99999999999999999999 | 404 NotFound | 404 NotFound | PASS |
| 57 | PATCH | /api/consultations/99999999999999999999/start | doctor | start-bad-id-99999999999999999999 | 404 NotFound | 404 NotFound | PASS |
| 58 | PATCH | /api/consultations/99999999999999999999/complete | doctor | complete-bad-id-99999999999999999999 | 404 NotFound | 404 NotFound | PASS |
| 59 | PATCH | /api/consultations/99999999/no-show | doctor | no-show-nonexistent-doctor | 404 NotFound | 404 NotFound | PASS |
| 60 | PATCH | /api/consultations/99999999/no-show | admin | no-show-nonexistent-admin | 404 NotFound | 404 NotFound | PASS |
| 61 | PATCH | /api/consultations/abc/no-show | admin | no-show-non-numeric-admin | 404 NotFound | 404 NotFound | PASS |
| 62 | PATCH | /api/consultations/197/join | patient-pending | join-token-status-pending | 403 Forbidden | 403 Forbidden | PASS |
| 63 | PATCH | /api/consultations/197/start | doctor-pending | start-token-status-pending | 403 Forbidden | 403 Forbidden | PASS |
| 64 | PATCH | /api/consultations/197/complete | doctor-pending | complete-token-status-pending | 403 Forbidden | 403 Forbidden | PASS |
| 65 | PATCH | /api/consultations/197/no-show | doctor-pending | no-show-token-status-pending | 403 Forbidden | 403 Forbidden | PASS |
| 66 | GET | /api/consultations/waiting-room | doctor-pending | waiting-room-token-status-pending | 403 Forbidden | 403 Forbidden | PASS |
| 67 | GET | /api/consultations/calendar?from=2026-10-15T06:30:24Z&to=2026-10-15T07:30:25Z | doctor-pending | calendar-token-status-pending | 403 Forbidden | 403 Forbidden | PASS |
| 68 | PATCH | /api/consultations/197/no-show | admin-suspended | no-show-admin-token-status-suspended | 403 Forbidden | 403 Forbidden | PASS |
| 69 | PATCH | /api/consultations/197/join | patient-other | join-spoofed-X-User-Id-ignored | 404 NotFound | 404 NotFound | PASS |
| 70 | PATCH | /api/consultations/197/start | patient | start-spoofed-X-Role-doctor-ignored | 403 Forbidden | 403 Forbidden | PASS |
| 71 | GET | /api/consultations/197/join | patient | GET on the join path (wrong method) | 404 NotFound | 404 NotFound | PASS |
| 72 | POST | /api/consultations/197/start | doctor | POST on the start path (wrong method) | 404 NotFound | 404 NotFound | PASS |
| 73 | PATCH | /api/consultations/198/join | doctor-suspended | join-locally-suspended-doctor | 403 Forbidden | 403 Forbidden | PASS |
| 74 | PATCH | /api/consultations/198/start | doctor-suspended | start-locally-suspended-doctor | 403 Forbidden | 403 Forbidden | PASS |
| 75 | PATCH | /api/consultations/199/complete | doctor-suspended | complete-locally-suspended-doctor | 403 Forbidden | 403 Forbidden | PASS |
| 76 | PATCH | /api/consultations/200/no-show | doctor-suspended | no-show-locally-suspended-doctor | 403 Forbidden | 403 Forbidden | PASS |
| 77 | GET | /api/consultations/waiting-room | doctor-suspended | waiting-room-locally-suspended-doctor | 403 Forbidden | 403 Forbidden | PASS |
| 78 | GET | /api/consultations/calendar?from=2026-10-15T06:30:33Z&to=2026-10-15T07:30:33Z | doctor-suspended | calendar-locally-suspended-doctor | 403 Forbidden | 403 Forbidden | PASS |
| 79 | PATCH | /api/consultations/198/join | patient | join-patient-of-suspended-doctor-still-allowed | 200 | 200 | PASS |
| 80 | PATCH | /api/consultations/200/no-show | admin | no-show-admin-exempt-from-local-suspension | 200 | 200 | PASS |
| 81 | check | rbac | owner | denied calls changed nothing | booked in_progress | booked in_progress | PASS |
| 82 | check | rbac | owner | no started/completed audit row and no outbox row written by any denied call | 0 | 0 | PASS |
| 83 | PATCH | /api/consultations/201/join | doctor | doctor join on booked: token only, no transition | 200 | 200 | PASS |
| 84 | check | db | owner | doctor join on booked: still booked, joined_at null, room persisted, no audit | booked;;1;0 | booked;;1;0 | PASS |
| 85 | PATCH | /api/consultations/201/join | patient | patient join on booked: booked -> waiting | 200 | 200 | PASS |
| 86 | check | db | owner | patient join: status waiting, joined_at set, room_id set | waiting 1 1 | waiting 1 1 | PASS |
| 87 | check | audit | owner | one consultation.waiting row (actor patient, request id, flat metadata byRole/fromStatus only) | 1 | 1 | PASS |
| 88 | PATCH | /api/consultations/201/join | patient | patient re-join on waiting: fresh token, no transition | 200 | 200 | PASS |
| 89 | PATCH | /api/consultations/201/join | doctor | doctor join on waiting: doctor token | 200 | 200 | PASS |
| 90 | PATCH | /api/consultations/201/join | patient | join ignores a request body | 200 | 200 | PASS |
| 91 | check | audit | owner | re-joins wrote no extra audit row | 1 | 1 | PASS |
| 92 | check | outbox | owner | join queued no notification | 0 | 0 | PASS |
| 93 | PATCH | /api/consultations/201/complete | doctor | complete on waiting | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 94 | PATCH | /api/consultations/201/start | doctor | start waiting -> in_progress | 200 | 200 | PASS |
| 95 | check | db | owner | start: status in_progress, started_at set | in_progress 1 | in_progress 1 | PASS |
| 96 | check | audit | owner | one consultation.started row (doctor, byRole/fromStatus, from waiting) | 1 | 1 | PASS |
| 97 | check | outbox | owner | start queued exactly one doctor_joined row for the patient, pending | 1 501 pending | 1 501 pending | PASS |
| 98 | check | outbox | owner | doctor_joined payload keys are startsAt/endsAt/recipientRole only | 0 | 0 | PASS |
| 99 | PATCH | /api/consultations/201/start | doctor | second start on in_progress | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 100 | check | outbox | owner | second start queued nothing more, wrote no second audit row | 1 1 | 1 1 | PASS |
| 101 | PATCH | /api/consultations/201/join | patient | patient join on in_progress: token only | 200 | 200 | PASS |
| 102 | PATCH | /api/consultations/201/join | doctor | doctor join on in_progress: repair token | 200 | 200 | PASS |
| 103 | PATCH | /api/consultations/201/no-show | doctor | no-show on in_progress | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 104 | PATCH | /api/consultations/201/complete | doctor | complete in_progress -> completed | 200 | 200 | PASS |
| 105 | check | db | owner | complete: status completed, completed_at set, started_at kept | completed 1 1 | completed 1 1 | PASS |
| 106 | check | audit | owner | one consultation.completed row (doctor, byRole only) | 1 | 1 | PASS |
| 107 | PATCH | /api/consultations/201/complete | doctor | complete again on completed | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 108 | PATCH | /api/consultations/201/start | doctor | start on completed | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 109 | PATCH | /api/consultations/201/join | patient | patient join on completed (inside window, terminal wins) | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 110 | PATCH | /api/consultations/201/join | doctor | doctor join on completed | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 111 | PATCH | /api/consultations/201/no-show | admin | admin no-show on completed | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 112 | check | db | owner | terminal row unchanged by every later call | completed | completed | PASS |
| 113 | check | audit | owner | lifecycle audit order: waiting, started, completed | consultation.waiting,consultation.started,consultation.completed | consultation.waiting,consultation.started,consultation.completed | PASS |
| 114 | GET | /api/consultations/201 | admin | get-one never exposes roomId | 200 | 200 | PASS |
| 115 | PATCH | /api/consultations/202/start | doctor | start booked -> in_progress (patient never joined) | 200 | 200 | PASS |
| 116 | check | outbox | owner | start from booked queued doctor_joined once | 1 | 1 | PASS |
| 117 | PATCH | /api/consultations/202/complete | doctor | complete after start from booked | 200 | 200 | PASS |
| 118 | PATCH | /api/consultations/203/complete | doctor | complete on booked | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 119 | check | db | owner | rejected complete changed nothing | booked | booked | PASS |
| 120 | PATCH | /api/consultations/204/join | patient | join 30 s before the window opens | 409 RoomNotOpen | 409 RoomNotOpen | PASS |
| 121 | check | db | owner | RoomNotOpen changed nothing (no room, still booked) | booked 0 | booked 0 | PASS |
| 122 | PATCH | /api/consultations/204/join | doctor | doctor join 30 s before the window opens | 409 RoomNotOpen | 409 RoomNotOpen | PASS |
| 123 | PATCH | /api/consultations/205/join | patient | join 30 s after the window opens | 200 | 200 | PASS |
| 124 | PATCH | /api/consultations/206/join | patient | join 30 s before the window closes | 200 | 200 | PASS |
| 125 | PATCH | /api/consultations/207/join | patient | join 30 s after the window closed | 409 RoomNotOpen | 409 RoomNotOpen | PASS |
| 126 | PATCH | /api/consultations/207/join | doctor | doctor join 30 s after the window closed | 409 RoomNotOpen | 409 RoomNotOpen | PASS |
| 127 | PATCH | /api/consultations/208/join | patient | join terminal completed long after the window: InvalidTransition not RoomNotOpen | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 128 | PATCH | /api/consultations/208/start | doctor | start terminal completed long after the window | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 129 | PATCH | /api/consultations/208/complete | doctor | complete terminal completed | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 130 | PATCH | /api/consultations/208/no-show | doctor | no-show terminal completed | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 131 | PATCH | /api/consultations/209/join | patient | join terminal completed before the window opens: InvalidTransition | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 132 | check | db | owner | terminal completed row unchanged | completed completed | completed completed | PASS |
| 133 | PATCH | /api/consultations/210/join | patient | join terminal cancelled long after the window: InvalidTransition not RoomNotOpen | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 134 | PATCH | /api/consultations/210/start | doctor | start terminal cancelled long after the window | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 135 | PATCH | /api/consultations/210/complete | doctor | complete terminal cancelled | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 136 | PATCH | /api/consultations/210/no-show | doctor | no-show terminal cancelled | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 137 | PATCH | /api/consultations/211/join | patient | join terminal cancelled before the window opens: InvalidTransition | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 138 | check | db | owner | terminal cancelled row unchanged | cancelled cancelled | cancelled cancelled | PASS |
| 139 | PATCH | /api/consultations/212/join | patient | join terminal no_show long after the window: InvalidTransition not RoomNotOpen | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 140 | PATCH | /api/consultations/212/start | doctor | start terminal no_show long after the window | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 141 | PATCH | /api/consultations/212/complete | doctor | complete terminal no_show | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 142 | PATCH | /api/consultations/212/no-show | doctor | no-show terminal no_show | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 143 | PATCH | /api/consultations/213/join | patient | join terminal no_show before the window opens: InvalidTransition | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 144 | check | db | owner | terminal no_show row unchanged | no_show no_show | no_show no_show | PASS |
| 145 | PATCH | /api/consultations/214/start | doctor | start 30 s before the window opens | 409 RoomNotOpen | 409 RoomNotOpen | PASS |
| 146 | check | db | owner | RoomNotOpen start: booked, no outbox | booked 0 | booked 0 | PASS |
| 147 | PATCH | /api/consultations/215/start | doctor | start 30 s after the window opens | 200 | 200 | PASS |
| 148 | PATCH | /api/consultations/216/start | doctor | start 30 s before the window closes | 200 | 200 | PASS |
| 149 | PATCH | /api/consultations/217/start | doctor | start 30 s after the window closed | 409 RoomNotOpen | 409 RoomNotOpen | PASS |
| 150 | PATCH | /api/consultations/218/start | doctor | start on in_progress long outside the window: InvalidTransition | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 151 | PATCH | /api/consultations/218/complete | doctor | complete in_progress long after closesAt (no window check) | 200 | 200 | PASS |
| 152 | PATCH | /api/consultations/219/start | doctor | start waiting after the window closed | 409 RoomNotOpen | 409 RoomNotOpen | PASS |
| 153 | PATCH | /api/consultations/219/join | patient | patient join waiting after the window closed | 409 RoomNotOpen | 409 RoomNotOpen | PASS |
| 154 | PATCH | /api/consultations/220/no-show | doctor | no-show before the start | 409 NoShowTooEarly | 409 NoShowTooEarly | PASS |
| 155 | PATCH | /api/consultations/220/no-show | admin | admin no-show before the start | 409 NoShowTooEarly | 409 NoShowTooEarly | PASS |
| 156 | PATCH | /api/consultations/221/no-show | doctor | no-show 30 s before start + grace | 409 NoShowTooEarly | 409 NoShowTooEarly | PASS |
| 157 | check | db | owner | NoShowTooEarly changed nothing | booked | booked | PASS |
| 158 | PATCH | /api/consultations/221/no-show | admin | admin no-show 30 s before start + grace | 409 NoShowTooEarly | 409 NoShowTooEarly | PASS |
| 159 | check | db | owner | exclusion constraint refuses an overlapping live row | REFUSED | REFUSED | PASS |
| 160 | PATCH | /api/consultations/222/no-show | doctor | doctor no-show 30 s after start + grace (no body) | 200 | 200 | PASS |
| 161 | check | db | owner | no-show: status no_show, no_show_marked_at set | no_show 1 | no_show 1 | PASS |
| 162 | check | audit | owner | one consultation.no_show row (doctor, byRole/fromStatus, no noteLength without a note) | 1 | 1 | PASS |
| 163 | check | outbox | owner | no-show queued no notification | 0 | 0 | PASS |
| 164 | check | db | owner | no-show released the interval: an overlapping live row is now accepted | ok | ok | PASS |
| 165 | PATCH | /api/consultations/222/no-show | doctor | no-show again on no_show | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 166 | PATCH | /api/consultations/222/start | doctor | start on no_show | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 167 | PATCH | /api/consultations/225/no-show | admin | admin no-show on waiting, with note | 200 | 200 | PASS |
| 168 | check | audit | owner | admin no-show audited: actor admin, noteLength only, never the note text | 1 1 0 | 1 1 0 | PASS |
| 169 | check | db | owner | the note is stored nowhere on the row | 0 | 0 | PASS |
| 170 | PATCH | /api/consultations/226/no-show | doctor | no-show body blank-note | 200 | 200 | PASS |
| 171 | check | audit | owner | no noteLength for blank-note | 0 | 0 | PASS |
| 172 | PATCH | /api/consultations/227/no-show | doctor | no-show body empty-note | 200 | 200 | PASS |
| 173 | check | audit | owner | no noteLength for empty-note | 0 | 0 | PASS |
| 174 | PATCH | /api/consultations/228/no-show | doctor | no-show body empty-object | 200 | 200 | PASS |
| 175 | check | audit | owner | no noteLength for empty-object | 0 | 0 | PASS |
| 176 | PATCH | /api/consultations/229/no-show | doctor | no-show note exactly 1000 chars | 200 | 200 | PASS |
| 177 | PATCH | /api/consultations/230/no-show | doctor | no-show note 1001 chars | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 178 | PATCH | /api/consultations/230/no-show | doctor | no-show note with NUL | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 179 | PATCH | /api/consultations/230/no-show | doctor | no-show note not a string | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 180 | PATCH | /api/consultations/230/no-show | doctor | no-show unknown member | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 181 | PATCH | /api/consultations/230/no-show | doctor | no-show malformed JSON | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 182 | check | db | owner | validation failures changed nothing | booked | booked | PASS |
| 183 | PATCH | /api/consultations/231/no-show | admin | admin no-show on booked after grace (zone UTC) | 200 | 200 | PASS |
| 184 | GET | /api/consultations/waiting-room | doctor | waiting room: window rows only, (startsAt,id) order, no complaintText | 200 | 200 | PASS |
| 185 | check | case2 | owner | waiting room used exactly one batched Identity call for the distinct patients | 1 501,502 | 1 501,502 | PASS |
| 186 | check | case2 | owner | the Identity call carried the X-Request-Id of the request | 1 | 1 | PASS |
| 187 | GET | /api/consultations/waiting-room | doctor-other | waiting room of another doctor shows only its own row | 200 | 200 | PASS |
| 188 | GET | /api/consultations/waiting-room?limit=5 | doctor | waiting room: unknown query member | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 189 | GET | /api/consultations/waiting-room?foo=bar | doctor | waiting room: unknown query member foo | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 190 | GET | /api/consultations/waiting-room | doctor | waiting room: 30 s before the window opens | 200 | 200 | PASS |
| 191 | GET | /api/consultations/waiting-room | doctor | waiting room: 30 s after the window opens | 200 | 200 | PASS |
| 192 | GET | /api/consultations/waiting-room | doctor | waiting room: 30 s before the window closes | 200 | 200 | PASS |
| 193 | GET | /api/consultations/waiting-room | doctor | waiting room: 30 s after the window closed | 200 | 200 | PASS |
| 194 | GET | /api/consultations/waiting-room | doctor | waiting room: empty | 200 | 200 | PASS |
| 195 | GET | /api/consultations/waiting-room | doctor | literal route is not captured by GET /consultations/:id | 200 | 200 | PASS |
| 196 | GET | /api/consultations/calendar?from=2026-10-14T06:32:05Z&to=2026-10-17T06:32:05Z | doctor | calendar: every status in the window, own rows only, ordered, no complaintText | 200 | 200 | PASS |
| 197 | check | case2 | owner | calendar used exactly one batched Identity call for the distinct patients | 1 501,502 | 1 501,502 | PASS |
| 198 | GET | /api/consultations/calendar?from=2026-10-14T06:32:05Z&to=2026-10-17T06:32:05Z&timezone=Asia/Tokyo | doctor | calendar: timezone override renders from/to in that zone | 200 | 200 | PASS |
| 199 | GET | /api/consultations/calendar?from=2026-10-15T06:32:07Z&to=2026-10-22T06:32:07Z | doctor | calendar: window of exactly 7 days is allowed | 200 | 200 | PASS |
| 200 | GET | /api/consultations/calendar?from=2026-10-15T06:32:07Z&to=2026-10-22T06:32:08Z | doctor | calendar: 7 days + 1 s | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 201 | GET | /api/consultations/calendar?from=2026-10-15T07:32:08Z&to=2026-10-15T06:32:08Z | doctor | calendar: from after to | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 202 | GET | /api/consultations/calendar?from=2030-01-01T00:00:00Z&to=2030-01-01T00:00:00Z | doctor | calendar: from equals to | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 203 | GET | /api/consultations/calendar?to=2026-10-17T06:32:05Z | doctor | calendar: from missing | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 204 | GET | /api/consultations/calendar?from=2026-10-14T06:32:05Z | doctor | calendar: to missing | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 205 | GET | /api/consultations/calendar | doctor | calendar: no query | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 206 | GET | /api/consultations/calendar?from=2030-01-01T00:00:00&to=2030-01-02T00:00:00 | doctor | calendar: from/to without offset | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 207 | GET | /api/consultations/calendar?from=2030-01-01&to=2030-01-02 | doctor | calendar: date-only | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 208 | GET | /api/consultations/calendar?from=garbage&to=garbage | doctor | calendar: garbage instants | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 209 | GET | /api/consultations/calendar?from=2026-10-14T06:32:05Z&to=2026-10-17T06:32:05Z&timezone=Mars/Olympus | doctor | calendar: invalid timezone | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 210 | GET | /api/consultations/calendar?from=2026-10-14T06:32:05Z&to=2026-10-17T06:32:05Z&foo=bar | doctor | calendar: unknown query member | 400 ValidationFailed | 400 ValidationFailed | PASS |
| 211 | GET | /api/consultations/calendar?from=2026-10-15T05:32:15Z&to=2026-10-15T08:32:15Z | doctor-other | calendar of another doctor shows only its own row | 200 | 200 | PASS |
| 212 | GET | /api/consultations/calendar?from=2030-03-01T00:00:00%2B02:00&to=2030-03-02T00:00:00%2B02:00 | doctor | calendar: from/to with +02:00 offset | 200 | 200 | PASS |
| 213 | POST | /api/doctors/me/exceptions | doctor-604 | setup: day-off exception tomorrow (Berlin) | 201 | 201 | PASS |
| 214 | GET | /api/consultations/calendar?from=2026-10-15T05:32:17Z&to=2026-10-18T06:32:17Z | doctor-604 | calendar: exception listed by doctor-local date, default zone is the doctor zone | 200 | 200 | PASS |
| 215 | GET | /api/consultations/calendar?from=2026-10-15T05:32:17Z&to=2026-10-18T06:32:18Z&timezone=Pacific/Kiritimati | doctor-604 | calendar: override zone does not move the exception date | 200 | 200 | PASS |
| 216 | GET | /api/consultations/calendar?from=2026-10-22T06:32:18Z&to=2026-10-23T06:32:18Z | doctor-604 | calendar: window beyond the exception shows none | 200 | 200 | PASS |
| 217 | GET | /api/consultations/waiting-room | doctor | waiting room with Identity down (cold cache): 200, unhydrated | 200 | 200 | PASS |
| 218 | GET | /api/consultations/calendar?from=2026-10-14T06:32:21Z&to=2026-10-16T06:32:21Z | doctor | calendar with Identity down (cold cache): 200, unhydrated | 200 | 200 | PASS |
| 219 | GET | /api/consultations/waiting-room | doctor | waiting room with Identity healthy again: hydrated | 200 | 200 | PASS |
| 220 | GET | /api/consultations/waiting-room | doctor | waiting room with Identity down but cache warm: cached names served | 200 | 200 | PASS |
| 221 | GET | /api/consultations/waiting-room | doctor | waiting room with Identity hanging (cold cache): 200 after the client timeout | 200 | 200 | PASS |
| 222 | check | case2 | owner | hanging Identity bounded the read (under 10 s, not hung) | ok | ok | PASS |
| 223 | PATCH | /api/consultations/251/join | patient | join with Identity down | 200 | 200 | PASS |
| 224 | PATCH | /api/consultations/251/start | doctor | start with Identity down | 200 | 200 | PASS |
| 225 | PATCH | /api/consultations/251/complete | doctor | complete with Identity down | 200 | 200 | PASS |
| 226 | check | case2 | owner | join/start/complete made no Identity call (no batch, no status PATCH) | 0 0 | 0 0 | PASS |
| 227 | PATCH | /api/consultations/253/join | patient | join, provider fails creating the room | 503 VideoUnavailable | 503 VideoUnavailable | PASS |
| 228 | check | db | owner | room failure before commit: nothing changed (booked, no joined_at, no room, no audit) | booked 0 0 0 | booked 0 0 0 | PASS |
| 229 | PATCH | /api/consultations/253/join | doctor | doctor join on booked, provider fails creating the room | 503 VideoUnavailable | 503 VideoUnavailable | PASS |
| 230 | PATCH | /api/consultations/253/start | doctor | start, provider fails creating the room | 503 VideoUnavailable | 503 VideoUnavailable | PASS |
| 231 | check | db | owner | room failure on start before commit: still booked, no doctor_joined, no audit | booked 0 0 | booked 0 0 | PASS |
| 232 | PATCH | /api/consultations/253/join | patient | join, provider fails issuing the token (after commit) | 503 VideoUnavailable | 503 VideoUnavailable | PASS |
| 233 | check | db | owner | token failure after commit: patient is waiting, audit written once | waiting 1 | waiting 1 | PASS |
| 234 | PATCH | /api/consultations/253/join | patient | repeat join after recovery: token, no second transition | 200 | 200 | PASS |
| 235 | check | audit | owner | repair join wrote no second waiting row | 1 | 1 | PASS |
| 236 | PATCH | /api/consultations/253/start | doctor | start, provider fails issuing the token (after commit) | 503 VideoUnavailable | 503 VideoUnavailable | PASS |
| 237 | check | db | owner | token failure on start: in_progress committed, doctor_joined queued once, audit once | in_progress 1 1 | in_progress 1 1 | PASS |
| 238 | PATCH | /api/consultations/253/join | doctor | doctor repairs the start token with join | 200 | 200 | PASS |
| 239 | PATCH | /api/consultations/253/start | doctor | start again after the repair | 409 InvalidTransition | 409 InvalidTransition | PASS |
| 240 | PATCH | /api/consultations/253/complete | doctor | complete is unaffected by a provider outage | 200 | 200 | PASS |
| 241 | GET | /api/consultations/waiting-room | doctor | waiting room is unaffected by a provider outage | 200 | 200 | PASS |
| 242 | PATCH | /api/consultations/254/no-show | doctor | no-show is unaffected by a provider outage | 200 | 200 | PASS |
| 243 | PATCH | /api/consultations/255/join | patient | join, provider slower than 2 s creating the room | 503 VideoUnavailable | 503 VideoUnavailable | PASS |
| 244 | check | video | owner | slow provider was cut near the 2 s bound (under 5 s) and left the row booked | ok booked | ok booked | PASS |
| 245 | PATCH | /api/consultations/255/start | doctor | start, provider slower than 2 s issuing the token | 503 VideoUnavailable | 503 VideoUnavailable | PASS |
| 246 | check | db | owner | slow token on start: in_progress committed | in_progress | in_progress | PASS |
| 247 | PATCH | /api/consultations/255/join | doctor | join after the slow outage recovers | 200 | 200 | PASS |
| 248 | check | log | owner | video_provider_failed logged with a code only (operation + code=qa_injected or timeout, no token) | ok | ok | PASS |
| 249 | check | concurrency | owner | two simultaneous start calls: exactly one 200 and one 409 | 200 409  | 200 409  | PASS |
| 250 | check | concurrency | owner | the loser is InvalidTransition; one outbox row; one audit row; in_progress | InvalidTransition 1 1 in_progress | InvalidTransition 1 1 in_progress | PASS |
| 251 | check | concurrency | owner | two simultaneous patient joins: both 200 (second is token-only), one waiting audit row | 200 200 1 waiting | 200 200 1 waiting | PASS |
| 252 | check | concurrency | owner | start racing a doctor cancel: exactly one wins, the loser is 409, state matches the winner | ok | ok | PASS |
| 253 | check | concurrency | owner | a cancelled consultation never has a doctor_joined row without a start | ok | ok | PASS |
| 254 | PATCH | /api/consultations/259/join | patient | join rate limit call 1 of 10 | 200 | 200 | PASS |
| 255 | PATCH | /api/consultations/259/join | patient | join rate limit call 2 of 10 | 200 | 200 | PASS |
| 256 | PATCH | /api/consultations/259/join | patient | join rate limit call 3 of 10 | 200 | 200 | PASS |
| 257 | PATCH | /api/consultations/259/join | patient | join rate limit call 4 of 10 | 200 | 200 | PASS |
| 258 | PATCH | /api/consultations/259/join | patient | join rate limit call 5 of 10 | 200 | 200 | PASS |
| 259 | PATCH | /api/consultations/259/join | patient | join rate limit call 6 of 10 | 200 | 200 | PASS |
| 260 | PATCH | /api/consultations/259/join | patient | join rate limit call 7 of 10 | 200 | 200 | PASS |
| 261 | PATCH | /api/consultations/259/join | patient | join rate limit call 8 of 10 | 200 | 200 | PASS |
| 262 | PATCH | /api/consultations/259/join | patient | join rate limit call 9 of 10 | 200 | 200 | PASS |
| 263 | PATCH | /api/consultations/259/join | patient | join rate limit call 10 of 10 | 200 | 200 | PASS |
| 264 | PATCH | /api/consultations/259/join | patient | join rate limit: 11th call within a minute | 429 RateLimited | 429 RateLimited | PASS |
| 265 | check | ratelimit | owner | 429 carries Retry-After | 1 | 1 | PASS |
| 266 | PATCH | /api/consultations/259/start | doctor | start has its own bucket per user (doctor not yet limited) | 200 | 200 | PASS |
| 267 | check | audit | owner | every session audit row carries only flat scalar metadata keys from the allowlist | 0 | 0 | PASS |
| 268 | check | audit | owner | no audit row holds a token, room id or marker | 0 | 0 | PASS |
| 269 | check | outbox | owner | no outbox payload holds a token or room id | 0 | 0 | PASS |
| 270 | check | audit | owner | session routes wrote no audit row for the two read views | 0 | 0 | PASS |
| 271 | check | log | owner | captured log is non-trivial | 1 | 1 | PASS |
| 272 | check | log | owner | no issued join token appears in the server log | 0 | 0 | PASS |
| 273 | check | log | owner | tokens were actually captured for the scan | 1 | 1 | PASS |
| 274 | check | log | owner | no 'QA-COMPLAINT-MARKER-7731' in the server log | 0 | 0 | PASS |
| 275 | check | log | owner | no 'QA-NOTE-MARKER-9921' in the server log | 0 | 0 | PASS |
| 276 | check | log | owner | no 'fake-room-' in the server log | 0 | 0 | PASS |
| 277 | check | log | owner | no 'Bearer ' in the server log | 0 | 0 | PASS |
| 278 | check | log | owner | no 'joinToken":"' in the server log | 0 | 0 | PASS |
| 279 | check | log | owner | no 'synthetic-video-provider-key' in the server log | 0 | 0 | PASS |

## Failures / notes
- No product failure: every case matches the spec and the contract.
- Observation (not counted, spec/contract wording): `PATCH /api/consultations/{id}/join` with a body that is malformed JSON and `Content-Type: application/json` answers `400 ValidationFailed` from the global body parser, although the spec says a sent body "is ignored" and the contract lists no `400` for join/start/complete. A valid JSON body of any shape and a non-JSON content type are ignored (200). Reproduction: `curl -X PATCH -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data-binary '{"x":' $BASE/api/consultations/$ID/join` on an open-window booked row. Suggested handling: either document the `400` on those three operations or accept it as platform-wide parser behaviour.
- Script/harness issues fixed while writing this run (not product failures): `isoz` with a negative offset was parsed by node as an option; fixture teardown has to `TRUNCATE notification_outbox` because a trigger allows deleting only `sent` outbox rows; an earlier draft of the calendar assertion lost its regex backslashes; the `got` for the log-token scan printed twice when grep found nothing.
- Not exercised by CURL (needs a controllable clock or a real provider): millisecond-exact window boundaries, stale `in_progress` rows past `closesAt` (known follow-up in spec section 10), a real video provider (none exists yet), and the 429 on the `complete`/`no-show` write buckets (same limiter factory as the booking writes, covered in the consultations QA).
