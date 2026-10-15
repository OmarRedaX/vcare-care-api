---
title: sessions — Tasks
owner: care-team
service: care-service
module: sessions
status: in-progress
last_verified: 2026-10-15
tags: [tasks, sessions]
related: [sessions-spec, sessions-brainstorm]
---

# sessions — Tasks

Source: [spec.md](./spec.md) (ready, v0.1.0). Issue #42, branch `feature/sessions`. No migration (spec section 2).

## Legend
- [ ] todo · [~] in progress · [x] done

## Tasks
- [ ] (contract) V1-V9 in `contracts/openapi.yaml` (`503 VideoUnavailable` response + `ErrorCode` entry, half-open window, check order, doctor join on `booked`, no `complaintText`, no-show note, suspension 403, calendar semantics, ordering/cap) + redocly lint
- [ ] (generic) `lib/identity-client/hydrate.ts` (`hydrateUsersOrEmpty`) + repoint `ConsultationQueriesService`; `pkg/utils/session-window.ts`; `consultations/rate-limits.ts` (+ unit tests)
- [ ] (env) `NO_SHOW_GRACE_MINUTES`, `WAITING_ROOM_OPEN_MINUTES`, `SESSION_OVERRUN_MINUTES`, `VIDEO_PROVIDER`, `VIDEO_PROVIDER_KEY`, `VIDEO_JOIN_TOKEN_TTL_SECONDS` in `env.ts` + `types.ts`; every fixture (`.env.example`, `.env.test`, `.env.test.example`, `docker-compose.yml`, `docs/quickstart.md`, env unit tests)
- [ ] (lib) `lib/video` — `types.ts`, `video-error.ts`, `fake-video.adapter.ts`, `create-video-provider.ts` (+ unit tests)
- [ ] (migration) none — verified against `20261011130000_create_consultations`
- [ ] (enums-errors-types) `sessions` `constants.ts` / `enums.ts` / `errors.ts` / `types.ts`; consultations `ConsultationChangeKind.Completed|NoShow`, `ConsultationAuditAction.Waiting|Started|Completed|NoShow`, `TransitionChanges`
- [ ] (entity) none — `Consultation` already carries the session columns
- [ ] (repository) `consultations.repo.ts`: `setRoomIfAbsent`, `isAssignedDoctor`, `listWaitingRoom(Query)`, `listCalendar(Query)`; `ConsultationRowsService`; `SchedulesService.listExceptionsForCalendar`
- [ ] (request-dto) `NoShowDto`, `CalendarQueryDto`, `WaitingRoomQueryDto`
- [ ] (response-dto) `SessionJoinResponseDto`, `CalendarViewResponseDto`
- [ ] (service) `SessionsService`, `SessionQueriesService`, DI tokens + `bootstrap.ts` registration
- [ ] (policies) `sessions/policies.ts` (+ resolvers)
- [ ] (controller) `SessionsController`
- [ ] (routes) `sessions/routes.ts`
- [ ] (mount) `src/routes.ts` — before the consultations router
- [ ] (tests) ← /write-tests (unit, integration, RBAC, contract, concurrency, EXPLAIN, log hygiene)
- [ ] (manual-qa) ← /manual-qa (`scripts/curl-test-sessions.sh`)
- [ ] (docs) ← /update-docs (spec section 11 list)

## Pending owner edits (not done by this unit)
- **CLAUDE.md → "Error codes owned by Care"**: add the row `VideoUnavailable | 503 | video provider failed or timed out on join/start`, and widen the status-code line "503 dependency down (health only)". The code is implemented and in the contract; CLAUDE.md is binding and must be edited by the owner (spec V1).
- **Compose stack**: `docker-compose.yml` runs `care-api` with `NODE_ENV=production`, and `createVideoProvider` refuses `VIDEO_PROVIDER=fake` in production (S-D1, SS-R22). The variables are added to compose, but `care-api` will not boot there until the real provider adapter lands or the owner decides how the local stack selects the fake.
