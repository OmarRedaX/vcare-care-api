---
title: sessions — Tasks
owner: care-team
service: care-service
module: sessions
status: done
last_verified: 2026-10-15
tags: [tasks, sessions]
related: [sessions-spec, sessions-brainstorm]
---

# sessions — Tasks

Source: [spec.md](./spec.md) (implemented, v0.2.0). Issue #42, branch `feature/sessions`. No migration (spec section 2).

## Legend
- [ ] todo · [~] in progress · [x] done

## Tasks
- [x] (contract) V1-V9 in `contracts/openapi.yaml` (`503 VideoUnavailable` response + `ErrorCode` entry, half-open window, check order, doctor join on `booked`, no `complaintText`, no-show note, suspension 403, calendar semantics, ordering/cap) + redocly lint
- [x] (generic) `lib/identity-client/hydrate.ts` (`hydrateUsersOrEmpty`) + repoint `ConsultationQueriesService`; `pkg/utils/session-window.ts`; `consultations/rate-limits.ts` (+ unit tests)
- [x] (env) `NO_SHOW_GRACE_MINUTES`, `WAITING_ROOM_OPEN_MINUTES`, `SESSION_OVERRUN_MINUTES`, `VIDEO_PROVIDER`, `VIDEO_PROVIDER_KEY`, `VIDEO_JOIN_TOKEN_TTL_SECONDS` in `env.ts` + `types.ts`; every fixture (`.env.example`, `.env.test`, `.env.test.example`, `docker-compose.yml`, `docs/quickstart.md`, env unit tests)
- [x] (lib) `lib/video` — `types.ts`, `video-error.ts`, `fake-video.adapter.ts`, `create-video-provider.ts` (+ unit tests)
- [x] (migration) none — verified against `20261011130000_create_consultations`
- [x] (enums-errors-types) `sessions` `constants.ts` / `errors.ts` / `types.ts` (no `enums.ts`, see as-built notes); consultations `ConsultationChangeKind.Completed|NoShow`, `ConsultationAuditAction.Waiting|Started|Completed|NoShow`, `TransitionChanges`
- [x] (entity) none — `Consultation` already carries the session columns
- [x] (repository) `consultations.repo.ts`: `setRoomIfAbsent`, `isAssignedDoctor`, `listWaitingRoom(Query)`, `listCalendar(Query)`; `ConsultationRowsService`; `SchedulesService.listExceptionsForCalendar`
- [x] (request-dto) `NoShowDto`, `CalendarQueryDto` (waiting-room takes no DTO, see as-built notes)
- [x] (response-dto) `SessionJoinResponseDto`, `CalendarViewResponseDto`
- [x] (service) `SessionsService`, `SessionQueriesService`, DI tokens + `bootstrap.ts` registration
- [x] (policies) `sessions/policies.ts` (+ resolvers)
- [x] (controller) `SessionsController`
- [x] (routes) `sessions/routes.ts`
- [x] (mount) `src/routes.ts` — before the consultations router
- [x] (tests) unit + contract (`tests/unit/app/sessions/*`, `tests/unit/contract/sessions-contract.test.ts`, lib/video, hydrate, session-window, env, errorHandler) and integration (`tests/integration/sessions.test.ts` lifecycle/windows/join-tokens/no-show/concurrency/video outage, `sessions-rbac.test.ts`, `sessions-reads.test.ts` waiting room/calendar/Case 2/timing guard, `sessions-explain.test.ts`, `sessions-privacy.test.ts`; helpers `tests/helpers/stub-video-provider.ts`, `sessions-fixtures.ts`, harness extended with the video stub). Run against native Postgres/Redis (disposable `*_test` database), 2026-10-15
- [x] (manual-qa) ← /manual-qa (`scripts/curl-test-sessions.sh`, `scripts/sessions-qa-server.ts`): 279 pass / 0 fail, 2026-10-15, see `docs/sessions/manual-qa.md`
- [x] (docs) ← /update-docs, 2026-10-15: spec v0.2.0 as-built notes (section 13), architecture shards (consultation-lifecycle, api, rbac, resilience, integration, infrastructure, overview), runbook, `docs/INDEX.md`, `docs/service-card.md`; contract already carried V1-V9, no further change

## Pending owner edits (not done by this unit)
- **CLAUDE.md → "Error codes owned by Care"**: add the row `VideoUnavailable | 503 | video provider failed or timed out on join/start`, and widen the status-code line "503 dependency down (health only)". The code is implemented and in the contract; CLAUDE.md is binding and must be edited by the owner (spec V1).
- **Compose stack**: `docker-compose.yml` runs `care-api` with `NODE_ENV=production`, and `createVideoProvider` refuses `VIDEO_PROVIDER=fake` in production (S-D1, SS-R22). The variables are added to compose, but `care-api` will not boot there until the real provider adapter lands or the owner decides how the local stack selects the fake.

## As-built notes (deviations from the spec)
- `sessions/enums.ts` is not created: the session audit actions live in `ConsultationAuditAction` (spec 3.9), so the file would be empty.
- `WaitingRoomQueryDto` is not created: a property-less class-validator DTO cannot reject unknown members, so the controller uses the shared `assertEmptyBody(req.query)`.
- `SessionsService` does not inject `ConsultationChangeListener`: the guarded after-commit call lives in `ConsultationRowsService.notifyChanged` (spec 3.6), and `ConsultationsService` now uses it too (its constructor takes `ConsultationRowsService` in place of `Logger` and the listener).
- `VideoUnavailable` is also added to `ErrorCode`/`ERROR_CODES` (`lib/error/types.ts`) and to the handled 5xx set in `errorHandler.ts` (logged as `handled_error` warn, not `unhandled_error`).
- The video provider is registered lazily (`instanceCachingFactory`), so a production boot with `VIDEO_PROVIDER=fake` fails when the sessions router is built at boot; the worker never resolves it.
- Contract lint: `npx -y @redocly/cli lint contracts/openapi.yaml` valid, 8 pre-existing warnings.
