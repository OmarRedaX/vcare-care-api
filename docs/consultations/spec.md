---
title: consultations — Spec
owner: care-team
service: care-service
module: consultations
status: ready
version: 0.1.0
diataxis: reference
last_verified: 2026-10-12
tags: [spec, consultations, booking, reschedule, cancel, exclusion-constraint, idempotency, outbox, ports, clinical-privacy]
related: [consultations-brainstorm, patients-spec, schedules-spec, admin-doctors-spec, doctors-spec, access-spec, data-model, scheduling-slots, consultation-lifecycle, rbac, integration, adr-0003-db-exclusion-constraint, adr-0011-notification-outbox-and-reminders, adr-0017-generic-helpers-and-transaction-scoping, adr-0018-db-role-split-explicit-grants-partition-function]
contracts: [contracts/openapi.yaml]
---

# consultations — Spec

First half of the consultation lifecycle: **book, reschedule, cancel, list, get one**, the doctor-to-patient relationship that
gates `GET /api/patients/{patientUserId}`, and the two in-process ports left empty by `schedules` and `admin-doctors`.
Scope follows [brainstorm.md](./brainstorm.md) (decisions D1-D4, binding) plus the owner decisions of 2026-10-11 (section 1.5).

Binding rules: CLAUDE.md → "Database rules", "API conventions", "Authorization — RBAC and ownership", "Security rules",
"Privacy and logging", "Cross-service integration" (Case 2), "Domain rules" 1-12, 17, 19-22, "Testing policy", "Performance rules".
Precedents: [patients/spec.md](../patients/spec.md), [schedules/spec.md](../schedules/spec.md), [admin-doctors/spec.md](../admin-doctors/spec.md).

---

## 1. Overview

### 1.1 What `consultations` owns in this slice
| Area | Delivers |
|---|---|
| Tables | `consultations` (full lifecycle columns, built once), `notification_outbox` (insert side only) — two migrations |
| Routes | `POST /api/consultations` · `GET /api/consultations` · `GET /api/consultations/{id}` · `PATCH /api/consultations/{id}/reschedule` · `PATCH /api/consultations/{id}/cancel` · `GET /api/patients/{patientUserId}` (route lives in the `patients` router; relationship check supplied by this module) |
| Ports filled | `ScheduleImpactProvider` (`TOKENS.ScheduleImpactProvider`), `SuspensionImpactProvider` (`TOKENS.SuspensionImpactProvider`) — rebound in `bootstrap.ts` |
| Ports added | `PatientRelationshipChecker` (consumed by `patients`), `ConsultationChangeListener` (no-op seam for slot / `next-available` cache invalidation; discovery fills it) |
| Cross-module service API added | `DoctorsService.lockBookingTarget` / `findBookingTarget` / `findTimezone`; `SchedulesService.findBookableType` / `resolveOpenDays`; new small module `notifications` (`NotificationsService.enqueue`) |
| Pure code | `pkg/slots/slot-fit.ts` (`isSlotOnGrid`, `isCoveredByOpenIntervals`), `pkg/utils/time.ts` `toIsoInZone` |
| Generic additions | `lib/knex/pg-errors.ts` `exclusionViolationConstraint`; `lib/rate-limit/subjects.ts` `byUserOfRoles`; `lib/validation/transforms.ts` `ToCommaList`; `lib/logger/request-context.ts` `currentRequestIdOrNew`; `Clock` type + `TOKENS.Clock`; no-store prefix list (section 3.10) |
| Env | `BOOKING_HORIZON_DAYS` (default 60), `CANCELLATION_POLICY_MINUTES` (default 120). Deferred to later units: `NO_SHOW_GRACE_MINUTES`, `WAITING_ROOM_OPEN_MINUTES`, `SESSION_OVERRUN_MINUTES` (sessions), `OUTBOX_MAX_ATTEMPTS`, `OUTBOX_RETENTION_DAYS` (notification delivery) |

### 1.2 Principles
- **The constraint is the guarantee.** `excl_consultations_doctor_no_overlap` decides who wins a slot; every service check is a courtesy ([ADR 0003](../adr/0003-db-exclusion-constraint.md)).
- **Slots are never stored.** Booking recomputes the doctor's open intervals for one doctor-local date with `pkg/slots` inside the booking transaction.
- **Duration, price and `endsAt` come from the server** (type row at booking; the stored interval length on reschedule).
- **Clinical text stays out of logs, audit and outbox.** `complaintText` and every `reason` are free text: never logged, never in audit metadata (`reasonLength` only), never in outbox payloads, absent from admin DTOs and from list items.
- **Every write is one transaction** with its audit row and its outbox rows (Knex handler form). Identity, cache and listener work happens after commit; writes make **no** Identity call.
- **Private resources are 404.** Non-participants never learn an id exists.

### 1.3 Dependencies
- **Other modules (services only):** `doctors` (`DoctorsService`: booking target, suspension, timezone), `schedules` (`SchedulesService`: types, open intervals), `notifications` (new: outbox insert), `audit` (`AuditRecorder`), `patients` (consumes the relationship port; its `findProfileByUserId` and response DTO serve `GET /patients/{id}`).
- **Other service:** identity-service, **Case 2 only** (batched hydration on list and get-one, degrade). No Case 1, 3, 4 call is made here; Case 3's flagging is now real through the filled port.
- **Later consumers:** `sessions` (join/start/complete/no-show, adds routes and reuses `applyTransition`), `records` (`hasRecord`, `follow_up_of_record_id` FK), discovery (fills `ConsultationChangeListener`).

### 1.4 Contract drift check (against `contracts/openapi.yaml`, 2026-10-11)
Operations `bookConsultation`, `listConsultations`, `getConsultation`, `rescheduleConsultation`, `cancelConsultation`, `getPatientProfile`; schemas `Consultation`, `ConsultationCreate`, `Reschedule`, `Cancel`, `Participant`, `HydratedUserFields`; responses `ConsultationOk`, `BookingForbidden`, `BookingConflict`, `RescheduleConflict`, `CancelConflict`, `BookingUnprocessable`, `PatientProfileOk`.

Everything not listed below matches (roles, ownership, status codes, error codes, `Idempotency-Key` required on the three writes, body shapes, field names `doctorId`/`typeId`/`startsAt`/`complaintText`/`patientTimezone`, pagination, the `Participant` shape, `no-store` on responses). **Actual gaps and divergences** (each is a numbered contract edit in section 11):

| # | Finding | Contract today | This spec |
|---|---|---|---|
| C1 | `scope=all` sort unstated; `upcoming`/`past` boundary unstated | "asc upcoming, desc past" | `upcoming` = `endsAt > now`, `past` = `endsAt <= now`; `all` ascending |
| C2 | Admin-only filters used by a non-admin: unstated | `doctorUserId`, `patientUserId`, `needsAdminFollowup` "Admin only" | `403 Forbidden` (already declared on the list) |
| C3 | List `timezone` default says "viewer's own timezone"; `Consultation` says admin default UTC and a `timezone` query for admins only | both | `timezone` honored for every role; defaults: patient `patientTimezone`, doctor the doctor's zone, admin UTC |
| C4 | Cancel op never states the policy window length | reschedule says 120 | patient window is `CANCELLATION_POLICY_MINUTES` (120) for both operations; `reason` required for doctor/admin is a `400 ValidationFailed` |
| C5 | List items: clinical text in an unaudited bulk read | `complaintText` "participants only" on `Consultation` | list items **omit `complaintText`** for every viewer; it is returned by get-one (audited) and by the actor's own write responses |
| C6 | `followUpOfRecordId` accepted by `ConsultationCreate` but `records` does not exist | optional field | `400 ValidationFailed` (`details[].field = followUpOfRecordId`, "is not supported yet") until `records` ships |
| C7 | `x-audit: admin-action` on reschedule/cancel although patients (and a doctor) call them | class only | every successful call writes `consultation.rescheduled` / `.cancelled` for **any** caller; `byRole` in metadata. Description clarification only |
| C8 | `GET /patients/{patientUserId}`: doctor suspended, profile not created, non-numeric id | silent | suspended doctor `403 Forbidden`; no profile yet `404`; non-numeric id `404` (no `400` declared, none added). Description only |
| C9 | `Consultation.hasRecord` | optional | always `false` until `records` ships. Description only |

### 1.5 Owner decisions folded in (2026-10-11)
1. **Patient timezone.** The required `patientTimezone` is validated as an IANA zone (luxon), stored canonical as `patient_timezone` (a per-consultation snapshot). No `patient_profiles` row is needed to book; the profile is neither read nor written, even when one exists.
2. **Reminders and delivery are a separate notification/worker unit** (ADR 0011). This slice writes `notification_outbox` rows (`booking_confirmed`, `rescheduled`, `cancelled`, `schedule_blocked`) in the writing transaction and has reschedule reset `reminder_24h_sent_at` / `reminder_1h_sent_at`. No loop, no reminder scan, no `UPDATE`/`DELETE` grant on the outbox, no claim/purge index.
3. **`findAffected` considers future `booked`, `waiting` and `in_progress` consultations.** The cache-invalidation hook is a no-op seam until discovery implements the cache.
4. **No-store prefix fix** is its own commit with four integration tests (one malformed-JSON test per prefix: `/api/patients`, `/api/consultations`, `/api/admin`, `/api/audit-logs`). Doctor routes are left as they are.
5. **Write responses are not hydrated** but emit `doctor` and `patient` as `{ userId, displayName: null, avatarUrl: null, profileHydrated: false }`.
6. Actual contract drift is flagged as numbered edits (section 1.4, section 11).

---

## 2. Database schema

Two migrations (`npm run migrate:make`), raw SQL, owner role, explicit grants (ADR 0018). Both sort after `20261011120000_create_patient_profiles`.

### 2.1 `20261011130000_create_consultations`
```sql
CREATE TABLE consultations (
    id                     BIGSERIAL PRIMARY KEY,
    doctor_user_id         BIGINT NOT NULL,
    patient_user_id        BIGINT NOT NULL,
    consultation_type_id   BIGINT NOT NULL,
    starts_at              TIMESTAMPTZ NOT NULL,
    ends_at                TIMESTAMPTZ NOT NULL,
    status                 VARCHAR(16) NOT NULL,
    complaint_text         TEXT NOT NULL,
    patient_timezone       VARCHAR(64) NOT NULL,
    price                  INT NOT NULL,
    currency               CHAR(3) NOT NULL,
    room_id                VARCHAR(128),
    joined_at              TIMESTAMPTZ,
    started_at             TIMESTAMPTZ,
    completed_at           TIMESTAMPTZ,
    cancelled_at           TIMESTAMPTZ,
    cancel_reason          TEXT,
    cancelled_by           VARCHAR(16),
    cancelled_by_user_id   BIGINT,
    no_show_marked_at      TIMESTAMPTZ,
    needs_admin_followup   BOOLEAN NOT NULL DEFAULT FALSE,
    followup_reason        VARCHAR(32),
    follow_up_of_record_id BIGINT,
    reminder_24h_sent_at   TIMESTAMPTZ,
    reminder_1h_sent_at    TIMESTAMPTZ,
    idempotency_key        UUID NOT NULL,
    request_hash           CHAR(64) NOT NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at             TIMESTAMPTZ,
    CONSTRAINT fk_consultations_consultation_type_id FOREIGN KEY (consultation_type_id) REFERENCES consultation_types(id) ON DELETE RESTRICT,
    CONSTRAINT chk_consultations_status CHECK (status IN ('booked','waiting','in_progress','completed','cancelled','no_show')),
    CONSTRAINT chk_consultations_time_order CHECK (ends_at > starts_at),
    CONSTRAINT chk_consultations_price CHECK (price >= 0),
    CONSTRAINT chk_consultations_cancelled_by CHECK (cancelled_by IS NULL OR cancelled_by IN ('patient','doctor','admin')),
    CONSTRAINT chk_consultations_cancel_shape CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)),
    CONSTRAINT chk_consultations_followup_reason CHECK (followup_reason IS NULL OR followup_reason IN ('doctor_suspended','schedule_blocked')),
    CONSTRAINT uq_consultations_idempotency UNIQUE (patient_user_id, idempotency_key)
);
ALTER TABLE consultations ADD CONSTRAINT excl_consultations_doctor_no_overlap
    EXCLUDE USING gist (doctor_user_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
    WHERE (status NOT IN ('cancelled','no_show') AND deleted_at IS NULL);
```
- `status`, `price`, `currency`, `starts_at`, `ends_at` have **no defaults** (critical columns). `btree_gist` exists (`20260915000000`).
- Comments (`COMMENT ON`): table; `doctor_user_id`/`patient_user_id`/`cancelled_by_user_id` "Identity user id"; `complaint_text` and `cancel_reason` "Clinical/free text; never logged"; `follow_up_of_record_id` "FK to medical_records is added by the records migration (circular)"; `price` "Minor units; snapshot of the type price at booking".
- **Deviation from data-model.md:** `fk_consultations_follow_up_of_record_id` is **not** created (`medical_records` does not exist); the column and `idx_consultations_follow_up_of_record_id` are. The `records` migration adds the FK.
- Grants: `GRANT SELECT, INSERT, UPDATE ON consultations TO vcare_app; GRANT USAGE ON SEQUENCE consultations_id_seq TO vcare_app;` (no `DELETE`: soft delete only, no route sets `deleted_at`).
- `down`: `DROP TABLE IF EXISTS consultations;` (the outbox migration rolls back first).

Indexes (each commented in the migration with its query):

| Index | Serves |
|---|---|
| GiST behind `excl_consultations_doctor_no_overlap` | insert/update overlap guarantee; candidate scans may also use it |
| `uq_consultations_idempotency` | `SELECT … WHERE patient_user_id = $1 AND idempotency_key = $2` (booking replay) |
| `idx_consultations_patient_user_id_starts_at_id ON (patient_user_id, starts_at, id) WHERE deleted_at IS NULL` | patient list keyset, both directions |
| `idx_consultations_doctor_user_id_starts_at_id ON (doctor_user_id, starts_at, id) WHERE deleted_at IS NULL` | doctor list keyset; `findAffected`; suspension flag `UPDATE`; admin `doctorUserId` filter |
| `idx_consultations_doctor_user_id_patient_user_id ON (doctor_user_id, patient_user_id) WHERE deleted_at IS NULL AND status IN ('booked','waiting','in_progress','completed')` | relationship `EXISTS` for `GET /patients/{id}` |
| `idx_consultations_consultation_type_id ON (consultation_type_id)` | FK index |
| `idx_consultations_followup_starts_at_id ON (starts_at, id) WHERE needs_admin_followup AND deleted_at IS NULL AND status IN ('booked','waiting','in_progress')` | admin follow-up queue `GET /consultations?needsAdminFollowup=true`. **Deviation:** data-model.md lists `('booked','waiting')`; `in_progress` is added because decision 1.5.3 flags `in_progress` rows |
| `idx_consultations_starts_at_id ON (starts_at, id) WHERE deleted_at IS NULL` | **new:** admin list with no participant filter (otherwise a full scan and sort) |
| `idx_consultations_booked_starts_at ON (starts_at) WHERE status = 'booked' AND deleted_at IS NULL` | reminder scan — **not created here** (no query in this slice; the notification unit adds it) |
| `idx_consultations_follow_up_of_record_id ON (follow_up_of_record_id) WHERE follow_up_of_record_id IS NOT NULL` | FK-to-be index, created now so the `records` migration only adds the constraint; comment names that query |

### 2.2 `20261011130100_create_notification_outbox`
DDL exactly as `docs/architecture/data-model.md` (`notification_outbox`: columns, `fk_notification_outbox_consultation_id ON DELETE RESTRICT`, `chk_notification_outbox_kind` (seven kinds), `chk_notification_outbox_status`, `chk_notification_outbox_payload_object`). Differences:
- Only `idx_notification_outbox_consultation_id ON (consultation_id) WHERE consultation_id IS NOT NULL` (FK index). The claim index (`status='pending'`) and purge index (`status='sent'`) are created by the notification/delivery unit together with `GRANT UPDATE, DELETE` — no query uses them yet.
- Grants: `GRANT SELECT, INSERT ON notification_outbox TO vcare_app; GRANT USAGE ON SEQUENCE notification_outbox_id_seq TO vcare_app;`.
- Comments: `recipient_user_id` "Identity user id; email resolved at send time, never stored"; `payload` "ids and non-clinical render params only".
- `down`: `DROP TABLE IF EXISTS notification_outbox;`.

### 2.3 Migration tests
`tests/integration/migrations.test.ts`: round-trip both migrations (named constraints and indexes exist; `down` then `up`), assert grants (`consultations`: select/insert/update yes, delete no; `notification_outbox`: select/insert yes, update/delete no), assert `excl_consultations_doctor_no_overlap` rejects an overlapping insert with SQLSTATE `23P01` and allows back-to-back and cancelled overlap.

---

## 3. API contract and file-level design

### 3.1 Endpoints (the contract wins on disagreement)
Common: guard `userGuard()` → `authorize(policy)` → limiter(s) → [`idempotency({ required: true })`] → controller. `Cache-Control: no-store` on every response of the prefix (section 3.10). Identity headers are ignored. Non-numeric `:id` / `patientUserId` → ownership `deny-not-found` (404).

| | `POST /api/consultations` | `PATCH /api/consultations/{id}/reschedule` | `PATCH /api/consultations/{id}/cancel` |
|---|---|---|---|
| Roles | patient | patient, admin | patient, doctor, admin |
| Ownership | `self` (`patient_user_id := auth.userId`; never from the body) | resolver `consultation_patient_or_admin`: patient owns the row, admin any; others 404 | resolver `consultation_participant_or_admin`: patient owner, assigned doctor, or admin; others 404 |
| Account state | `status=active` and `emailVerified=true` (`403 EmailNotVerified` at `authorize`) | `status=active` | `status=active`; doctor also `doctor_not_suspended` check (`403 Forbidden`) |
| Audit | `consultation.booked` | `consultation.rescheduled` (policy class `admin-action`) | `consultation.cancelled` (policy class `admin-action`) |
| `Idempotency-Key` | **required** (missing/non-UUID `400`) | required | required |
| Rate limit | see 3.9 | see 3.9 | see 3.9 |
| Body | `ConsultationCreate` | `Reschedule` | `Cancel` (body required; patient sends `{}`; absent body → `400`) |
| Success | `201` `Consultation` | `200` `Consultation` | `200` `Consultation` |
| Errors | 400, 401, 403 (`EmailNotVerified`, `Forbidden`), 404 (doctor or type), 409 (`DoctorNotBookable`, `SlotUnavailable`, `Conflict` in flight), 422 (`OutsideWorkingHours`, `BookingInPast`, `BeyondBookingHorizon`, `IdempotencyConflict`), 429, 500 | 400, 401, 403, 404, 409 (`PolicyWindowViolation`, `InvalidTransition`, `DoctorNotBookable`, `SlotUnavailable`, `Conflict`), 422 (booking codes), 429, 500 | 400, 401, 403, 404, 409 (`PolicyWindowViolation`, `InvalidTransition`, `Conflict`), 422 `IdempotencyConflict`, 429, 500 |

| | `GET /api/consultations` | `GET /api/consultations/{id}` | `GET /api/patients/{patientUserId}` |
|---|---|---|---|
| Roles | patient, doctor, admin | patient, doctor, admin | patient, doctor (**admin `403`**) |
| Ownership | `none` at the guard; the repository `WHERE` is built from `auth` (patient `patient_user_id`, doctor `doctor_user_id`, admin all) — never from the query | resolver `consultation_participant_or_admin` | resolver `consulted_patient_or_self`: patient `:id = auth.userId`; doctor has a `booked/waiting/in_progress/completed` consultation with that patient; else 404 |
| Account state | `status=active` (a locally suspended doctor may still read own rows) | same | `status=active`; doctor also `doctor_not_suspended` |
| Audit | none (list items carry no clinical text, C5) | participants: `consultation.read` in the read transaction; admin: none (no clinical field) | `patient_profile.read` (existing action) |
| Rate limit | read 120/min per user | read 120/min per user | patients read limiter (120/min per user, shared with `/patients/me`) |
| Success | `200` array of `Consultation` + `meta` | `200` `Consultation` | `200` `PatientProfile` |
| Errors | 400, 401, 403, 429, 500 | 400 (bad `timezone`), 401, 403, 404, 429, 500 | 401, 403, 404, 429, 500 |

**Request rules (class-validator, `forbidNonWhitelisted`, implicit conversion off):**
- `ConsultationCreateDto`: `doctorId` `@IsInt @Min(1)`; `typeId` same; `startsAt` string + `IsIsoDateTimeWithOffset`; `complaintText` string, `NotBlank`, `CodePointLength(3,4000)`, `NoControlCharacters("nul")` (newlines allowed); `patientTimezone` string + `IsIanaTimezone` (≤ 64), stored via `canonicalIanaTimezone`; `followUpOfRecordId` optional `@IsInt @Min(1)` (service rejects, C6).
- `RescheduleDto`: `startsAt` as above (required); `reason` optional, `NotBlank`, `CodePointLength(3,1000)`, `NoControlCharacters("nul")`. Required for admin (service, `400` `details[].field = reason`).
- `CancelDto`: `reason` optional, same rules. Required for doctor and admin (service, before any DB access).
- `ListConsultationsQueryDto` (composes `PaginationQueryDto`): `scope` `@IsIn(["upcoming","past","all"])` default `upcoming` set explicitly; `status` `ToCommaList()` + `@IsArray @ArrayMaxSize(6) @IsIn(statuses,{each})` (repeated param → `400`; duplicates removed); `from`, `to` `IsIsoDateTimeWithOffset` (`from >= to` → `400`); `doctorUserId`, `patientUserId` `ToInt @IsInt @Min(1)`; `needsAdminFollowup` `ToBoolean @IsBoolean`; `timezone` `IsIanaTimezone`; unknown query members rejected.
- `GetConsultationQueryDto`: `timezone` optional.
- Admin-only filters from a non-admin → `403 Forbidden` (C2), checked before any query.

**Response `Consultation`** (`ConsultationResponseDto.from(entity, viewer, view)`; `view = { timezone, doctor, patient, detail }`):
`id, status, doctor, patient, consultationType{ id, name, durationMinutes }, startsAt, endsAt` (UTC ISO `Z`), `startsAtLocal, endsAtLocal` (ISO with offset in `timezone`, `toIsoInZone`), `timezone, patientTimezone, price{ amount, currency }, complaintText?, joinedAt, startedAt, completedAt, cancelledAt, cancelledBy, cancelReason, needsAdminFollowup, followupReason, followUpOfRecordId, hasRecord (false, C9), createdAt, updatedAt`.
- `durationMinutes` = `(endsAt − startsAt)` in minutes (snapshot); `consultationType.name` joined from `consultation_types` (current name).
- `complaintText`: present for patient/doctor viewers when `detail = true` (get-one and write responses); absent for admin always and for every viewer on list items (C5).
- `timezone` (render zone): `?timezone` if given (any role, C3), else patient → `patient_timezone`, doctor → the doctor's profile timezone (`DoctorsService.findTimezone`, one indexed query), admin → `UTC`. Write responses use the same defaults.
- `doctor` / `patient` `Participant`: hydrated counterpart on list and get-one (section 5); the viewer's own side and **every participant on write responses** are `{ userId, displayName: null, avatarUrl: null, profileHydrated: false }` (decision 1.5.5). Admin views hydrate both.
- Never emitted: `room_id`, `idempotency_key`, `request_hash`, `cancelled_by_user_id`, reminder columns, `no_show_marked_at`.
- `cancelReason` is free text: shown to participants and admin; never logged or audited.

**List semantics.** Cursor keyset `(starts_at, id)`, `limit` 1..100 default 20, fetch `limit + 1`, cursor carries the microsecond UTC text (`timestampCursorSelect` / `decodeTimestampCursor`, as `audit`). `meta { nextCursor, hasMore, count }`.
- `upcoming`: `ends_at > $now AND starts_at >= $now − 240 min` (the second term only makes the range scan sargable: `chk_consultation_types_duration` caps duration at 240), ascending.
- `past`: `ends_at <= $now AND starts_at <= $now`, descending `(starts_at, id)`.
- `all`: no time predicate, ascending (C1).
- `from`/`to` bound `starts_at` (`>= from`, `< to`) and combine with the scope by `AND`.
- `status` is an `IN` filter. `needsAdminFollowup=true` (admin) adds `needs_admin_followup AND status IN ('booked','waiting','in_progress')` (so the partial index serves it) intersected with any `status` filter; `false` adds `NOT needs_admin_followup`.
- Rows join `consultation_types` by primary key (the type row is never hard-deleted, so no `deleted_at` filter on the join).

### 3.2 Route composition (`src/app/consultations/routes.ts`)
```ts
router.post  ("/consultations",                userGuard(), authorize(p.book),       ...bookLimits(),  idempotency({ required: true }), c.book);
router.get   ("/consultations",                userGuard(), authorize(p.list),       readLimit(),      c.list);
router.get   ("/consultations/:id",            userGuard(), authorize(p.get),        readLimit(),      c.get);
router.patch ("/consultations/:id/reschedule", userGuard(), authorize(p.reschedule), ...writeLimits(), idempotency({ required: true }), c.reschedule);
router.patch ("/consultations/:id/cancel",     userGuard(), authorize(p.cancel),     ...writeLimits(), idempotency({ required: true }), c.cancel);
return sealRouter(router);
```
Literal siblings `waiting-room` and `calendar` (sessions unit) must be registered before `/consultations/:id`; a code comment reserves the slot. Mount in `src/routes.ts` after `buildPatientsRouter()`. In `patients/routes.ts`, `GET /patients/:patientUserId` is registered **after** `/patients/me`.

### 3.3 File list
```
src/app/consultations/
  constants.ts   enums.ts   errors.ts   types.ts   policies.ts   routes.ts
  entity/consultation.entity.ts
  dto/consultations.request.dto.ts   dto/consultations.response.dto.ts
  repository/consultations.repo.ts
  service/consultations.service.ts            book / reschedule / cancel / hasConsultationRelationship
  service/consultation-queries.service.ts     list / get-one + Case 2 hydration + render context
  service/schedule-impact.provider.ts         ScheduleImpactProvider (lazy SchedulesService)
  service/suspension-impact.provider.ts       SuspensionImpactProvider
  service/noop-consultation-change.listener.ts
  controller/consultations.controller.ts
src/app/notifications/                         enums.ts (OutboxKind, OutboxStatus) · types.ts · repository/notification-outbox.repo.ts · service/notifications.service.ts
src/pkg/slots/slot-fit.ts    src/pkg/utils/time.ts (toIsoInZone)
src/migrations/20261011130000_create_consultations.ts   20261011130100_create_notification_outbox.ts
```
Edited: `bootstrap.ts`, `lib/di/tokens.ts` (`ConsultationsService`, `ConsultationQueriesService`, `ConsultationsController`, `NotificationsService`, `ConsultationChangeListener`, `PatientRelationship`, `Clock`), `lib/di/register-core.ts` (`Clock = { now: () => Date.now() }`), `lib/types/types.ts` (`Clock`), `lib/config/env.ts` + `types.ts`, `lib/logger/redact.ts` (add `cancelReason`, with a redaction test row), `lib/knex/pg-errors.ts`, `lib/rate-limit/subjects.ts`, `lib/validation/transforms.ts`, `lib/logger/request-context.ts` (`currentRequestIdOrNew`; `verification.service.ts` private `requestId()` repointed — behavior-preserving), `src/routes.ts`, `src/app.ts`, `doctors` (service + `doctor-profiles.repo.ts` `findProfileByUserIdForShare`), `schedules` (service + `schedule-exceptions.repo.ts` `listExceptionsInRange`), `patients` (`routes.ts`, `policies.ts`, `types.ts`, controller, service `getForViewer`, response DTO).

### 3.4 Entity
`Consultation` plain class, `constructor(data: Partial<Consultation>)`, camelCase mirror of the columns above (dates as `Date`, `startsAt`/`endsAt` `Date`).

### 3.5 Repository (`consultations.repo.ts`; functions, `conn: Knex = db`, `CONSULTATION_COLUMNS` explicit, `whereNull('deleted_at')` on every read, never `SELECT *`)
- `findById(id, conn)` / `findByIdForUpdate(id, trx)` — joined row `{ …columns, type_name }`.
- `findByIdempotencyKey(patientUserId, key, conn)` — `uq_consultations_idempotency`.
- `insertConsultation(row, trx)` — `INSERT … RETURNING`.
- `rescheduleRow(id, startsAt, endsAt, trx)` — `UPDATE consultations SET starts_at=$2, ends_at=$3, reminder_24h_sent_at=NULL, reminder_1h_sent_at=NULL, needs_admin_followup=FALSE, followup_reason=NULL, updated_at=NOW() WHERE id=$1 AND status='booked' AND deleted_at IS NULL RETURNING …` (zero rows → `InvalidTransition`).
- `applyTransition(id, fromStatuses, changes, trx)` — generic `UPDATE … SET status=$to, …changes, updated_at=NOW() WHERE id=$1 AND status = ANY($from) AND deleted_at IS NULL RETURNING …` (Domain rule 9; `sessions` reuses it). Cancel passes `from = ['booked','waiting']` and `cancelled_at, cancelled_by, cancelled_by_user_id, cancel_reason`.
- `listPage(scopeFilter, conn)` — one query, keyset, `limit + 1`, `starts_at_cursor` via `timestampCursorSelect`; exported query builder for EXPLAIN tests.
- `hasRelationship(doctorUserId, patientUserId, conn)` — `SELECT 1 … LIMIT 1` over the relationship index.
- `listAffectedCandidates(doctorUserId, now, window, trx)` — `SELECT id, starts_at, ends_at FROM consultations WHERE doctor_user_id=$1 AND status IN ('booked','waiting','in_progress') AND deleted_at IS NULL AND ends_at > $now AND starts_at >= $lower [AND starts_at < $toMs AND ends_at > $fromMs] ORDER BY id`.
- `flagConsultations(ids, doctorUserId, reason, trx)` and `flagFutureForDoctor(doctorUserId, now, reason, trx)` — `UPDATE … SET needs_admin_followup=TRUE, followup_reason=$reason, updated_at=NOW() … RETURNING id, patient_user_id, starts_at, ends_at` (same status/`ends_at > now` predicate; last writer wins on `followup_reason`).
- `listFlaggedIds(doctorUserId, reason, now, conn)` — for `listFlaggedConsultations`.

### 3.6 Services
**`ConsultationsService`** (`@injectable()`; deps `Db, AuditRecorder, Env, Logger, Clock, DoctorsService, SchedulesService, NotificationsService, ConsultationChangeListener`).

`book(actor, input, idempotencyKey, requestHash)`:
0. `followUpOfRecordId` present → `400` (C6), before any DB access.
1. `outer try { return await this.bookOnce(…) } catch`: map `exclusionViolationConstraint(e) === 'excl_consultations_doctor_no_overlap'` → `SlotUnavailable`; map `uniqueViolationConstraint(e) === 'uq_consultations_idempotency'` → fresh read by key and compare `request_hash` (equal → replay, else `IdempotencyConflict`). The transaction is already rolled back when these run (a failed statement aborts it).
2. `bookOnce`, one `db.transaction`:
   1. `findByIdempotencyKey` → exists: same `request_hash` → return it (replay); different → `422 IdempotencyConflict`. Replay skips every later check.
   2. `doctors.lockBookingTarget(input.doctorId, trx)` (`SELECT … FOR SHARE` on the live profile) — absent → `404 NotFound`. FOR SHARE serializes with suspension and schedule writes (both take `FOR UPDATE` on the profile); everything below is read **after** the lock.
   3. `!doctor.isBookable` (approved, synced, not suspended, accepting, ≥ 1 active type — `isBookable` + `hasActiveConsultationType`) → `409 DoctorNotBookable`.
   4. `schedules.findBookableType(doctor.profileId, input.typeId, trx)` (live and active) → absent → `404 NotFound`.
   5. `startMs <= now` → `422 BookingInPast`; `startMs > now + BOOKING_HORIZON_DAYS` (`toMs(days,'d')`) → `422 BeyondBookingHorizon`.
   6. `days = schedules.resolveOpenDays(profile, localDateOf(startMs, tz) − 1 … + 1, trx)`; `!isSlotOnGrid(days, startMs, type.durationMinutes)` → `422 OutsideWorkingHours`.
   7. `insertConsultation` (`status='booked'`, `ends_at = start + duration`, `price/currency` from the type, `patient_timezone` canonical, `idempotency_key`, `request_hash`).
   8. `notifications.enqueue(trx, [booking_confirmed → patient, booking_confirmed → doctor])`.
   9. `audit.record` `consultation.booked`.
3. After commit: `listener.onConsultationChanged({ kind: 'booked', … })` (failure logged without data, never thrown). Return the entity; controller renders unhydrated participants, `201`.

`reschedule(actor, id, input)`:
0. admin and `reason` absent/blank → `400` (no DB).
1. Transaction: `findById` (absent, or patient not owner → `404`) → `doctors.lockBookingTarget(row.doctorUserId, trx)` (lock order profile → consultation, matching schedule writes) → `findByIdForUpdate`.
2. `status !== 'booked'` → `409 InvalidTransition`.
3. patient and `row.startsAt − now < CANCELLATION_POLICY_MINUTES` (including a start already past) → `409 PolicyWindowViolation`. Exactly 120:00 before start is allowed; 119:59.999 is not. Admin: no window.
4. new start equals current → return the row unchanged (`200`, no write, no audit, no outbox).
5. `!doctor.isBookable` → `409 DoctorNotBookable`; past/horizon as booking; grid check uses the **stored interval length** (duration snapshot; later type edits never change an existing row) → `422 OutsideWorkingHours`.
6. `rescheduleRow` (zero rows → `InvalidTransition`; `23P01` → `SlotUnavailable` via the same outer mapping). Clears the follow-up flag and the two reminder columns.
7. `enqueue` `rescheduled` to both parties; audit `consultation.rescheduled`. After commit: listener.

`cancel(actor, id, input)`:
0. doctor/admin and `reason` absent/blank → `400` (no DB).
1. Transaction: `findByIdForUpdate` (non-participant → `404`).
2. `status ∉ {booked, waiting}` → `409 InvalidTransition`.
3. patient and inside the window → `409 PolicyWindowViolation`. Doctor: assigned only; admin: any time.
4. `applyTransition(id, ['booked','waiting'], { cancelled_at: now, cancelled_by: role, cancelled_by_user_id, cancel_reason })`; zero rows → `InvalidTransition` (a racing transition).
5. `enqueue` `cancelled` to both parties; audit `consultation.cancelled`. After commit: listener.
A retried cancel with a **new** key (or after Redis loss) is `409 InvalidTransition` — accepted: cancel's idempotency is Redis-only.

`hasConsultationRelationship(doctorUserId, patientUserId)` → `hasRelationship` (implements `PatientRelationshipChecker`).

**`ConsultationQueriesService`** — `list(actor, query)`: reject admin-only filters for non-admin (`Forbidden`); doctor viewer → `doctors.findTimezone`; one `listPage`; build page; collect distinct counterpart ids; **one** `identity.getUsersBatch(ids, currentRequestIdOrNew())` (admin: both sides); render. `get(actor, id, timezone?)`: participants — one transaction `findById` + `audit.record('consultation.read', { viewerRole })`; admin — plain read, no audit; non-participant defence in depth → `NotFound`; hydrate after the transaction. The batch never throws (degraded → `profileHydrated:false`); an unexpected throw from hydration is caught and treated as degraded.

**Ports.**
- `ScheduleImpactProvider` (`buildScheduleImpactProvider(getSchedules: () => SchedulesService, …)`, registered with `useFactory`, the same lazy pattern as `ScheduleOwnerResolver`, because `SchedulesService` injects the provider):
  - `findAffected(ctx, trx)`: candidates = future (`ends_at > ctx.now`) `booked/waiting/in_progress` rows of `ctx.doctorUserId`; for `working_hours` all of them, for `schedule_exception_created {fromDate,toDate}` / `schedule_exception_deleted {date}` only rows overlapping the UTC window `[localInstant(fromDate,0,tz,'start'), localInstant(toDate,1440,tz,'end'))`. `days = schedules.resolveOpenDays(ctx.doctorProfileId, ctx.timezone, minLocalDate − 1, maxLocalDate + 1, trx)` — reads the **new** state through `trx`. A candidate is affected when `!isCoveredByOpenIntervals(days, startMs, endMs)` (containment in one open interval; the slot grid is **not** re-checked, so a shifted shift anchor does not flag every booking). Returns ascending ids. Cost: 3 queries.
  - `flagAffected(ctx, ids, trx)`: `flagConsultations(ids, doctorUserId, 'schedule_blocked', trx)`; `notifications.enqueue(trx, schedule_blocked → each patient)`. No per-consultation audit (the port carries no actor; `schedule.conflicts_confirmed` already lists the first 20 ids).
- `SuspensionImpactProvider`: `flagFutureConsultations(ctx, trx)` → `flagFutureForDoctor(…, 'doctor_suspended')`, ids ascending (the service writes `consultation.flagged_for_followup`); `listFlaggedConsultations(ctx, conn)` → `listFlaggedIds`. No outbox rows (no suspension notification kind exists).
- `PatientRelationship` token: `useFactory: c => c.resolve(TOKENS.ConsultationsService)`.
- `ConsultationChangeListener`: `onConsultationChanged({ kind: 'booked'|'rescheduled'|'cancelled', doctorUserId, consultationId })`; default no-op, `registerSingleton`.

**Cross-module additions.**
- `DoctorsService.lockBookingTarget(userId, trx)` / `findBookingTarget(userId, conn)` → `BookingDoctor { profileId, userId, timezone, isSuspended, isBookable }` (`isBookable` computed with the existing pure function and `SchedulesService.hasActiveConsultationType`); `findTimezone(userId, conn)`.
- `SchedulesService.findBookableType(profileId, typeId, conn)` → live active type or `undefined`; `resolveOpenDays(profileId, timezone, fromDate, toDate, conn)` → `OpenDay[]` (two queries: `listLiveHours`, `listExceptionsInRange`, then `resolveOpenIntervals`).
- `PatientsService.getForViewer(actor, patientUserId)`: patient → only own id else `NotFound`; loads `findProfileByUserId(patientUserId)` (absent → `NotFound`); `audit.record` `patient_profile.read` `{ patientUserId, viewerRole }` in a transaction, then returns. `PatientProfileResponseDto.from` now accepts a patient viewer who owns the profile **or a doctor viewer**; an admin viewer still throws.

### 3.7 Pure code
`pkg/slots/slot-fit.ts` (no clock, no I/O, luxon-free integer math on epoch ms):
- `isSlotOnGrid(days: readonly OpenDay[], startMs, durationMinutes): boolean` — true iff some single open interval `i` satisfies `i.startMs <= startMs`, `startMs + dur <= i.endMs` and `(startMs − i.startMs) % (dur · 60000) === 0`. The grid is anchored on the working interval's start and steps by the duration; **busy consultations do not move the grid** ("resume at the next grid point" of the scheduling doc = the next point of the same grid), so this matches `scheduling-slots.md` step 6 without deviation. Overlap is the constraint's job.
- `isCoveredByOpenIntervals(days, startMs, endMs): boolean` — containment in one interval.
- Intervals are per doctor-local date, **not merged across dates** (a slot may not straddle local midnight even if hours are continuous); the future `availability` module must use these same functions so the slot list and the booking check cannot disagree.
- `pkg/utils/time.ts` `toIsoInZone(ms, timezone)` → `DateTime.fromMillis(ms,{zone}).toISO({suppressMilliseconds:true})`.

### 3.8 Policies (`policies.ts`, factory taking the repository-backed resolvers and `DoctorsService`)
`book`: patient, `self`, `accountState { emailVerified: true }`. `list`: patient/doctor/admin, `none`, `audit` unset. `get`: all three roles, resolver `consultation_participant_or_admin` (admin → allow without a query; patient/doctor → `SELECT 1 … WHERE id=$1 AND (patient_user_id=$2 OR doctor_user_id=$2) AND deleted_at IS NULL`), `audit: "clinical-read"`. `reschedule`: patient/admin, resolver `consultation_patient_or_admin`, `audit: "admin-action"`. `cancel`: three roles, participant resolver, `checks: [doctorNotSuspendedCheck]`, `audit: "admin-action"`. In `patients`: `getById` roles patient/doctor, resolver `consulted_patient_or_self` (uses the `PatientRelationshipChecker`), `checks: [doctorNotSuspendedCheck]`, `audit: "clinical-read"`.

### 3.9 Rate limits (module constants; `429` + `Retry-After`)
- Booking writes (book, reschedule, cancel): **10/min per user**, one shared bucket `consultations-write-user` for patient and doctor (CLAUDE.md "booking writes 10/min per user" read as all three writes).
- Admin on-behalf work gets its own bucket `consultations-write-admin` at 60/min per user (a suspension can flag dozens of rows). Both limiters sit in the chain; `byUserOfRoles(roles)` returns `null` (skip) for other roles.
- Reads: `consultations-read-user` 120/min per user.

### 3.10 No-store general fix (own task and commit, decision D4 / 1.5.4)
`src/routes.ts` exports `NO_STORE_PREFIXES = ["/api/patients", "/api/consultations", "/api/admin", "/api/audit-logs"]`; `src/app.ts` replaces the single `app.use("/api/patients", …)` with a loop `app.use(prefix, markPreAuth(noStore()))` placed **before** `express.json`, so parser errors (malformed JSON, oversize, wrong content type) and 401/404 under the prefix carry `Cache-Control: no-store`. The redundant per-router `router.use(…, noStore())` in `patients`, `admin-doctors` and `audit` are removed; doctors and verification routers are untouched. Tests: four integration tests, one malformed-JSON `POST` per prefix asserting `400` + `Cache-Control: no-store` (they fail before the change for `/api/consultations`, `/api/admin`, `/api/audit-logs`).

### 3.11 Env and DI
`BOOKING_HORIZON_DAYS` `z.coerce.number().int().min(1).max(365).default(60)`; `CANCELLATION_POLICY_MINUTES` `…int().min(0).max(10080).default(120)`. Tokens in 3.3. Registration order in `bootstrap.ts`: `Clock`, `NotificationsService`, `ConsultationChangeListener`, then the provider factories **replace** the two no-op registrations (the no-op classes remain for tests), `ConsultationsService`, `ConsultationQueriesService`, `PatientRelationship`, controller. Only `bootstrap.ts` wires `app/` into the container.

---

## 4. Business rules

| # | Rule | Enforced by |
|---|---|---|
| C-R1 | A doctor never has two overlapping live consultations; back-to-back is allowed; cancelled/no-show release the interval | `excl_consultations_doctor_no_overlap`; `23P01` → `409 SlotUnavailable` (book and reschedule) |
| C-R2 | Concurrent bookings of one slot: exactly one `201`, the rest `409 SlotUnavailable` | exclusion constraint |
| C-R3 | A booking start lies on the grid of one open interval of the doctor-local date (exceptions applied), evaluated in the doctor's timezone, re-validated in the transaction after the profile lock | `isSlotOnGrid` in the booking transaction |
| C-R4 | `startsAt <= now` → `BookingInPast`; `startsAt > now + 60 d` → `BeyondBookingHorizon` | service |
| C-R5 | `ends_at = starts_at + type.duration`; `price`/`currency` snapshot; none from the client | service + `chk_consultations_time_order` |
| C-R6 | Only a doctor who is approved, synced, not suspended, accepting and has an active type accepts bookings or reschedules; a suspended doctor is blocked immediately | `isBookable` under `FOR SHARE` on the profile (serializes with the suspension transaction) |
| C-R7 | Booking needs a verified email | `authorize` `accountState.emailVerified` |
| C-R8 | Same `Idempotency-Key` + same body replays the original; different body `422`; first request in flight `409 Conflict` + `Retry-After: 1`. After a Redis loss the DB row replays | Redis middleware; `uq_consultations_idempotency` + `request_hash` |
| C-R9 | Reschedule: only `booked`; patient not within `CANCELLATION_POLICY_MINUTES` of the **current** start (120:00 allowed, less not); admin any time with a `reason`; same row updated, old interval released atomically; reminder columns reset; follow-up flag cleared; same start is a `200` no-op | service + `UPDATE … WHERE status='booked'` + exclusion constraint |
| C-R10 | Reschedule keeps the stored interval length | service |
| C-R11 | Cancel: `booked`/`waiting` → `cancelled`; patient outside the window (reason optional); assigned doctor and admin need a `reason`; admin any time; terminal rows never change | service + `WHERE status = ANY($from)` + `chk_consultations_cancel_shape` |
| C-R12 | A locally suspended doctor cannot cancel | `doctor_not_suspended` check |
| C-R13 | Non-participants (and a doctor who is not assigned) get `404` on get/reschedule/cancel | ownership resolvers + service guard |
| C-R14 | Admin DTOs never carry `complaintText`; list items never carry it for any viewer | response DTO |
| C-R15 | A participant's get-one is audited (`consultation.read`) in the read transaction; admin get-one is not (no clinical field) | service |
| C-R16 | Every booked/rescheduled/cancelled change writes one audit row (any actor role) and its outbox rows in the same transaction | service |
| C-R17 | Outbox payloads hold ids, ISO instants, roles only (never reasons, complaint text, emails) | service + `NotificationsService` key allowlist |
| C-R18 | Schedule changes: future `booked/waiting/in_progress` rows outside the new open intervals are "affected"; unconfirmed → `409 ScheduleConflictsUnconfirmed` with their ids; confirmed → flagged `schedule_blocked`, patients queued, nothing cancelled or moved | `ScheduleImpactProvider` |
| C-R19 | Suspension flags future `booked/waiting/in_progress` rows `doctor_suspended` in the suspension transaction; never cancels | `SuspensionImpactProvider` |
| C-R20 | `GET /patients/{id}`: the patient themself, or a doctor with a `booked/waiting/in_progress/completed` consultation with that patient; admin `403`; others `404`; audited | resolver + `idx_…doctor_user_id_patient_user_id` |
| C-R21 | List scope and ordering per 3.1; admin-only filters are admin-only | service |
| C-R22 | `patientTimezone` is validated, canonicalized and snapshotted; no profile is read or written | service |
| C-R23 | Writes never call Identity; reads degrade on Identity failure and never `5xx` | service |

---

## 5. Cross-service behavior
- **Case 2 (degrade)** on `GET /consultations` and `GET /consultations/{id}`: one `getUsersBatch` call per page of distinct counterpart ids (client chunks ≥ 100), Redis `identity:user:<id>` TTL 300 s, at most one retry, `identity_hydration_degraded` emitted by the client. `fullName → displayName`; `status` unused. Misses/outage: `displayName:null, avatarUrl:null, profileHydrated:false`; the rows, times and prices are still returned. Writes are not hydrated (decision 1.5.5).
- **Case 3** is unchanged except that `flagFutureConsultations` now returns real ids (the existing `503`/retry policy is the admin-doctors module's).
- No other Identity call. Recipient emails are resolved by the delivery worker at send time (hub ADR 0010), never here.
- Platform changes: none.

## 6. Error codes
| Code | HTTP | When |
|---|---|---|
| `ValidationFailed` | 400 | DTO failure; missing/non-UUID `Idempotency-Key`; absent cancel body; `reason` missing for doctor/admin (cancel) or admin (reschedule); `followUpOfRecordId` supplied (C6); `from >= to`; bad `timezone`/`status`/cursor |
| `Unauthorized` / `TokenExpired` | 401 | token problems |
| `EmailNotVerified` | 403 | booking with `ev=false` |
| `Forbidden` | 403 | wrong role (admin on `/patients/{id}`), non-active account, suspended doctor on cancel / patient read, admin-only filter by a non-admin |
| `NotFound` | 404 | unknown or invisible consultation / patient; unknown doctor, unknown or inactive type on booking; non-numeric id |
| `DoctorNotBookable` | 409 | book / reschedule against a doctor failing C-R6 |
| `SlotUnavailable` | 409 | `23P01` |
| `PolicyWindowViolation` | 409 | patient reschedule/cancel inside the window |
| `InvalidTransition` | 409 | reschedule of a non-`booked`, cancel of a non-`booked/waiting`, or a racing transition (zero rows) |
| `Conflict` | 409 | same key still in flight (`Retry-After: 1`) |
| `OutsideWorkingHours` / `BookingInPast` / `BeyondBookingHorizon` | 422 | per C-R3 / C-R4 |
| `IdempotencyConflict` | 422 | same key, different body (Redis or DB) |
| `RateLimited` | 429 | limiter |
| `InternalError` | 500 | unhandled |
New codes: none (all exist in CLAUDE.md → API conventions); `errors.ts` exports the Care-owned ones.

## 7. Security & privacy
- **RBAC summary:** book = patient; reschedule = patient|admin; cancel = patient|doctor|admin; list/get = participants + admin (admin view without `complaintText`); `/patients/{id}` = patient self or related doctor, **admin denied**. Deny-by-default `authorize` on every route; the boot assertion covers the new router.
- **Audit:** `consultation.booked`, `.rescheduled`, `.cancelled`, `.read`, `patient_profile.read`; entity type `consultation` / `patient_profile`; metadata flat scalars: booked `{ doctorUserId, patientUserId, consultationTypeId, startsAt, endsAt }`; rescheduled `{ byRole, fromStartsAt, toStartsAt, reasonLength? }`; cancelled `{ byRole, fromStatus, reasonLength? }`; read `{ viewerRole }`; profile read `{ patientUserId, viewerRole }`. Never complaint text, reasons, names.
- **Never logged:** `complaintText`, `cancelReason`/reason text (add `cancelReason` to `REDACTED_KEYS`), request bodies of these routes, participant names/avatars, idempotency keys' bodies. Log lines carry ids and statuses only.
- **No-store** on every response of the four prefixes; patient timezone and times are not sensitive but are covered by the same header.
- **Existence:** book answers `409 DoctorNotBookable` for an existing non-bookable doctor (contract-defined; a minor id-probe, accepted).
- **Rate limits:** section 3.9. Files: not applicable.

## 8. Performance
Budgets: booking write p95 < 200 ms; list/get are not in the budget table (target p95 < 150 ms).
- **Book:** 9 statements in one transaction (replay lookup, profile `FOR SHARE`, active-type `EXISTS`, type by PK, hours, exceptions range, insert, outbox multi-row insert, audit); each indexed (`uq_consultations_idempotency`, `uq_doctor_profiles_user_id`, `idx_consultation_types_doctor_profile_id_active`, PK, `idx_working_hours_doctor_profile_id`, `uq_schedule_exceptions_doctor_profile_id_date`).
- **Reschedule:** ~11; **cancel:** 4 (lock row, update, outbox, audit).
- **List:** 1 query (+ doctor timezone for a doctor viewer) + 1 `getUsersBatch`; **get-one:** resolver 1 + read 1 + audit 1 (+ timezone) + batch. EXPLAIN tests assert: patient/doctor lists use their `(…_user_id, starts_at, id)` index in both directions; the follow-up queue uses `idx_consultations_followup_starts_at_id`; the admin unfiltered list uses `idx_consultations_starts_at_id`; relationship uses the partial index; no seq scan on any of them.
- **Impact provider:** 3 queries + in-memory math for ≤ ~62 dates; `findAffected` over 200 consultations < 20 ms (unit benchmark guard).
- No N+1: hydration is one call per page; outbox rows are one multi-row insert.

## 9. Test plan outline
Unit (`tests/unit/`, fake clock via `TOKENS.Clock`, mocked collaborators): `slot-fit` (grid anchored on the interval start, split shifts, `custom_hours`, `24:00`, DST forward/back with real elapsed minutes, off-grid, past interval end, no cross-date straddle); `toIsoInZone`; DTO validation tables; response DTO viewer matrix (admin has no `complaintText`; list omits it; write responses carry unhydrated participants; zone defaults); policies (roles, resolver decisions incl. non-numeric id, `doctor_not_suspended`); service rules C-R3..C-R13 with each error code and check order (replay → profile → bookable → type → past → horizon → grid → insert); policy window edges (120:00 allowed, 119:59.999 violation, start already past); `23P01` and `uq_consultations_idempotency` mapping; terminal-state guard (zero rows → `InvalidTransition`); providers (`findAffected` candidate window per change kind, containment, ascending ids; `flagAffected` writes outbox rows; suspension flag/list); `byUserOfRoles`, `ToCommaList`, `exclusionViolationConstraint`; redaction row for `cancelReason`.
Integration (`tests/integration/consultations.test.ts`, `patients.test.ts` additions, `no-store.test.ts`; real Postgres/Redis, fake Identity, fixtures approve a doctor with `ownerDb` and create hours/type via the real schedules routes):
- Two concurrent bookings of one slot → exactly one `201`, one `409 SlotUnavailable`; same key twice → same consultation (Redis replay), key replay after `FLUSHALL` → DB replay; same key + different body → `422`; in-flight → `409` + `Retry-After`; missing key → `400` on all three writes.
- DST booking: doctor `Europe/Berlin` across 2026-10-25 and `America/New_York` across 2026-11-01 (fixed clock): local start on the grid before/after the change books; an off-grid minute → `OutsideWorkingHours`; `startsAtLocal` offsets differ across the change.
- Eligibility: unapproved, unsynced, suspended, not accepting, no active type → `409 DoctorNotBookable`; `ev=false` → `403 EmailNotVerified`; suspension racing a booking (booking waits on `FOR SHARE`, then the suspension flags the new row).
- Reschedule: patient outside/inside window, admin without/with reason, non-`booked` → `InvalidTransition`, `23P01` → `SlotUnavailable`, reminder columns reset, flag cleared, same start no-op; cancel: patient/doctor/admin matrix with reason rules, terminal → `InvalidTransition`, slot bookable again after cancel, suspended doctor `403`.
- RBAC per route (wrong role, non-owner `404`, doctor not assigned `404`, owner allowed, **admin denied on `/patients/{id}`**, admin DTO without `complaintText`, patient `403` on admin-only filters).
- Case 2: one `getUsersBatch` per list page (fake counts requests), Identity down → rows with `profileHydrated:false` and `200`; write responses carry unhydrated participants; page 2 on the default sort; `scope`, `status`, `from/to`, follow-up queue ordering; `timezone` default per role.
- Audit: booked/rescheduled/cancelled/read/`patient_profile.read` rows with clinical-free metadata; outbox rows in the same transaction (rollback leaves none) with allowlisted payload keys.
- Ports E2E with the real provider: `PUT working-hours`, `POST exceptions`, `DELETE` of a `custom_hours` exception each return `409 ScheduleConflictsUnconfirmed` with real ids (contract `ScheduleConflicts`), then `confirmConflicts=true` flags rows `schedule_blocked`, queues `schedule_blocked` outbox rows and writes `schedule.conflicts_confirmed`; suspension flags `doctor_suspended` rows and returns their ids; no-op suspend lists them.
- `/patients/{id}`: related doctor `200` + audit; unrelated doctor / other patient `404`; self `200`; suspended doctor `403`; cancelled-only relationship `404`.
- Log hygiene: captured logs contain no complaint/reason fixture strings. Contract conformance (`tests/unit/contract/consultations-contract.test.ts`). Migrations round-trip (2.3). EXPLAIN assertions (section 8). Booking-path timing guard.
- No-store: four malformed-JSON tests (3.10).

## 10. Out of scope
`join`, `start`, `complete`, `no-show`, `waiting-room`, `calendar`, `lib/video` (sessions unit); `/patients/{id}/records`, `hasRecord` truth, the `follow_up_of_record_id` FK (records); doctor search, slots endpoint, `next-available`, cache implementation (discovery); outbox delivery, reminder scan, `OUTBOX_*` env, outbox `UPDATE/DELETE` grants and claim/purge indexes (notification/worker unit, ADR 0011); doctor-initiated follow-up booking; **impact check for a doctor timezone change** via `PATCH /doctors/me` (recorded as deferred in the doctors and schedules specs — it can reuse `ScheduleImpactProvider` with `change.kind='working_hours'`; needs a `confirmConflicts` contract edit and its own unit); an endpoint to dismiss a follow-up flag without cancel/reschedule (admins use reschedule/cancel; reschedule clears the flag); patient double-booking across doctors; notifications for suspension.

## 11. Open questions
No undecided design question remains; items below are the pending actions.

**Contract changes required** (edit `contracts/openapi.yaml` first, before code; all are description/behavior clarifications, no shape change):
- **C1** `listConsultations`: `upcoming` = `endsAt > now`, `past` = `endsAt <= now`, `all` ascending; admin follow-up filter implies `booked/waiting/in_progress`.
- **C2** `listConsultations`: admin-only filters by a non-admin → `403 Forbidden`.
- **C3** `listConsultations` / `getConsultation` / `Consultation`: `timezone` honored for every role; defaults patient `patientTimezone`, doctor the doctor's zone, admin `UTC`.
- **C4** `cancelConsultation`: patient window = 120 minutes (`CANCELLATION_POLICY_MINUTES`), `reason` required for doctor/admin (`400`).
- **C5** `Consultation` / `listConsultations`: list items omit `complaintText` for every viewer.
- **C6** `bookConsultation`: `followUpOfRecordId` → `400 ValidationFailed` until `records` ships.
- **C7** `rescheduleConsultation` / `cancelConsultation`: audit row written for any caller; `x-audit: admin-action` is the policy class.
- **C8** `getPatientProfile`: suspended doctor `403`; profile not yet created and non-numeric id `404`.
- **C9** `Consultation.hasRecord`: `false` until `records` ships.

**Platform changes required (/system-design):** none.

**Docs to refresh at `/update-docs`** (not contract/platform): `architecture/data-model.md` (follow-up index predicate, new `idx_consultations_starts_at_id`, outbox indexes deferred, deferred FK), `api.md`, `rbac.md`, `consultation-lifecycle.md`, `scheduling-slots.md` (as-built `slot-fit`, per-date intervals), `infrastructure.md` (two new env vars), `integration.md`, `docs/service-card.md` (**affected**: new tables, endpoints, dependencies), `patients/spec.md` (the planned `/patients/{id}` access is now built), `schedules/spec.md` §10 task done.

## 12. Task ordering (CLAUDE.md → Build order for a new module)
0. Contract edits C1-C9. 
1. No-store prefix fix (own commit + four tests, 3.10). Generic helpers (`pg-errors`, `subjects`, `ToCommaList`, `currentRequestIdOrNew`, `Clock`, redaction key) with unit tests.
2. Migrations 2.1, 2.2 (+ migration tests).
3. `pkg/slots/slot-fit.ts`, `toIsoInZone` (+ exhaustive unit tests).
4. `enums.ts`, `errors.ts`, `types.ts`, `constants.ts`; env additions; entity; `notifications` module.
5. Request/response DTOs; repository.
6. Cross-module service methods (`doctors`, `schedules`, `patients.getForViewer`); services; providers; listener; DI tokens and `bootstrap.ts` rebinding.
7. `policies.ts`; controller; `routes.ts`; mount (+ `patients` route/policy for `/patients/{id}`).
8. Tests (unit, integration, RBAC, contract, concurrency, ports E2E, EXPLAIN).
9. Manual QA with CURL (`scripts/curl-test-consultations.sh`), docs (section 11 list).
