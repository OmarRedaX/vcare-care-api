---
title: sessions — Brainstorm
owner: care-team
service: care-service
module: sessions
status: draft
diataxis: explanation
last_verified: 2026-10-15
tags: [brainstorm, sessions, video, waiting-room, calendar, lifecycle]
related: [consultation-lifecycle, consultations-brainstorm, data-model, rbac, integration]
---

# sessions — Brainstorm

Scope decided 2026-10-15 (branch `feature/sessions`, issue #42, from `main` @ 38538b2). Fourth lifecycle slice after
patients → consultations → notifications. The contract already defines the whole surface (`contracts/openapi.yaml`:
`joinConsultation`, `startConsultation`, `completeConsultation`, `markNoShow`, `getWaitingRoom`, `getCalendar`, schemas
`SessionJoin`, `CalendarView`, `NoShow`), so this brief decides slicing and behaviour, not shapes. Nothing reaches
`completed` without this unit; `records` is blocked on it.

## Problem & purpose
PRD 7.7 (waiting room and session start), 7.8 (complete), 7.6 (no-show) and Domain rules 9, 11, 12. The `consultations`
unit built the status enum, the CHECKs and the generic `applyTransition` guard (`WHERE id AND status = ANY($from) AND
deleted_at IS NULL`); `sessions` adds the routes, the session-window rule, the video port and the two doctor read views.

## Actors
- **Patient** (active): `join` own consultation (booked → waiting), re-join for a fresh token.
- **Doctor** (active, not locally suspended): `join` (re-join or token), `start`, `complete`, `no-show` on own consultations; `waiting-room`, `calendar`.
- **Admin**: `no-show` only (reason in `note`, audited as admin-action). No join, no start, no complete, never clinical fields.

## In scope
- `PATCH /api/consultations/{id}/join|start|complete|no-show`, `GET /api/consultations/waiting-room`, `GET /api/consultations/calendar` (literal paths registered before `/{id}`).
- Session window `[starts_at − WAITING_ROOM_OPEN_MINUTES, ends_at + SESSION_OVERRUN_MINUTES]` for join/start (`RoomNotOpen`); no-show grace `NO_SHOW_GRACE_MINUTES` (`NoShowTooEarly`).
- `lib/video`: `VideoRoomProvider` port (`ensureRoom`, `issueJoinToken`) plus a deterministic fake adapter; `room_id` created lazily on first join/start and persisted on the row.
- Audit rows in the same transaction (`consultation.waiting|started|completed|no_show`); `doctor_joined` outbox row in the `start` transaction (the kind already exists, ADR 0011).
- Slot/next-available cache invalidation through the existing `ConsultationChangeListener` seam after commit on terminal exits.
- Case 2 hydration (degrade) of the patient on waiting-room and calendar; schedule exceptions in the calendar via the `schedules` service.
- Migration only if a column is missing (`room_id`, `joined_at`, `started_at`, `completed_at`, `no_show_marked_at` are already in `consultations`).

## Out of scope
- A real video provider adapter (LiveKit/Daily/…): needs a provider ADR and, where it adds a package, a dependency ADR. The port is provider-neutral.
- Records (`records` module), prescriptions, chat, recording of sessions.
- Auto no-show, auto-complete, or stale `in_progress` sweeping (see Open questions).
- Reminders and email delivery (done in `notifications`).

## Decisions (taken by the author; owner may override)
- **S-D1** Video: port + deterministic fake adapter only (owner decision 2026-10-15). `VIDEO_PROVIDER_KEY` stays a required secret with no default in `env.ts`; the fake signs join tokens (HMAC over `roomId`, `userId`, `role`, `exp`) so tests assert per-participant binding and TTL (`VIDEO_JOIN_TOKEN_TTL_SECONDS=300`, capped at the window close). The fake is selected by `VIDEO_PROVIDER=fake`; a production boot with `fake` is refused unless `NODE_ENV!=production`.
- **S-D2** Join semantics follow the contract: patient on `booked` → `waiting` (sets `joined_at`); a participant on `waiting`/`in_progress` gets a fresh token with no transition and no audit row; a doctor on `booked` gets a token with no transition (the doctor's transition is `start`); terminal → `409 InvalidTransition`; outside the window `409 RoomNotOpen` (checked before the transition guard, but terminal wins over window).
- **S-D3** `start` from `booked` or `waiting`, inside the window; sets `started_at`; returns the doctor token; queues `doctor_joined` to the patient in the same transaction. A re-`start` on `in_progress` is `409 InvalidTransition` (no second notification).
- **S-D4** `complete` only from `in_progress`, no window check (the doctor may overrun), sets `completed_at`; terminal exits invalidate slot caches after commit.
- **S-D5** `no-show` from `booked`/`waiting` once `now ≥ starts_at + grace`; sets `no_show_marked_at`; optional `note` goes to the audit `metadata` as a reason, never clinical text (it is length-capped, and treated like a cancel reason). A locally suspended doctor gets `403`; admins are exempt.
- **S-D6** Waiting room = the doctor's `booked`/`waiting` rows whose window contains now, ordered by `startsAt`; one query on `idx_consultations_doctor_starts` plus one batched Case 2 call; bounded (the window is ~35 min + duration, so the set is small) and not paginated.
- **S-D7** Calendar: window `to − from ≤ 7 days` else `400 ValidationFailed`; consultations in any status overlapping the window (GiST/btree index on doctor + range) plus exceptions in the window via `SchedulesService`; rendered in the requested `timezone` (default: the doctor's); p95 < 200 ms.
- **S-D8** `join` tokens are rate-limited with the booking-write limiter class (10/min/user) to bound token minting; the response carries `Cache-Control: no-store`.
- **S-D9** Role checks: patient/doctor ownership comes from the row (`patient_user_id`/`doctor_user_id`), never the body; a non-participant gets `404 NotFound`; an admin on join/start/complete gets `403 Forbidden`.

## Open questions
1. `in_progress` rows past `ends_at` (decision D-R8 in consultations) match neither list scope. Leave as is (doctor must `complete`), or add a worker sweep later? Recommendation: leave, raise as a follow-up issue.
2. Should an unattended `booked` row auto-become `no_show`? Recommendation: no; the doctor or admin marks it (PRD 7.6).
3. Real provider choice and its ADR: deferred to a later unit.
