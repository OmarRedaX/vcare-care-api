---
title: sessions — Spec
owner: care-team
service: care-service
module: sessions
status: ready
version: 0.1.0
diataxis: reference
last_verified: 2026-10-15
tags: [spec, sessions, lifecycle, join, start, complete, no-show, waiting-room, calendar, video-port, case-2]
related: [sessions-brainstorm, consultations-spec, schedules-spec, notifications-spec, consultation-lifecycle, data-model, rbac, integration, resilience, infrastructure, adr-0011-notification-outbox-and-reminders, adr-0017-generic-helpers-and-transaction-scoping]
contracts: [contracts/openapi.yaml]
---

# sessions — Spec

Second half of the consultation lifecycle: **join, start, complete, no-show**, the doctor's **waiting room** and **calendar**, and the
provider-neutral **video port** (`lib/video`) with a deterministic fake adapter. Scope follows [brainstorm.md](./brainstorm.md)
(decisions S-D1..S-D9, binding; its three open questions resolved as recommended: leave stale `in_progress` rows, no auto no-show, real
provider deferred). No new table and no migration: every column used already exists in `consultations`.

Binding rules: CLAUDE.md → "Database rules", "API conventions", "Authentication and service-to-service auth", "Authorization — RBAC and
ownership", "Security rules" (Video), "Privacy and logging", "Cross-service integration" (Case 2), "Domain rules" 9, 11, 12, 17-19, "Testing policy",
"Performance rules". Precedent: [consultations/spec.md](../consultations/spec.md) (read it first; this spec reuses its names).

---

## 1. Overview

### 1.1 What `sessions` owns
| Area | Delivers |
|---|---|
| Tables | none (no migration). Reads/writes `consultations` columns `room_id`, `joined_at`, `started_at`, `completed_at`, `no_show_marked_at`, `status` |
| Routes | `PATCH /api/consultations/{id}/join` · `/start` · `/complete` · `/no-show` · `GET /api/consultations/waiting-room` · `GET /api/consultations/calendar` |
| Module | `src/app/sessions/` (router mounted **before** the consultations router, section 3.2) |
| Lib | `src/lib/video/` (port + fake adapter + error), `lib/identity-client/hydrate.ts` (extracted degrade wrapper, section 3.7) |
| Cross-module service API added | `consultations`: `ConsultationRowsService` (row access for other modules); `schedules`: `SchedulesService.listExceptionsForCalendar` |
| Ports used | `ConsultationChangeListener` (two new kinds), `NotificationsService.enqueue` (`doctor_joined`, kind already allowed by `chk_notification_outbox_kind`) |
| Env | `NO_SHOW_GRACE_MINUTES` (10), `WAITING_ROOM_OPEN_MINUTES` (10), `SESSION_OVERRUN_MINUTES` (15), `VIDEO_PROVIDER`, `VIDEO_PROVIDER_KEY`, `VIDEO_JOIN_TOKEN_TTL_SECONDS` (300) |

### 1.2 Principles
- **State first, provider second, token last.** The transaction that changes `status` never contains a provider call (CLAUDE.md → Transactions). The room is created *before* the transaction (idempotent per consultation), the join token is issued *after* commit. A provider failure before commit leaves state unchanged; one after commit leaves a valid state the client repairs by calling `join` again (section 3.6).
- **The status guard is the guarantee.** Every transition is `UPDATE … WHERE id AND status = ANY($from) AND deleted_at IS NULL` (`applyTransition`, Domain rule 9); the service checks are a courtesy and give the precise error.
- **Session responses carry no clinical text.** `complaintText` is never in a session response (join/start/complete/no-show/waiting-room/calendar) for any viewer: the doctor reads it through the audited get-one. This keeps unaudited re-joins from becoming unaudited clinical reads.
- **Tokens are per participant, short-lived, never stored, never logged** (`joinToken` is already in `REDACTED_KEYS`). Session routes are not behind the idempotency middleware, so a token is never held in Redis.
- **Doctors are blocked immediately** when locally suspended (`doctor_not_suspended` check), not at token expiry.

### 1.3 Dependencies
- **Modules (services only):** `consultations` (`ConsultationRowsService`, shared pure `view.ts` + `ConsultationResponseDto`), `doctors` (`isLocallySuspended`, `findTimezone`), `schedules` (`listExceptionsForCalendar`), `notifications` (`enqueue`), `audit` (`AuditRecorder`).
- **Other service:** identity-service, **Case 2 only** (patient hydration on waiting-room and calendar, degrade). No Case 1, 3, 4 call; session writes make **no** Identity call.
- **External:** video room provider behind `lib/video` (fake adapter only in this unit, S-D1).

### 1.4 Contract drift check (against `contracts/openapi.yaml`, 2026-10-15)
Operations `joinConsultation`, `startConsultation`, `completeConsultation`, `markNoShow`, `getWaitingRoom`, `getCalendar`; schemas `SessionJoin`, `NoShow`, `CalendarView`; responses `SessionJoinOk`, `SessionConflict`, `ConsultationOk`, `InvalidTransition`, `NoShowConflict`. Roles, paths, status codes, schema shapes and field names match. **No shape changes.** Description-level clarifications and one added response (each a numbered edit in section 11):

| # | Finding | Contract today | This spec |
|---|---|---|---|
| V1 | A video-provider outage on join/start has no response | none | `503 VideoUnavailable` (new code, new response `VideoUnavailable` on join and start); state unchanged or repairable (3.6) |
| V2 | Window boundaries | closed `[starts_at − 10 min, ends_at + 15 min]` | **half-open** `opensAt <= now < closesAt`, so a token issued inside the window always has a positive life |
| V3 | Check order is unstated | "terminal → InvalidTransition", "outside window → RoomNotOpen" | terminal (and for `start`, any status other than `booked`/`waiting`) wins over the window; see 3.6 |
| V4 | Doctor `join` on `booked` | silent | token, no transition, no audit (S-D2) |
| V5 | `complaintText` on session responses | `ConsultationOk`: "own write responses" carry it | absent on join/start/complete/no-show (1.2); participants unhydrated (as for other write responses) |
| V6 | `no-show` `note` | free text, optional | not stored; audit holds `noteLength` only; body optional (absent body = `{}`); blank allowed |
| V7 | Suspended doctor | `x-account-state` says "not locally suspended" | `403 Forbidden` on join/start/complete/waiting-room/calendar and on no-show **for the doctor** (admin exempt) |
| V8 | Calendar `from`/`to` | `date-time`, window at most 7 days | semantics `[from, to)`, `from < to` and `to − from <= 7 days` else `400 ValidationFailed`; `CalendarView.from/to` echo the same instants rendered in `timezone`; `exceptions[].date` is the doctor-local date |
| V9 | Waiting-room window | closed | half-open as V2 |

### 1.5 Decisions folded in (brainstorm S-D1..S-D9 plus spec-level decisions; owner may override)
S-D1..S-D9 apply verbatim except the interpretations below.
1. **S-D5 note handling.** The brainstorm says the `note` goes to audit metadata "as a reason, treated like a cancel reason". Cancel reasons are stored on the row and audited as `reasonLength` only. `consultations` has no column for a no-show note and no migration is wanted, so the note is **not stored** and audit metadata holds `noteLength` only. Free text never enters audit (CLAUDE.md → Privacy and logging).
2. **S-D8 limiter.** "Booking-write limiter class" = same 10/min/user limit, but its **own bucket** (`consultations-session-user`) for join and start, so reconnecting never consumes booking writes. `complete` and `no-show` use the existing write buckets (`consultations-write-user` 10/min patient/doctor, `consultations-write-admin` 60/min).
3. **Window half-open** (V2).
4. **Session responses omit `complaintText`** (V5).
5. **Provider failure code** `VideoUnavailable` 503 (V1). CLAUDE.md lists 503 for health and `IdentityUnavailable`; this adds one dependency-down code in the same family.
6. **Listener kinds.** `ConsultationChangeKind` gains `Completed` and `NoShow` (S-D4 says terminal exits notify). Only `NoShow` frees a slot; discovery may ignore `Completed`.
7. **Stale `in_progress`** (D-R8 of consultations): unchanged. `upcoming`/`past` list scopes are not touched; a doctor who is locally suspended cannot complete an `in_progress` consultation and no admin route exits it (follow-up, section 10).
8. **No new migration** (all columns and the `idx_consultations_doctor_user_id_starts_at_id` index exist; section 2).

---

## 2. Database schema

**No table, column, constraint, index or migration is added.** Verified against `20261011130000_create_consultations`:
- Columns written: `status`, `room_id VARCHAR(128)`, `joined_at`, `started_at`, `completed_at`, `no_show_marked_at` (all nullable `TIMESTAMPTZ`), `updated_at`. Soft delete: every read keeps `deleted_at IS NULL`.
- Grants: `vcare_app` already holds `SELECT, INSERT, UPDATE` on `consultations`; no `DELETE` needed.
- `excl_consultations_doctor_no_overlap` is unaffected by `waiting`/`in_progress`/`completed` updates (same interval, still in the `WHERE` set) and releases the interval on `no_show` (status leaves the set). No `23P01` can arise from these routes.
- Indexes used (no new one; each existing index serves the query named):

| Index | Serves |
|---|---|
| PK `consultations_pkey` | `findByIdForUpdate`, ownership resolvers `isParticipant` / `isAssignedDoctor`, `applyTransition`, `setRoomIfAbsent` |
| `idx_consultations_doctor_user_id_starts_at_id (doctor_user_id, starts_at, id) WHERE deleted_at IS NULL` | waiting-room query and calendar query (equality on doctor, range on `starts_at`, order `(starts_at, id)`) |

- `consultation_types` is joined by primary key for `type_name` (as in the other reads).
- `tests/integration/sessions-explain.test.ts` asserts both read queries use the doctor index with no seq scan (section 8).

---

## 3. API contract and file-level design

### 3.1 Endpoints (the contract wins on disagreement)
Common: `userGuard()` → `authorize(policy)` → limiter → controller. **No `Idempotency-Key`** on any of the six (the contract declares none; the status guard makes a retry safe: repeating start/complete/no-show returns `409 InvalidTransition`, repeating join reissues a token). `Cache-Control: no-store` comes from the existing `/api/consultations` prefix. Non-numeric `{id}` → `404 NotFound` (ownership `deny-not-found`). Identity headers ignored.

| | `PATCH /consultations/{id}/join` | `PATCH /consultations/{id}/start` | `PATCH /consultations/{id}/complete` |
|---|---|---|---|
| Guard | user | user | user |
| Roles | patient, doctor | doctor | doctor |
| Ownership | resolver `consultation_participant` (patient owns the row or the assigned doctor); others `404` | resolver `consultation_assigned_doctor`; other doctors `404` | same |
| Account state | `status=active`; doctor also `doctor_not_suspended` (`403 Forbidden`) | `status=active` + `doctor_not_suspended` | same |
| Audit | `consultation.waiting` on the `booked → waiting` transition only | `consultation.started` | `consultation.completed` |
| Rate limit | `consultations-session-user` 10/min per patient/doctor | same bucket | `consultations-write-user` 10/min |
| Body | none (a body, if sent, is ignored) | none | none |
| Success | `200` `SessionJoin` | `200` `SessionJoin` (doctor token) | `200` `Consultation` |
| Errors | 401, 403, 404, 409 (`InvalidTransition`, `RoomNotOpen`), 429, 500, **503 `VideoUnavailable` (V1)** | same | 401, 403, 404, 409 `InvalidTransition`, 429, 500 |

| | `PATCH /consultations/{id}/no-show` | `GET /consultations/waiting-room` | `GET /consultations/calendar` |
|---|---|---|---|
| Roles | doctor, admin | doctor | doctor |
| Ownership | resolver `consultation_assigned_doctor_or_admin` (admin passes without a query; the service answers `404` for an unknown id); other doctors/patient-role denied by role (`403`) | `self` (rows filtered by `doctor_user_id := auth.userId`, never from input) | `self` |
| Account state | `status=active`; doctor also `doctor_not_suspended`; **admin exempt** | `status=active` + `doctor_not_suspended` | same |
| Audit | `consultation.no_show` (policy class `admin-action`) | none (no clinical field; rows are the doctor's own, no `complaintText`) | none |
| Rate limit | `consultations-write-user` / `consultations-write-admin` (existing `writeLimits()`) | `consultations-read-user` 120/min | same |
| Body / query | optional body `NoShow` `{ note? }` | none (unknown query members rejected) | `from`, `to` required; `timezone` optional |
| Success | `200` `Consultation` | `200` array of `Consultation`, no `meta` (not paginated) | `200` `CalendarView` |
| Errors | 400, 401, 403, 404, 409 (`NoShowTooEarly`, `InvalidTransition`), 429, 500 | 401, 403, 429, 500 | 400, 401, 403, 429, 500 |

**Request rules (class-validator, `forbidNonWhitelisted`, implicit conversion off):**
- `NoShowDto`: `note` optional `@IsString`, `CodePointLength(0, 1000)`, `NoControlCharacters("nul")`. An absent body (`undefined`) is treated as `{}` by the controller; unknown properties → `400`. No `@NotBlank` (contract has no `minLength`).
- `CalendarQueryDto`: `from`, `to` required `IsIsoDateTimeWithOffset`; `timezone` optional `IsIanaTimezone` (≤ 64), canonicalized with `canonicalIanaTimezone`. Service-level (before any query): `from >= to` → `400` (`details[].field = from`, the existing `TimeRangeReversed`); `to − from > 7 days` → `400` (`details[].field = to`, issue "window is at most 7 days"). Exactly 7 days is allowed.
- `WaitingRoomQueryDto`: empty (any query member → `400`).
- Join/start/complete take no DTO; the controller never reads `req.body`.

**Response shapes**
- `SessionJoin` (`SessionJoinResponseDto`): `{ consultation, roomId, joinToken, joinTokenExpiresAt, windowOpensAt, windowClosesAt }`. `consultation` = `ConsultationResponseDto.from(entity, viewer, view)` with `view = buildConsultationView(entity, viewer, { timezone: undefined, doctorTimezone }, new Map(), false)`: both participants `{ userId, displayName: null, avatarUrl: null, profileHydrated: false }`, `complaintText` absent, zone defaults patient → `patientTimezone`, doctor → the doctor's zone. `windowOpensAt = startsAt − WAITING_ROOM_OPEN_MINUTES`, `windowClosesAt = endsAt + SESSION_OVERRUN_MINUTES`, UTC ISO `Z`. `joinTokenExpiresAt = min(now + VIDEO_JOIN_TOKEN_TTL_SECONDS, windowClosesAt)`, from the provider result.
- `complete` / `no-show`: `ConsultationResponseDto` built the same way (`SessionQueriesService.renderOwn`). Admin no-show: zone `UTC`.
- Waiting room: `Consultation[]` ordered `(startsAt, id)` ascending; patient hydrated (Case 2), doctor side unhydrated own side; `complaintText` absent.
- Calendar: `CalendarView { from, to, timezone, consultations[], exceptions[] }`; `consultations` in `(startsAt, id)` order, every status, patient hydrated, no `complaintText`; `exceptions` via `ScheduleExceptionResponseDto.from`. `timezone` = query value canonical, else the doctor's profile zone; `from`/`to` echoed as `toIsoInZone(ms, timezone)`.
- Never emitted: `room_id` outside `SessionJoin.roomId`, the idempotency columns, reminder marks, `no_show_marked_at`, `cancelled_by_user_id`.

### 3.2 Route composition (`src/app/sessions/routes.ts`)
```ts
router.get  ("/consultations/waiting-room", userGuard(), authorize(p.waitingRoom), readLimit(),    c.waitingRoom);
router.get  ("/consultations/calendar",     userGuard(), authorize(p.calendar),    readLimit(),    c.calendar);
router.patch("/consultations/:id/join",     userGuard(), authorize(p.join),        sessionLimit(), c.join);
router.patch("/consultations/:id/start",    userGuard(), authorize(p.start),       sessionLimit(), c.start);
router.patch("/consultations/:id/complete", userGuard(), authorize(p.complete),    ...writeLimits(), c.complete);
router.patch("/consultations/:id/no-show",  userGuard(), authorize(p.noShow),      ...writeLimits(), c.noShow);
return sealRouter(router);
```
`src/routes.ts`: `router.use(buildSessionsRouter())` goes **immediately before** `router.use(buildConsultationsRouter())`, with a comment that the literals `waiting-room`/`calendar` must precede `GET /consultations/:id`. `consultations/routes.ts` only drops its "reserved slot" comment. The boot assertion (`assertRoutesAuthorized`) covers the new router. `limits` are built from the same constants as `consultations/routes.ts`; to avoid copying, `writeLimits()` and `readLimit()` move to `src/app/consultations/rate-limits.ts` (exported, consumed by both routers).

### 3.3 File list
```
src/app/sessions/
  constants.ts   enums.ts   errors.ts   types.ts   policies.ts   routes.ts
  dto/sessions.request.dto.ts   dto/sessions.response.dto.ts
  service/sessions.service.ts            join / start / complete / noShow
  service/session-queries.service.ts     waitingRoom / calendar / renderOwn (+ Case 2)
  controller/sessions.controller.ts
src/app/consultations/
  rate-limits.ts                         shared limiter factories
  service/consultation-rows.service.ts   row access for other modules (3.5)
src/lib/video/
  types.ts   video-error.ts   fake-video.adapter.ts   create-video-provider.ts
src/lib/identity-client/hydrate.ts       hydrateUsersOrEmpty (3.7)
src/pkg/utils/session-window.ts          sessionWindow(startsAtMs, endsAtMs, openMinutes, overrunMinutes) — pure
```
Edited: `consultations/repository/consultations.repo.ts` (new functions, `TransitionChanges`), `consultations/enums.ts` (`ConsultationChangeKind.Completed|NoShow`, `ConsultationAuditAction.Waiting|Started|Completed|NoShow`), `consultations/types.ts` (`TransitionChanges` fields, `ConsultationChangeKind`), `consultations/service/consultation-queries.service.ts` (private `hydrate` replaced by the lib helper, behavior-preserving), `schedules/service/schedules.service.ts` (+ `listExceptionsForCalendar`), `notifications` (none: `doctor_joined` payload keys `startsAt`, `endsAt`, `recipientRole` are in `OUTBOX_PAYLOAD_KEYS`), `lib/config/env.ts` + `types.ts`, `lib/di/tokens.ts` (`VideoProvider`, `SessionsService`, `SessionQueriesService`, `SessionsController`, `ConsultationRowsService`), `bootstrap.ts`, `src/routes.ts`, `.env.example`, `tests/setup.ts` env fixture, `docker-compose`/quickstart env lists.

### 3.4 Entity
No new entity. `Consultation` (existing) already has `roomId`, `joinedAt`, `startedAt`, `completedAt`, `noShowMarkedAt`. `SessionJoinResult` (types.ts): `{ consultation: Consultation; roomId: string; joinToken: string; joinTokenExpiresAt: Date; windowOpensAt: Date; windowClosesAt: Date }`.

### 3.5 Repository additions (`consultations.repo.ts`; functions, `conn: Knex = db`, explicit columns, `deleted_at IS NULL`)
- `TransitionChanges` gains `room_id?: string; joined_at?: Date; started_at?: Date; completed_at?: Date; no_show_marked_at?: Date`. `applyTransition` is reused unchanged.
- `setRoomIfAbsent(id, roomId, trx): Promise<boolean>` — `UPDATE consultations SET room_id = $2 WHERE id = $1 AND room_id IS NULL AND status IN ('booked','waiting','in_progress') AND deleted_at IS NULL` (does not touch `updated_at`: no business change). Used by a doctor's token-only join on `booked`.
- `isAssignedDoctor(id, userId, conn)` — `SELECT id … WHERE id AND doctor_user_id AND deleted_at IS NULL LIMIT 1` (resolver).
- `listWaitingRoomQuery(params, conn)` (exported for EXPLAIN) / `listWaitingRoom`: `joined(conn, QUALIFIED_LIST_COLUMNS)` `WHERE doctor_user_id = $d AND status IN ('booked','waiting') AND deleted_at IS NULL AND starts_at <= $now + openMinutes AND starts_at >= $now − (MAX_DURATION_MINUTES + overrunMinutes) AND ends_at + overrun > $now ORDER BY starts_at, id LIMIT 100` (`ends_at + overrun > now` is applied as `ends_at > $now − overrunMinutes`; the `starts_at` bounds are only the sargable range, as in `upcoming`). `LIMIT 100` is a defensive cap: live rows do not overlap and the shortest type is 5 minutes, so the real set is at most ~53 rows.
- `listCalendarQuery(doctorUserId, fromMs, toMs, conn)` / `listCalendar`: `QUALIFIED_LIST_COLUMNS` `WHERE doctor_user_id = $d AND deleted_at IS NULL AND starts_at < $to AND ends_at > $from AND starts_at >= $from − MAX_DURATION_MINUTES ORDER BY starts_at, id LIMIT 1000` (all statuses; cancelled and no-show rows can overlap, hence the cap; reaching it logs `calendar_truncated` with counts only).

`ConsultationRowsService` (`@injectable()`, in `consultations/service/`, thin, no rules): `find(id, conn)`, `lockForUpdate(id, trx)`, `transition(row, from, to, changes, trx)`, `setRoomIfAbsent(…)`, `isParticipant(id, userId)`, `isAssignedDoctor(id, userId)`, `listWaitingRoom(…)`, `listCalendar(…)`. This is how `sessions` reaches the table without importing a foreign repository (same pattern as `DoctorsService.lockBookingTarget(userId, trx)`).

### 3.6 Services

**Window math (`pkg/utils/session-window.ts`, pure):** `sessionWindow(startsAtMs, endsAtMs, openMinutes, overrunMinutes) → { opensAtMs, closesAtMs }`; `isInsideWindow(w, nowMs) = w.opensAtMs <= nowMs && nowMs < w.closesAtMs`.

**`SessionsService`** (`@injectable()`; deps `Db, AuditRecorder, Env, Logger, Clock, ConsultationRowsService, NotificationsService, ConsultationChangeListener, VideoProvider`). One `now = clock.now()` per request.

`join(actor, id)`:
1. `row = rows.find(id)`; absent, or actor is not the patient/assigned doctor → `404 NotFound` (defence in depth behind the resolver).
2. Terminal (`completed`/`cancelled`/`no_show`) → `409 InvalidTransition`. Then `!isInsideWindow` → `409 RoomNotOpen`.
3. `roomId = row.roomId ?? await ensureRoom(row)` — a provider call **outside any transaction**, bounded by `VIDEO_CALL_TIMEOUT_MS` (2000, `settleWithin`); failure/timeout → `503 VideoUnavailable`, no state changed. Skipped when the row already has a room.
4. **Transition case** (patient, `status = booked`): one transaction: `lockForUpdate` → re-check terminal/window against the locked row with the same `now` (a reschedule may have moved it) → `transition(row, [booked], waiting, { joined_at: now, ...(row.roomId === null ? { room_id: roomId } : {}) })`; zero rows → `409 InvalidTransition`; `audit.record` `consultation.waiting` `{ byRole: 'patient', fromStatus: 'booked' }`. After commit: no listener (the busy interval is unchanged).
5. **Token-only cases** (any participant on `waiting`/`in_progress`; a doctor on `booked`): no transition, no audit, no outbox. If `row.roomId === null` (doctor on `booked` before any room existed) a one-statement `setRoomIfAbsent` persists the room (the stored value wins if a concurrent call set one: re-read and use it).
6. After commit: `issueJoinToken({ roomId, userId, role, expiresAtMs: min(now + TTL, closesAtMs) })` bounded by the same timeout; failure → `503 VideoUnavailable`. State stays valid (a patient is `waiting`); repeating `join` yields a token without a transition.
7. Return `SessionJoinResult`.

`start(actor, id)`:
1. `find`; absent or `doctorUserId !== actor.userId` → `404`.
2. `status ∉ {booked, waiting}` → `409 InvalidTransition` (terminal and `in_progress`; a second `start` never re-notifies). Then `!isInsideWindow` → `409 RoomNotOpen`.
3. `ensureRoom` as in `join`.
4. One transaction: `lockForUpdate` → re-check status/window → `transition(row, [booked, waiting], in_progress, { started_at: now, room_id? })` (zero rows → `InvalidTransition`) → `notifications.enqueue(trx, [{ kind: DoctorJoined, consultationId, recipientUserId: patientUserId, payload: { startsAt, endsAt, recipientRole: 'patient' } }])` → `audit.record` `consultation.started` `{ byRole: 'doctor', fromStatus }`.
5. After commit: `issueJoinToken` as doctor (failure → `503`; the consultation is already `in_progress` and the notice queued; the doctor repairs it with `join`, which returns a token on `in_progress`).
6. Return `SessionJoinResult`.

`complete(actor, id)`: `find` (absent / not assigned → `404`); transaction: `lockForUpdate` → `status !== in_progress` → `409 InvalidTransition` → `transition(row, [in_progress], completed, { completed_at: now })` (zero rows → `InvalidTransition`) → audit `consultation.completed` `{ byRole: 'doctor' }`. **No window check** (the doctor may overrun). After commit: listener `Completed`. Returns the entity.

`noShow(actor, id, input)`:
1. `find`; absent → `404`; doctor not assigned → `404`; admin allowed.
2. `status ∉ {booked, waiting}` → `409 InvalidTransition`. Then `now < startsAtMs + NO_SHOW_GRACE_MINUTES` → `409 NoShowTooEarly` (exactly `start + grace` is allowed).
3. Transaction: `lockForUpdate` → re-check both → `transition(row, [booked, waiting], no_show, { no_show_marked_at: now })` → audit `consultation.no_show` `{ byRole, fromStatus, noteLength? }` (`noteLength` only when the note is non-blank). No outbox row (no no-show notification kind exists).
4. After commit: listener `NoShow` (the interval is released). Returns the entity.

After-commit listener calls go through the same guarded helper as `ConsultationsService.notifyChanged` (failure logged without data, never thrown); the helper moves to `ConsultationRowsService.notifyChanged(kind, consultation)` so both services share one copy.

**`SessionQueriesService`** (deps `Db, Clock, Env, Logger, IdentityClient, ConsultationRowsService, DoctorsService, SchedulesService`):
- `waitingRoom(actor)`: `doctorTimezone = doctors.findTimezone(actor.userId)`; one `listWaitingRoom`; one `hydrateUsersOrEmpty(identity, logger, distinct patient ids)` (Case 2); render each with `buildConsultationView(c, viewer, ctx, users, false)`.
- `calendar(actor, query)`: validate range; `{ timezone: doctorTz, exceptions } = schedules.listExceptionsForCalendar(actor.userId, fromMs, toMs, db)`; one `listCalendar`; one batched hydrate; render with `timezone = query.timezone ?? doctorTz`; `CalendarView`. Total: owner lookup 1 + exceptions 1 + consultations 1 + 1 Identity batch.
- `renderOwn(actor, consultation)`: unhydrated participants, `detail = false`, doctor zone from `findTimezone`.

**`SchedulesService.listExceptionsForCalendar(doctorUserId, fromMs, toMs, conn)`** → `{ timezone, exceptions: ScheduleException[] }`: `owners.find(doctorUserId, conn)` (absent → `NotFound`); `fromDate = localDateOf(fromMs, tz)`, `toDate = localDateOf(toMs − 1, tz)`; `listExceptionsInRange(profileId, fromDate, toDate, conn)` (live rows only, ordered by date). Exceptions are keyed by doctor-local date regardless of the render timezone.

### 3.7 `lib` additions
- **`lib/video/types.ts`**: `VideoRoomProvider { ensureRoom(input: EnsureRoomInput): Promise<VideoRoom>; issueJoinToken(input: JoinTokenInput): Promise<VideoJoinToken> }`; `EnsureRoomInput { consultationId: number; startsAtMs: number; endsAtMs: number }`; `VideoRoom { roomId: string }` (≤ 128 chars); `JoinTokenInput { roomId: string; userId: number; role: "patient" | "doctor"; expiresAtMs: number }`; `VideoJoinToken { token: string; expiresAtMs: number }`. `ensureRoom` is idempotent per `consultationId`.
- **`lib/video/video-error.ts`**: `VideoProviderError` (carries a safe `code` only; never the provider body, token or URL).
- **`lib/video/fake-video.adapter.ts`** (S-D1): `FakeVideoProvider(secret)`: `roomId = "fake-room-" + consultationId`; token = `base64url(JSON{rid,uid,role,exp}) + "." + base64url(HMAC-SHA256(secret, payload))` via `node:crypto` (no new dependency). Exported `verifyFakeJoinToken(token, secret, nowMs)` for tests (binding to room, user, role; expiry).
- **`lib/video/create-video-provider.ts`**: `createVideoProvider(env)`: `VIDEO_PROVIDER=fake` → `FakeVideoProvider(env.VIDEO_PROVIDER_KEY)`; `NODE_ENV=production` with `fake` → throws at boot (S-D1). Registered in `bootstrap.ts` as `TOKENS.VideoProvider`. Tests bind their own stub (success, slow, failing) because the provider is system-external.
- **`lib/identity-client/hydrate.ts`**: `hydrateUsersOrEmpty(identity, logger, ids): Promise<Map<number, HydratedUser>>` — the existing `try { getUsersBatch } catch { warn; empty }` currently private in `ConsultationQueriesService`; `sessions` is its second caller, so it moves here (ADR 0017) and `consultations` is repointed with no behavior change.
- **Env** (`lib/config/env.ts`, zod, `types.ts`): `NO_SHOW_GRACE_MINUTES` int 0..1440 default 10; `WAITING_ROOM_OPEN_MINUTES` int 0..240 default 10; `SESSION_OVERRUN_MINUTES` int 0..240 default 15; `VIDEO_PROVIDER` `z.enum(["fake"])` **no default**; `VIDEO_PROVIDER_KEY` `z.string().min(32)` **no default, secret**; `VIDEO_JOIN_TOKEN_TTL_SECONDS` int 30..3600 default 300. `VIDEO_PROVIDER_URL` is not added (a real adapter's unit declares it). Consequence: every existing env fixture (`tests/setup.ts`, `.env.example`, compose, quickstart, CI) must set the two required variables.

### 3.8 Policies (`policies.ts`, `buildSessionsPolicies(doctors, rows)`)
| Route | Policy |
|---|---|
| `join` | roles `[patient, doctor]`, owner resolver `consultation_participant` (`rows.isParticipant`), `checks: [doctorNotSuspendedCheck(doctors)]` |
| `start` | roles `[doctor]`, resolver `consultation_assigned_doctor`, `checks: [doctorNotSuspendedCheck]` |
| `complete` | same as `start` |
| `noShow` | roles `[doctor, admin]`, resolver `consultation_assigned_doctor_or_admin` (admin → allow; doctor → `rows.isAssignedDoctor`), `checks: [doctorNotSuspendedCheck]` (applies to doctors only), `audit: "admin-action"` |
| `waitingRoom`, `calendar` | roles `[doctor]`, owner `{ kind: "self" }`, `checks: [doctorNotSuspendedCheck]` |

Resolvers return `deny-not-found` for a non-numeric id (`parsePositiveId`). Wrong role (admin on join/start/complete, patient on start/complete/no-show/waiting-room/calendar, doctor-only routes for a patient) is `403 Forbidden` at the role step.

### 3.9 Controller, DI, errors
- `SessionsController` arrow methods only: validate → service → render → `sendSuccess`. `join`/`start` map `SessionJoinResult` to `SessionJoinResponseDto` (`joinTokenExpiresAt`, `windowOpensAt`, `windowClosesAt` as UTC ISO). `noShow` passes `{ note }` from `NoShowDto` (absent body → `{}`).
- `errors.ts`: `RoomNotOpen` (409, "The session room is not open"), `NoShowTooEarly` (409, "A no-show can be marked only after the grace period"), `VideoUnavailable` (503, "The video service is temporarily unavailable"); `InvalidTransition` reused from `consultations/errors`.
- `bootstrap.ts` registration order: `VideoProvider` (factory), `ConsultationRowsService`, `SessionsService`, `SessionQueriesService`, `SessionsController`. Only `bootstrap.ts` wires `app/` into the container.
- `constants.ts`: `SESSION_ENTITY_TYPE` (reuses `CONSULTATION_ENTITY_TYPE`), `SESSION_RATE_NAME = "consultations-session-user"`, `SESSION_USER_LIMIT = 10`, `VIDEO_CALL_TIMEOUT_MS = 2000`, `WAITING_ROOM_MAX_ENTRIES = 100`, `CALENDAR_MAX_ENTRIES = 1000`, `CALENDAR_MAX_WINDOW_DAYS = 7`.
- `enums.ts`: `SessionAuditAction` is folded into `ConsultationAuditAction` (`Waiting = "consultation.waiting"`, `Started = "consultation.started"`, `Completed = "consultation.completed"`, `NoShow = "consultation.no_show"`) so the audit action list has one home.

---

## 4. Business rules

| # | Rule | Enforced by |
|---|---|---|
| SS-R1 | The session window is `opensAt = startsAt − WAITING_ROOM_OPEN_MINUTES <= now < closesAt = endsAt + SESSION_OVERRUN_MINUTES`; `join` and `start` outside it → `409 RoomNotOpen` | service (`pkg/utils/session-window`), re-checked under the row lock |
| SS-R2 | Terminal states never change; every transition is `WHERE status = ANY($from)`; zero rows → `409 InvalidTransition` | `applyTransition` + service |
| SS-R3 | Check order: not found/not participant (404) → status (`InvalidTransition`) → window (`RoomNotOpen`) / grace (`NoShowTooEarly`); a terminal row always answers `InvalidTransition`, never `RoomNotOpen` | service |
| SS-R4 | Patient `join` on `booked` → `waiting`, sets `joined_at`, audit `consultation.waiting`; on `waiting`/`in_progress` only a fresh token, no audit | service |
| SS-R5 | A doctor `join` on `booked` returns a token without transition or audit; the doctor's transition is `start` | service |
| SS-R6 | `start` only from `booked`/`waiting`, by the assigned doctor, inside the window; sets `started_at`; a second `start` on `in_progress` is `InvalidTransition` and queues nothing | service + status guard |
| SS-R7 | `start` queues exactly one `doctor_joined` outbox row (to the patient) in the same transaction as the transition and its audit row; payload holds `startsAt`, `endsAt`, `recipientRole` only | transaction + `NotificationsService` key allowlist |
| SS-R8 | `complete` only from `in_progress`, by the assigned doctor, with no window check; sets `completed_at` | service + status guard |
| SS-R9 | `no-show` only from `booked`/`waiting`, by the assigned doctor or any admin, once `now >= startsAt + NO_SHOW_GRACE_MINUTES`; sets `no_show_marked_at`; releases the doctor's interval | service + `chk`-guarded update + exclusion `WHERE` set |
| SS-R10 | A room is created at most once per consultation (`ensureRoom` idempotent) and persisted in `room_id` (first value wins); no room is created for a terminal or out-of-window consultation | service ordering (3 before 4) + `room_id IS NULL` guard |
| SS-R11 | A join token is bound to one room, user and role, expires at `min(now + TTL, closesAt)`, and is issued only inside the window | provider port + service |
| SS-R12 | A provider failure before commit changes no state; after commit the state stays valid and the client repairs it by calling `join`; both answer `503 VideoUnavailable` | service ordering |
| SS-R13 | Patients may only join; only the assigned doctor starts/completes; admins may only mark no-show (never join/start/complete); non-participants get `404`, wrong roles `403` | `authorize` roles + resolvers + service |
| SS-R14 | A locally suspended doctor is blocked on join, start, complete, no-show, waiting-room and calendar immediately; an admin's no-show is exempt | `doctor_not_suspended` check |
| SS-R15 | Every status change writes one audit row in the same transaction; token-only joins write none; metadata holds ids, roles, statuses, `noteLength` — never the note, tokens, room keys or names | service + `AuditRecorder` |
| SS-R16 | Session responses never contain `complaintText`; admin responses never contain clinical fields; no URLs | response DTO / view |
| SS-R17 | Waiting room = the caller's `booked`/`waiting` rows whose session window contains now, ordered by `(startsAt, id)`, not paginated, at most 100 | repository query |
| SS-R18 | Calendar window `[from, to)`: `from < to` and at most 7 days else `400`; includes every status overlapping the window plus the doctor's live exceptions for the doctor-local dates covering it | service + repository |
| SS-R19 | Waiting room and calendar hydrate patients with one batched Identity call; an Identity failure never fails the read (`profileHydrated:false`) | Case 2 helper |
| SS-R20 | After commit, `complete` and `no-show` notify the change listener; its failure is logged without data and never fails the write | service |
| SS-R21 | Session writes make no Identity call and are not behind the idempotency middleware | design |
| SS-R22 | The fake provider is refused when `NODE_ENV=production` | `createVideoProvider` |

---

## 5. Cross-service behavior
- **Case 2 (degrade)** on `GET /consultations/waiting-room` and `GET /consultations/calendar`: one `getUsersBatch` per response for the distinct patient ids (client chunks above 100), Redis `identity:user:<id>` TTL 300 s, at most one retry, `identity_hydration_degraded` emitted by the client. `fullName → displayName`; `status` unused. Outage: rows, times and exceptions are still returned with `displayName:null, avatarUrl:null, profileHydrated:false`; never a 5xx.
- **Video provider (must succeed to hand out a token, but never corrupts state):** 2 s bound per call, no retry inside the request (the client retries `join`). Resilience row "Video provider: join/start fail cleanly; lifecycle state unchanged on failure" is refined by SS-R12: before commit unchanged; after commit repairable. Outage → `503 VideoUnavailable`, `video_provider_failed` log event (code only), counter derived from the log (ADR 0007).
- No Case 1, 3, 4 call. Recipient emails for `doctor_joined` are resolved by the delivery worker at send time (hub ADR 0010).
- Platform changes: none.

## 6. Error codes
| Code | HTTP | When |
|---|---|---|
| `ValidationFailed` | 400 | calendar `from`/`to` missing, not ISO with offset, `from >= to`, window over 7 days, bad `timezone`; `note` too long / NUL / unknown property; any query member on waiting-room |
| `Unauthorized` / `TokenExpired` | 401 | token problems |
| `Forbidden` | 403 | wrong role (admin on join/start/complete, patient on doctor routes), non-active account, locally suspended doctor |
| `NotFound` | 404 | unknown, deleted or invisible consultation (non-participant, other doctor, non-numeric id) |
| `InvalidTransition` | 409 | terminal row; `start` on `in_progress`; `complete` on anything but `in_progress`; `no-show` on anything but `booked`/`waiting`; racing transition (zero rows) |
| `RoomNotOpen` | 409 | `join`/`start` outside the half-open session window on a non-terminal row |
| `NoShowTooEarly` | 409 | `no-show` before `startsAt + NO_SHOW_GRACE_MINUTES` |
| `RateLimited` | 429 | session (10/min), write (10/min patient/doctor, 60/min admin) or read (120/min) limiter |
| `VideoUnavailable` | 503 | **new (V1)**: room creation or token issuance failed or exceeded 2 s on join/start |
| `InternalError` | 500 | unhandled |

New code: `VideoUnavailable` only (none of the existing codes fits a provider outage; section 11, V1).

## 7. Security & privacy
- **RBAC summary:** join = participant patient or doctor; start/complete = assigned doctor; no-show = assigned doctor or admin; waiting-room, calendar = the doctor themself. Deny-by-default `authorize` on all six; admin denied on join/start/complete and on both doctor views; patients denied everything except `join`.
- **Audit:** `consultation.waiting`, `.started`, `.completed`, `.no_show` (entity type `consultation`); metadata flat scalars `{ byRole, fromStatus }` (+ `noteLength` on no-show). Never the note, tokens, room ids, complaint text, names. Token-only joins and the two read views write no audit row (no clinical field is returned).
- **Never logged:** `joinToken` (already redacted), the VIDEO key, the note text, `complaintText`, patient names/avatars. Log lines carry ids, statuses, `code` of a provider failure. Responses to join/start carry `Cache-Control: no-store` (prefix rule).
- **Token handling:** per participant, `min(TTL, window)` life, not stored server-side, not behind Redis idempotency, never in audit/outbox.
- **Rate limits:** join+start 10/min/user (bounds token minting, S-D8); complete/no-show 10/min patient/doctor and 60/min admin; waiting-room and calendar 120/min/user.
- **Existence:** a non-participant never learns an id exists (404); a wrong-role caller gets 403 before any lookup.
- **Files:** not applicable.

## 8. Performance
Budgets: calendar/day view p95 < 200 ms; session writes target p95 < 150 ms excluding the provider call.
- **join (transition):** find 1 + [ensureRoom] + tx (lock 1, update 1, audit 1) + [issue token]; **join (token-only):** find 1 (+ one `setRoomIfAbsent` for a doctor on `booked` with no room); **start:** find 1 + tx (lock, update, outbox insert, audit); **complete:** find 1 + tx (lock, update, audit); **no-show:** same. Resolver adds one PK lookup.
- **waiting-room:** doctor timezone 1 + rows 1 + Identity batch 1; **calendar:** owner 1 + exceptions 1 + rows 1 + Identity batch 1 (no N+1; chunks ≤ 100).
- Index coverage (section 2): both read queries use `idx_consultations_doctor_user_id_starts_at_id`; everything else is a primary-key access. EXPLAIN assertions for `listWaitingRoomQuery` and `listCalendarQuery` (no seq scan, doctor index), a calendar timing guard (7 days, 300 rows, fake Identity) < 200 ms.

## 9. Test plan outline
**Unit** (`tests/unit/`, fake `TOKENS.Clock`, mocked rows/notifications/audit/provider/identity):
- `session-window`: opens inclusive, closes exclusive, `open=0`, DST-irrelevant (UTC instants), `closes` after overrun.
- `sessions.service`: SS-R1..SS-R12 and SS-R14 each with its error code and the check order (404 → status → window; terminal beats window; `start` on `in_progress` is `InvalidTransition` even outside the window); patient `booked` join transitions and audits; re-join on `waiting`/`in_progress` is token-only; doctor join on `booked` is token-only; exact boundaries (`opensAt`, `closesAt − 1 ms`, `closesAt`); no-show at `start + grace − 1 ms` / `start + grace`; `ensureRoom` skipped when `room_id` exists and not called for terminal/out-of-window; provider failure before commit leaves no transition, after commit the transition persists and `503` is returned; token expiry `min(TTL, closes)`; zero-row `applyTransition` → `InvalidTransition`; `doctor_joined` row built once with allowlisted payload; audit metadata has no note text (`noteLength` only); listener failure swallowed, `Completed`/`NoShow` kinds emitted.
- `session-queries.service`: waiting-room and calendar rendering (zones, unhydrated own side, `complaintText` absent), calendar validation (equal, reversed, 7 d ok, 7 d + 1 ms `400`, bad zone), exceptions by doctor-local date across a DST day, Identity failure → `profileHydrated:false`, truncation log at 1000.
- Policies: roles, resolvers (non-numeric id, other doctor, admin pass for no-show), `doctor_not_suspended` applies to doctors only.
- DTOs: `NoShowDto` table (absent, `{}`, blank, 1000, 1001, NUL, unknown key), `CalendarQueryDto`, response DTO viewer matrix.
- `lib/video`: fake provider determinism, token binds room/user/role, `verifyFakeJoinToken` rejects tampered/expired/other-user tokens, `createVideoProvider` refuses `fake` in production; env tests for the six variables (missing key/provider fail boot, key length).
- `hydrateUsersOrEmpty` (success, throw → empty + warn) and the repointed consultations call.
- Redaction: `joinToken` row already present; add a log-capture test that no token string appears.

**Integration** (`tests/integration/sessions.test.ts`, real Postgres/Redis, fake Identity, stub provider with success/slow/failing modes, fixtures approve a doctor and book via the real routes with a fake clock):
- Lifecycle: booked → join (patient) → waiting → start → in_progress → complete → completed, timestamps, `status`, audit rows (4) in order; `doctor_joined` outbox row exists once; second `start` is `409` with no second row.
- Windows: join/start at `opensAt − 1 ms` → `409 RoomNotOpen`, at `opensAt` ok; at `closesAt − 1 ms` ok, at `closesAt` → `RoomNotOpen`; terminal rows answer `InvalidTransition` out of window; `complete` after `closesAt` succeeds.
- No-show: before grace `NoShowTooEarly`; doctor and admin after grace succeed; the interval is released (same slot books again); on `in_progress`/terminal `InvalidTransition`; admin note recorded as `noteLength` only.
- Concurrency: two simultaneous `start` calls → exactly one `200`, one `409 InvalidTransition`, one outbox row; `start` racing a patient `cancel` → exactly one wins; `join` racing a reschedule re-validates the window under the lock.
- RBAC per route (wrong role `403`, admin `403` on join/start/complete and on both views, non-participant and other doctor `404`, owner allowed, patient `403` on waiting-room/calendar), locally suspended doctor `403` on all six doctor paths while an admin no-show still works; account state `pending` doctor `403`.
- Tokens: bound to the caller's user and role (`verifyFakeJoinToken`), expiry capped at the window close, a doctor token never works for the patient; no token in logs, audit metadata, outbox payload or Redis keys.
- Video outage: failing provider → `503 VideoUnavailable` and no transition (before commit); token-issue failure after commit → `503`, status already `waiting`/`in_progress`, repeat `join` → `200` token; slow provider (> 2 s) → `503`.
- Case 2: waiting room and calendar with Identity down → `200`, `profileHydrated:false`; one `getUsersBatch` request per response (fake counts); calendar exceptions for a blocked day appear with the doctor-local date; render `timezone` default and override.
- Calendar: window bounds (7 d ok, over `400`, reversed `400`), cancelled/no-show rows present, rows outside the window absent, another doctor's rows absent, order `(startsAt, id)`.
- Waiting room: only `booked`/`waiting` inside the window, `in_progress`/terminal excluded, order.
- Routing: `GET /consultations/waiting-room` and `/calendar` are not captured by `GET /consultations/:id`.
- Contract conformance (`tests/unit/contract/sessions-contract.test.ts`): status codes, error codes and shapes for the six operations (including the added `503` response). EXPLAIN assertions and the calendar timing guard (section 8). `no-store` header on every response. Log hygiene: no `note`, token or complaint fixtures in captured logs.

## 10. Out of scope
A real video provider adapter and its ADR (and `VIDEO_PROVIDER_URL`); records (`records` module is blocked on this unit and now unblocked); prescriptions, chat, recording; auto no-show, auto-complete, or a worker sweep of stale `in_progress` rows (follow-up issue; a locally suspended doctor's `in_progress` consultation cannot be completed and no admin route exits it, so such rows stay flagged in the follow-up queue until a later unit adds an admin/doctor exit); `GET /consultations?scope` treatment of `in_progress` past `endsAt` (D-R8 unchanged); reminders and email delivery (done in `notifications`); a `no_show` notification kind; storing the no-show note; doctor-initiated follow-up booking; slot/next-available cache implementation (discovery fills the listener).

## 11. Open questions
No undecided design question remains. Pending actions follow.

**Contract changes required** (edit `contracts/openapi.yaml` first, before code; no shape change):
- **V1** `joinConsultation`, `startConsultation`: add response `'503'` `VideoUnavailable` (new component response with an `ErrorEnvelope` example) and list the code; add `VideoUnavailable` to the error-code description where codes are enumerated. CLAUDE.md → "Error codes owned by Care" gains the row `VideoUnavailable | 503 | video provider failed or timed out on join/start`, and its status-code line "503 dependency down (health only)" is widened accordingly (owner edit; this spec does not edit CLAUDE.md).
- **V2** `joinConsultation`, `startConsultation`, `getWaitingRoom`: window is half-open `opensAt <= now < closesAt`.
- **V3** `joinConsultation`, `startConsultation`: check order (terminal and, for `start`, any status other than `booked`/`waiting` → `InvalidTransition` before `RoomNotOpen`; `start` on `in_progress` is `InvalidTransition`).
- **V4** `joinConsultation`: a doctor on `booked` receives a token without a transition or audit row.
- **V5** `startConsultation`, `joinConsultation`, `completeConsultation`, `markNoShow`, `getWaitingRoom`, `getCalendar`, `Consultation`: session responses omit `complaintText` and carry unhydrated participants (write responses) / hydrated patient (waiting-room, calendar).
- **V6** `markNoShow`: `note` is not stored (audit keeps its length only); body optional; admins are exempt from the local-suspension check.
- **V7** `joinConsultation`, `startConsultation`, `completeConsultation`, `getWaitingRoom`, `getCalendar`: locally suspended doctor → `403 Forbidden`.
- **V8** `getCalendar`: `[from, to)`, `from < to`, at most 7 days inclusive, echo of `from`/`to` in `timezone`, `exceptions[].date` doctor-local.
- **V9** `getCalendar` / `getWaitingRoom`: order `(startsAt, id)`; waiting-room capped at 100 entries.

**Platform changes required (/system-design):** none. (The deployment shard already lists the video provider as an outbound dependency; production cannot boot until a real adapter replaces the fake, which is the deferred provider unit.)

**Docs to refresh at `/update-docs`:** `architecture/consultation-lifecycle.md` (as-built session section, half-open window, check order), `api.md`, `rbac.md` (six routes), `infrastructure.md` (env variables move from "Planned" to declared; `VIDEO_PROVIDER` added, `VIDEO_PROVIDER_URL` stays planned), `resilience.md` (video row refined by SS-R12), `overview.md` (module row), `integration.md`, `consultations/spec.md` (new `ConsultationChangeKind` members, shared `notifyChanged`, `rate-limits.ts`, D-R8 still open), `docs/service-card.md` (**affected**: new endpoints, `lib/video` dependency, env), `docs/INDEX.md`.

## 12. Task ordering (CLAUDE.md → Build order for a new module)
0. Contract edits V1-V9.
1. Generic additions with unit tests: `lib/identity-client/hydrate.ts` (and repoint consultations), `pkg/utils/session-window.ts`, `consultations/rate-limits.ts`.
2. Env additions (+ fixtures, `.env.example`, quickstart); `lib/video` (types, error, fake adapter, factory) with tests.
3. (No migration.) `enums.ts`, `errors.ts`, `types.ts`, `constants.ts` of `sessions`; consultations enum/type additions.
4. Repository functions and `ConsultationRowsService`; `SchedulesService.listExceptionsForCalendar`.
5. Request/response DTOs.
6. `SessionsService`, `SessionQueriesService`; DI tokens and `bootstrap.ts`.
7. `policies.ts`; controller; `routes.ts`; mount before the consultations router.
8. Tests (unit, integration, RBAC, contract, concurrency, EXPLAIN, log hygiene).
9. Manual QA with CURL (`scripts/curl-test-sessions.sh`, fake Identity reused), docs (section 11 list).
