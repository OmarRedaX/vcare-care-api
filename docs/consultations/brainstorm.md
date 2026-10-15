---
title: consultations — Brainstorm
owner: care-team
service: care-service
module: consultations
status: draft
diataxis: explanation
last_verified: 2026-10-11
tags: [brainstorm, consultations, booking, reschedule, cancel, clinical-privacy]
related: [consultation-lifecycle, scheduling-slots, data-model, rbac, integration, patients-brainstorm, schedules-brainstorm, admin-doctors-spec]
---

# consultations — Brainstorm

Scope decided 2026-10-11 (branch `feature/consultations`, from `feature/patients` @ e586cc8 because PR #37 is not merged
yet). Second of three modules: patients → **consultations** → discovery. The contract already defines the whole
consultations surface (`contracts/openapi.yaml`, tags `consultations` and `patients`), so this brief decides slicing,
not shapes.

## Problem & purpose
PRD 7.5 (a booking must be free at confirmation, a repeated submission never double-books) and 7.6 (patient views,
reschedules, cancels; doctor cancels with a reason; admin acts on behalf with a reason). Domain rules 1-12 make this the
module where the DB exclusion constraint, idempotency, the policy window and the horizon actually live. It also fills the
two ports left empty by `schedules` (leave-conflict listing) and `admin-doctors` (flag consultations on suspension), and
it owns the doctor-patient relationship that gates `GET /patients/{id}`.

## Actors
- **Patient** (active, email verified to book): books, lists own, reads own, reschedules and cancels outside the policy window.
- **Doctor** (active, not locally suspended): lists own, reads own, cancels own with a reason; reads the profile of a patient they have a `booked`/`waiting`/`in_progress`/`completed` consultation with.
- **Admin**: lists all (incl. the follow-up queue), reads the admin view (no `complaintText`), reschedules and cancels on behalf with a reason. Never reads a patient profile.
- **Other modules (ports)**: `schedules` (leave conflicts), `admin-doctors` (suspension flags), later `sessions`, `records`.

## In scope (this iteration)
- `POST /api/consultations` (book), `PATCH /api/consultations/{id}/reschedule`, `PATCH /api/consultations/{id}/cancel`.
- `GET /api/consultations` (scope, status, from/to, admin-only `doctorUserId`/`patientUserId`/`needsAdminFollowup`, keyset pagination) and `GET /api/consultations/{id}`.
- `GET /api/patients/{patientUserId}` with the relationship check (decision D1).
- Migration: `consultations` as in `data-model.md` (incl. `excl_consultations_doctor_no_overlap`, `uq_consultations_idempotency`, all indexes each with its query), the FK from `consultation_types`, and `notification_outbox` (ADR 0011) if not already created.
- Booking re-validation inside the transaction with `pkg/slots` in the doctor's timezone: doctor bookable, past, horizon, inside open intervals and on the grid, then insert; `23P01` maps to `409 SlotUnavailable`.
- `Idempotency-Key` required on book, reschedule, cancel (Redis middleware) and persisted on the row with `request_hash` so a Redis loss cannot double-book.
- Policy window (`CANCELLATION_POLICY_MINUTES=120`), horizon (`BOOKING_HORIZON_DAYS=60`), `EmailNotVerified`, `DoctorNotBookable`, `InvalidTransition`, `PolicyWindowViolation`.
- Audit of every status change and of every clinical read (`consultation.booked|rescheduled|cancelled|read`, `patient_profile.read`), in the same transaction as the write.
- `notification_outbox` rows in the same transaction (booking confirmed, rescheduled, cancelled); delivery stays in `care-worker`.
- Case 2 hydration of the counterpart's name and avatar on list and get-one (decision D3); slot and `next-available` cache invalidation after commit where those caches exist.
- Fill the ports: `ScheduleImpactProvider` (`findAffected`/`flagAffected`) and `SuspensionImpactProvider` (`listFlaggedConsultations`/`flagFutureConsultations`), rebinding their tokens in `bootstrap.ts`.
- `Cache-Control: no-store` before the JSON parser for `/api/consultations`, plus the general fix in decision D4.

## Out of scope
- `join`, `start`, `complete`, `no-show`, `GET /consultations/waiting-room`, `GET /consultations/calendar`, `lib/video`: the **`sessions`** follow-up unit (D2, D4). Until it lands nothing reaches `completed`, so `records` stays blocked. The status enum, CHECKs and the `WHERE status = ANY($from)` transition guard are built here so `sessions` only adds routes.
- `GET /api/patients/{id}/records`: `records` module.
- Doctor search, `GET /doctors/{id}/slots`, `next-available` ranking: discovery (the module after this one). Booking re-validation here recomputes open intervals itself via `pkg/slots`; it does not depend on a slots endpoint.
- Reminder scan loop (24 h / 1 h) and email delivery details: `care-worker` notification work under ADR 0011 (this module only writes the columns and outbox rows it needs; reminders are listed under Open questions).
- Doctor-initiated follow-up booking (`follow_up_of_record_id`): column exists, no route (needs `records`).
- Payments, video, chat (CLAUDE.md → Out of scope).

## Key entities & relationships
- `consultations` (patient and doctor by Identity user id, no cross-DB FK; FK to `consultation_types`; `price`/`currency` snapshot; `complaint_text` clinical; `patient_timezone`; lifecycle timestamps; `needs_admin_followup` + `followup_reason`; `idempotency_key` + `request_hash`).
- Reads (no ownership): `doctor_profiles` (via `DoctorsService`: bookable, suspended, timezone), `consultation_types`, `working_hours`, `schedule_exceptions` (via `schedules`), `patient_profiles` (timezone, via `patients`).
- Writes: `consultations`, `notification_outbox`, `audit_logs`.
- Relationship check `hasConsultationRelationship(doctorUserId, patientUserId)`: a method on `ConsultationsService`; `patients` consumes it through a port, never the repository.

## Primary flows / endpoints (roles + ownership)
| Route | Roles | Ownership | Notes |
|---|---|---|---|
| `POST /consultations` | patient | self | active + `ev=true`; idempotent; 10 writes/min/user |
| `PATCH /consultations/{id}/reschedule` | patient, admin | patient-owner or admin | status `booked` only; patient outside window vs the **current** start; admin needs `reason` |
| `PATCH /consultations/{id}/cancel` | patient, doctor, admin | participant or admin | `booked`/`waiting`; patient outside window; doctor and admin need `reason` |
| `GET /consultations` | patient, doctor, admin | own / own / all | admin-only filters rejected for others; admin view omits `complaintText` |
| `GET /consultations/{id}` | patient, doctor, admin | participant or admin | non-owner `404`; participant read audited as clinical read |
| `GET /patients/{patientUserId}` | patient, doctor | self or consulted patient | admin `403`; unrelated `404`; audited `patient_profile.read` |

## Business rules & state transitions
Domain rules 1-12 per CLAUDE.md. In this slice the transitions implemented are create -> `booked`, reschedule
(`booked` stays `booked`), and `booked`/`waiting` -> `cancelled`. Every update is `WHERE id=$1 AND status = ANY($from)`;
zero rows -> `409 InvalidTransition`. Reschedule updates the same row (old interval released atomically) and resets the
reminder columns. Suspended doctors cannot cancel (checked locally). Admin cancel/reschedule on behalf is audited as an
admin action with the reason length only.

## Cross-service touchpoints (case, direction, failure policy)
- **Case 2** (Identity, degrade): one `identity.getUsersBatch` per page of distinct counterpart ids; patients see the doctor, doctors see the patient, admins see both; failure gives `displayName:null, avatarUrl:null, profileHydrated:false`, never a 5xx. Writes (book/reschedule/cancel) are not hydrated, so a write never waits on Identity.
- Booking sends no Identity call. Recipient emails are fetched by the worker at send time (hub ADR 0010), never here.
- Cases 1, 3, 4 are untouched except that suspension now flags real rows through the filled port.

## Privacy & audit
`complaintText` and cancel `reason` are clinical/free text: never logged, never in audit metadata (lengths and ids only),
omitted from admin DTOs, `Cache-Control: no-store` on every consultation and patient response. Audit actions:
`consultation.booked`, `.rescheduled`, `.cancelled`, `.read` (participant reads), `patient_profile.read` (doctor or self
read of another-id route), plus the existing `consultation.flagged_for_followup`. Fixtures and demo data are synthetic.

## Constraints & guideline notes
- The exclusion constraint is the guarantee; service pre-checks are courtesy. Two concurrent bookings of one slot: exactly one `201`, one `409`.
- Services own transactions in Knex handler form; Identity/outbox delivery/cache work happens after commit.
- No inline types outside `types.ts`; repository functions with `conn: Knex = db`; DTOs viewer-aware.
- Slot math only in `pkg/slots` / `pkg/utils/time.ts` with `luxon`; budgets: booking write p95 < 200 ms.
- The `resolveOpenIntervals` 5 ms budget finding from `schedules` is a known open owner decision; booking runs it once per request for a single local date, so it is not on the critical path here.

## Contract changes expected
Probably none: the contract already carries `ConsultationCreate`, `Reschedule`, `Cancel`, `Consultation`, the list and
get-one operations, and `/patients/{id}`. The spec phase runs a drift check and lists any edit (candidates: the
`ConsultationCreate` field names against the data model, error codes in `BookingConflict`/`BookingUnprocessable`,
`x-roles` on `GET /patients/{id}`).

## Decisions made in this brainstorm
- **D1** `GET /api/patients/{patientUserId}` ships here; relationship via a consultations-service method; admins never; `/records` stays with `records`.
- **D2** `join/start/complete/no-show`, `waiting-room`, `lib/video` are the follow-up `sessions` unit.
- **D3** Case 2 hydration: `getUsersBatch`, counterpart only, on list and get-one; writes not hydrated.
- **D4** Reads: list and get-one now; `waiting-room` and `calendar` go with `sessions`. The no-store ordering gap gets a general fix as its own commit in this PR (one pre-parser prefix list covering `/api/patients`, `/api/consultations`, `/api/admin`, `/api/audit-logs`), with an integration test per prefix.

## Open questions
1. A patient with no `patient_profiles` row: `patient_timezone` is `NOT NULL`. Recommendation: booking uses the profile timezone when present, else requires a `timezone` in `ConsultationCreate` if the contract has one; the spec confirms against the contract and picks `404`/`400` otherwise.
2. Reminders (24 h/1 h) belong to the worker; confirm they are scheduled in the `sessions` unit or a small `notifications` unit, not here.
3. Does `ScheduleImpactProvider.findAffected` count only `booked`/`waiting`/`in_progress` future rows? Recommendation: yes, matching the exclusion predicate and the follow-up index.
4. Slot-cache invalidation hooks: no `availability` module exists yet; the spec defines the post-commit hook as a no-op listener seam that discovery fills.
5. Platform changes for `/system-design`: none expected.

## Success criteria
- Concurrent booking of one slot yields exactly one `201` and one `409 SlotUnavailable`; replay returns the same consultation, a different body returns `422 IdempotencyConflict`.
- Each Domain rule 1-12 that applies to this slice has a named test; RBAC matrix per route, admin denied on every clinical route and on `/patients/{id}`.
- Reschedule and cancel enforce the policy window for patients and not for admins; terminal states never change.
- Suspending a doctor flags real consultations; schedule leave returns `409 ScheduleConflictsUnconfirmed` with real ids.
- List with Identity down returns rows with `profileHydrated:false`; page 2 on the default sort works; every clinical read writes an audit row; logs contain no fixture strings.
- Typecheck, lint, unit and integration suites green; manual QA via CURL against a throwaway DB and fake Identity.
