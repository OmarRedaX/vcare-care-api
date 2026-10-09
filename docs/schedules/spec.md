---
title: schedules — Spec
owner: care-team
service: care-service
module: schedules
status: implemented
version: 1.1.0
diataxis: reference
last_verified: 2026-10-09
tags: [spec, schedules, working-hours, exceptions, consultation-types, pkg-slots, dst, conflicts, audit, migration]
related: [schedules-brainstorm, doctors-spec, verification-spec, access-spec, scheduling-slots, data-model, api, rbac, adr-0002-slots-never-stored, adr-0010-next-available-lazy-cache-worker-refresh, adr-0017-generic-helpers-and-transaction-scoping, adr-0018-db-role-split-explicit-grants-partition-function, adr-0019-luxon-for-doctor-timezone-validation]
contracts: [contracts/openapi.yaml]
---

# schedules — Spec

The doctor's **availability inputs**: recurring weekly hours, per-date exceptions, and consultation types (duration +
price), with eight self-owned routes, three tables, and the pure `pkg/slots` open-interval resolver. It sits on the
`access` base (`userGuard` → `authorize(policy)` → `AuditRecorder.record(trx, …)`), reuses the `doctor_not_suspended`
check of `doctors`, and wires the last term of `isBookable` (Domain rule 6) into `doctors`.

Scope follows [brainstorm.md](./brainstorm.md) and the four user decisions of 2026-10-08 (conflict ports, `pkg/slots`
scope, `isBookable` wiring, type currency). Slot endpoints, busy-interval subtraction, slicing, the `slots:*` /
`next-available:*` caches and search are `availability`; the `consultations` table, `needs_admin_followup` flagging and
patient notifications are `consultations`. This slice makes **no cross-service call** (no Identity, storage, video,
email).

Binding rules: CLAUDE.md → "Database rules", "API conventions", "Authorization — RBAC and ownership", "Privacy and
logging", "Domain rules" (2, 3, 4, 6, 22), "Testing policy", "Performance rules", "Build order for a new module".
Precedents: [doctors/spec.md](../doctors/spec.md) (routes, policies, audit, DTO style, `isBookable`),
[verification/spec.md](../verification/spec.md) (as-built patterns), [architecture/scheduling-slots.md](../architecture/scheduling-slots.md)
and the `timezone-slot-computation` skill (algorithm).

---

## 1. Overview

### 1.1 What `schedules` owns in this slice
| Area | Delivers |
|---|---|
| Tables | `working_hours`, `schedule_exceptions`, `consultation_types` (three migrations, raw SQL) |
| Routes | `GET/PUT /api/doctors/me/working-hours` · `GET/POST /api/doctors/me/exceptions` · `DELETE /api/doctors/me/exceptions/{id}` · `GET/POST /api/doctors/me/consultation-types` · `PATCH /api/doctors/me/consultation-types/{id}` (role `doctor`, ownership `self`) |
| Pure library | `src/pkg/slots`: open-interval resolution (hours + exceptions → merged UTC intervals per doctor-local date), DST gap/overlap, `24:00` |
| Ports (DI tokens) | `ScheduleImpactProvider` (inside the transaction), `ScheduleChangeListener` (after commit), `ScheduleOwnerResolver` (profile lookup/lock; breaks the `doctors` ↔ `schedules` cycle); no-op defaults registered in `bootstrap.ts` |
| Audit | `schedule.hours_replaced`, `schedule.exception_created`, `schedule.exception_deleted`, `schedule.conflicts_confirmed`, `consultation_type.created`, `consultation_type.updated` |
| Doctors change | `isBookable`'s active-type term is computed from `SchedulesService.hasActiveConsultationType` (D-R12) |
| Env / dependencies | none (`luxon` pinned by ADR 0019; `ALLOWED_CURRENCIES` exists). No new ADR |
| Contract | edits C1–C6 (§11), applied in `/develop` step 0 |

### 1.2 Principles
- **Inputs, not slots.** Nothing computed is stored ([ADR 0002](../adr/0002-slots-never-stored.md)); this module stores only
  the inputs and ships the pure resolver that later modules call.
- **Self only.** Every route acts on the caller's live profile resolved from `auth.userId`; no id in a path or body can name
  another doctor. A foreign or absent row id is `404 NotFound`.
- **One lock per doctor.** Every write takes `SELECT … FOR UPDATE` on the caller's `doctor_profiles` row first, so two writes
  of one doctor serialize (race-free `PUT`, cap, uniqueness) and the suspension flag is re-read under the lock.
- **Audit in the write's transaction**; metadata holds ids, counts, dates and statuses, never the exception `reason` text.
- **Schedule changes never move bookings.** Conflicts are listed, require `confirmConflicts=true`, then flagged — never auto-cancelled.
- **The seams are honest.** Until `consultations` and `availability` land, the impact provider returns `[]` and the listener
  does nothing; the 409 path is proved with a stub provider only (§9.1), and its end-to-end test is a task of the `consultations` spec (§10).

### 1.3 Dependencies
- **Other modules:** `doctors` (profile row: id, timezone, currency, suspension) — through `DoctorsService` only, via the
  `ScheduleOwnerResolver` port; `doctors` in turn calls `SchedulesService.hasActiveConsultationType`. No module imports another's repository.
- **Later modules that rebind the seams:** `consultations` → `ScheduleImpactProvider`; `availability` → `ScheduleChangeListener`; both call `pkg/slots`.
- **Other service:** none. Platform deltas: none.

---

## 2. Database schema

### 2.1 Migrations (proposed names; `npm run migrate:make` assigns the timestamps, all after `20261007120300`)
| # | File (`src/migrations/<ts>_<name>.ts`) | Change |
|---|---|---|
| 1 | `<ts>_create_working_hours` | table, checks, overlap exclusion, partial index, comments, grants |
| 2 | `<ts>_create_schedule_exceptions` | table, checks, live-date unique index, comments, grants |
| 3 | `<ts>_create_consultation_types` | table, checks, name unique + active partial indexes, comments, grants |

One change per file, each statement its own `await knex.raw(...)`, run as the owner (`MIGRATION_DATABASE_URL`). `down` drops
the table (no `CASCADE`); no migration depends on `consultations` (its FK to `consultation_types` is added by that module's
migration). All three FKs reference `doctor_profiles(id) ON DELETE RESTRICT`.

### 2.2 Migration 1 — `working_hours`
```sql
CREATE TABLE working_hours (
    id                 BIGSERIAL PRIMARY KEY,
    doctor_profile_id  BIGINT NOT NULL,
    weekday            SMALLINT NOT NULL,              -- ISO 1 = Monday … 7 = Sunday, doctor-local
    start_time         TIME NOT NULL,                  -- doctor-local wall clock, no default
    end_time           TIME NOT NULL,                  -- '24:00:00' = next local midnight; no default
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at         TIMESTAMPTZ,
    CONSTRAINT fk_working_hours_doctor_profile_id FOREIGN KEY (doctor_profile_id) REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
    CONSTRAINT chk_working_hours_weekday CHECK (weekday BETWEEN 1 AND 7),
    CONSTRAINT chk_working_hours_time_order CHECK (end_time > start_time),
    CONSTRAINT chk_working_hours_whole_minutes CHECK (EXTRACT(SECOND FROM start_time) = 0 AND EXTRACT(SECOND FROM end_time) = 0),
    -- Safety net behind the service's overlap validation: two live intervals of one doctor on one weekday never overlap
    -- (half-open, so touching intervals such as 09:00-12:00 and 12:00-14:00 are allowed). Needs btree_gist (migration 20260915000000).
    CONSTRAINT excl_working_hours_no_overlap EXCLUDE USING gist (
        doctor_profile_id WITH =, weekday WITH =,
        int4range((EXTRACT(EPOCH FROM start_time))::int, (EXTRACT(EPOCH FROM end_time))::int, '[)') WITH &&
    ) WHERE (deleted_at IS NULL)
);
COMMENT ON TABLE working_hours IS 'Recurring weekly hours in the doctor timezone; several rows per weekday = split shifts. PUT soft-deletes the old set and inserts the new one (vcare_app has no DELETE).';

-- GET /doctors/me/working-hours and the PUT read of the current set:
--   SELECT … FROM working_hours WHERE doctor_profile_id = $1 AND deleted_at IS NULL ORDER BY weekday, start_time
-- Leading column doctor_profile_id also covers fk_working_hours_doctor_profile_id (parent rows are never deleted).
CREATE INDEX idx_working_hours_doctor_profile_id ON working_hours (doctor_profile_id, weekday, start_time) WHERE deleted_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON working_hours TO vcare_app;     -- UPDATE sets deleted_at; no DELETE, no TRUNCATE
GRANT USAGE ON SEQUENCE working_hours_id_seq TO vcare_app;
```
The exclusion constraint is an addition to `data-model.md` (documented in §13). A violation (`23P01`) can only follow a service
bug; it is not mapped and surfaces as `500 InternalError` (the transaction rolls back, nothing is half-written).

### 2.3 Migration 2 — `schedule_exceptions`
```sql
CREATE TABLE schedule_exceptions (
    id                 BIGSERIAL PRIMARY KEY,
    doctor_profile_id  BIGINT NOT NULL,
    date               DATE NOT NULL,                  -- doctor-local date
    type               VARCHAR(16) NOT NULL,           -- no default
    start_time         TIME,
    end_time           TIME,
    reason             VARCHAR(500),                   -- free text: never logged, never audited
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at         TIMESTAMPTZ,
    CONSTRAINT fk_schedule_exceptions_doctor_profile_id FOREIGN KEY (doctor_profile_id) REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
    CONSTRAINT chk_schedule_exceptions_type CHECK (type IN ('day_off', 'custom_hours')),
    CONSTRAINT chk_schedule_exceptions_shape CHECK (
        (type = 'day_off' AND start_time IS NULL AND end_time IS NULL)
     OR (type = 'custom_hours' AND start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time)),
    CONSTRAINT chk_schedule_exceptions_whole_minutes CHECK (
        (start_time IS NULL OR EXTRACT(SECOND FROM start_time) = 0) AND (end_time IS NULL OR EXTRACT(SECOND FROM end_time) = 0))
);
COMMENT ON TABLE schedule_exceptions IS 'Per-date overrides in the doctor timezone: day_off removes the date, custom_hours replaces that weekday''s hours. Soft delete only.';

-- One live exception per doctor-local date; also the FK index. Serves:
--   POST /doctors/me/exceptions (23505 on a taken date → 409 Conflict),
--   GET  /doctors/me/exceptions: WHERE doctor_profile_id = $1 AND deleted_at IS NULL AND date BETWEEN $from AND $to
--        AND (date, id) > ($cursorDate, $cursorId) ORDER BY date, id LIMIT $n + 1,
--   and the future slot-computation query WHERE doctor_profile_id = $1 AND date BETWEEN $from - 1 AND $to + 1.
CREATE UNIQUE INDEX uq_schedule_exceptions_doctor_profile_id_date ON schedule_exceptions (doctor_profile_id, date) WHERE deleted_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON schedule_exceptions TO vcare_app;
GRANT USAGE ON SEQUENCE schedule_exceptions_id_seq TO vcare_app;
```
`uq_schedule_exceptions_doctor_profile_id_date` is a partial unique **index** (not a table constraint); the service maps `23505`
by `error.constraint = 'uq_schedule_exceptions_doctor_profile_id_date'` (the index name), as doctors does for its profile index.

### 2.4 Migration 3 — `consultation_types`
```sql
CREATE TABLE consultation_types (
    id                 BIGSERIAL PRIMARY KEY,
    doctor_profile_id  BIGINT NOT NULL,
    name               VARCHAR(100) NOT NULL,
    duration_minutes   INT NOT NULL,                   -- no default
    price              INT NOT NULL,                   -- minor units; no default
    currency           CHAR(3) NOT NULL,               -- no default
    is_active          BOOLEAN NOT NULL,               -- no default: the INSERT states true
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at         TIMESTAMPTZ,
    CONSTRAINT fk_consultation_types_doctor_profile_id FOREIGN KEY (doctor_profile_id) REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
    CONSTRAINT chk_consultation_types_duration CHECK (duration_minutes BETWEEN 5 AND 240),
    CONSTRAINT chk_consultation_types_price CHECK (price >= 0),
    CONSTRAINT chk_consultation_types_currency CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT chk_consultation_types_name_length CHECK (char_length(name) >= 2)     -- contract minLength 2
);
COMMENT ON TABLE consultation_types IS 'Duration + price a doctor offers. Deactivated (is_active), never removed in MVP; deleted_at exists for the soft-delete pattern but no route sets it.';

-- Unique live name per doctor (23505 → 409 Conflict); leading column covers fk_consultation_types_doctor_profile_id. Serves:
--   GET /doctors/me/consultation-types: WHERE doctor_profile_id = $1 AND deleted_at IS NULL [AND is_active = $2] AND id > $cursor ORDER BY id LIMIT $n + 1
--   (≤ 20 live rows per doctor, so the id sort over the index range is trivial), and the cap count
--   SELECT count(*) FROM consultation_types WHERE doctor_profile_id = $1 AND deleted_at IS NULL.
CREATE UNIQUE INDEX uq_consultation_types_doctor_profile_id_name ON consultation_types (doctor_profile_id, name) WHERE deleted_at IS NULL;
-- Domain rule 6 "at least one active type" (isBookable): SELECT 1 FROM consultation_types WHERE doctor_profile_id = $1 AND is_active AND deleted_at IS NULL LIMIT 1
CREATE INDEX idx_consultation_types_doctor_profile_id_active ON consultation_types (doctor_profile_id) WHERE is_active AND deleted_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON consultation_types TO vcare_app;
GRANT USAGE ON SEQUENCE consultation_types_id_seq TO vcare_app;
```
`chk_consultation_types_name_length` is the only addition to the data-model definition besides the whole-minute checks and the
`working_hours` exclusion. `uq_consultation_types_doctor_profile_id_name` is case-sensitive (no `lower()`); `First visit` and
`first visit` are different names.

---

## 3. API contract and file-level design

### 3.1 Endpoints (mirror `contracts/openapi.yaml` after the C1–C6 edits; the contract wins on disagreement)

Common to all eight: guard `userGuard()` · **roles** `doctor` (`x-roles`) · **ownership** `self` — the caller's live profile by
`auth.userId`, every row scoped by that profile id (`x-ownership: self`) · account state: token `status=active` **and** not locally
suspended (`doctor_not_suspended` check; `x-account-state`) — `pending`/`rejected`/`suspended` tokens and patients/admins → `403 Forbidden` ·
a caller without a live profile → `404 NotFound` · `Cache-Control: no-store` not required.

| Operation | Method / path | Success | Errors | Rate limit | `Idempotency-Key` | Audit (`x-audit-actions`) |
|---|---|---|---|---|---|---|
| `getMyWorkingHours` | `GET /api/doctors/me/working-hours` | 200 `WorkingHours` | 401, 403, 404, 429, 500 | read | n/a | — |
| `replaceMyWorkingHours` | `PUT /api/doctors/me/working-hours` | 200 `WorkingHours` | 400, 401, 403, 404, **409 `ScheduleConflictsUnconfirmed`**, 429, 500 | write | not declared → ignored | `schedule.hours_replaced`, `schedule.conflicts_confirmed` |
| `listMyExceptions` | `GET /api/doctors/me/exceptions` | 200 `ScheduleException[]` + `meta` | 400, 401, 403, 404 (C2), 429, 500 | read | n/a | — |
| `createMyException` | `POST /api/doctors/me/exceptions` | 201 `ScheduleException[]` | 400, 401, 403, 404 (C2), **409** `ScheduleConflictsUnconfirmed` / `Conflict`, 422 `IdempotencyConflict`, 429, 500 | write | **optional** (`idempotency({ required: false })`) | `schedule.exception_created`, `schedule.conflicts_confirmed` |
| `deleteMyException` | `DELETE /api/doctors/me/exceptions/{id}?confirmConflicts` | 204 | 400 (C1), 401, 403, 404, **409 `ScheduleConflictsUnconfirmed`** (C1), 429, 500 | write | not declared → ignored | `schedule.exception_deleted`, `schedule.conflicts_confirmed` (C1) |
| `listMyConsultationTypes` | `GET /api/doctors/me/consultation-types` | 200 `ConsultationType[]` + `meta` | 400, 401, 403, 404 (C2), 429, 500 | read | n/a | — |
| `createMyConsultationType` | `POST /api/doctors/me/consultation-types` | 201 `ConsultationType` | 400, 401, 403, 404 (C2), 409 `Conflict`, 422, 429, 500 | write | **optional** | `consultation_type.created` |
| `updateMyConsultationType` | `PATCH /api/doctors/me/consultation-types/{id}` | 200 `ConsultationType` | 400, 401, 403, 404, 409 `Conflict`, 429, 500 | write | not declared → ignored | `consultation_type.updated` |

Rate limits (decided): all five writes **30/min per user** (`schedules-write-user`), the three reads **120/min per user**
(`schedules-read-user`, the doctors precedent); window 60 s; `429 RateLimited` + `Retry-After`. Neither figure is in CLAUDE.md's
table; both are module constants (`SCHEDULES_WRITE_USER_LIMIT`, `SCHEDULES_READ_USER_LIMIT`).

A path `id` that is not a positive safe integer answers `404 NotFound` (specialties precedent; the contract's `IdPath` says
non-numeric values never match). `X-User-Id`, `X-Role` and any other identity header are ignored; no body member influences authorization.

#### 3.1.1 `GET /api/doctors/me/working-hours`
Response `data`: `{ timezone, days: [{ weekday, intervals: [{ startTime, endTime }] }] }` — `timezone` from the profile; `days`
ascending by `weekday`, weekdays without intervals omitted; `intervals` ascending by `startTime`; times `HH:mm` (`24:00` for
`24:00:00`). A doctor who never set hours gets `days: []` (200).

#### 3.1.2 `PUT /api/doctors/me/working-hours`
Body `WorkingHoursReplace` `{ days: WorkingHoursDay[] (≤ 7), confirmConflicts?: boolean }`; unknown members → 400.
- Validation (all `400 ValidationFailed`, `details[].field` like `days[2].intervals`, values never echoed): `weekday` 1–7 and **one
  entry per weekday** (duplicate → 400); 1–6 intervals per day; `startTime`/`endTime` match `TimeOfDay`; `endTime > startTime`
  (so `24:00` is valid only as an end); intervals of one weekday must not overlap (touching allowed); `days: []` is valid and clears all hours.
- Effect: §3.9 `replaceWorkingHours`. Identical set (compared after sorting) → `200` with the current set, **no write, no audit, no provider call, no listener** (S-R3).
- `409 ScheduleConflictsUnconfirmed` body: `{ success:false, error:{ code, message, details:[], requestId }, conflicts:{ consultationIds:[…], count } }`
  (sibling member via `AppError.withExtra`); `consultationIds` ascending, `count = consultationIds.length ≥ 1`.
- Response `data`: the new set, same shape as §3.1.1.

#### 3.1.3 `GET /api/doctors/me/exceptions`
Query: `cursor`, `limit` (1–100, default 20), `fromDate` (default **today in the doctor's timezone**), `toDate` (optional, inclusive);
both `YYYY-MM-DD` real calendar dates, `fromDate ≤ toDate` else 400. Order `(date ASC, id ASC)`; cursor `(date, id)`; fetch `limit + 1`;
`meta: { nextCursor, hasMore, count }`. Past exceptions are reachable by passing an earlier `fromDate`.
Response item `ScheduleException`: `{ id, date, type, startTime | null, endTime | null, reason | null, createdAt }`.

#### 3.1.4 `POST /api/doctors/me/exceptions`
Body `ScheduleExceptionCreate` `{ type, date, endDate?, startTime?, endTime?, reason?, confirmConflicts? }`:
- `type=day_off`: `startTime`/`endTime` must be absent; `endDate` optional, `date ≤ endDate`, **at most 60 dates inclusive** (`endDate ≤ date + 59 days`, C3); one row per local date.
- `type=custom_hours`: `startTime` and `endTime` required, `endTime > startTime` (`24:00` allowed as end); `endDate` must be absent; exactly one row.
- `date` (and every date of the range) must be **≥ today in the doctor's timezone**, else `400` (`details[].field = "date"`); a past date cannot change availability.
- `reason`: ≤ 500 code points, no NUL; `null` → 400 (contract type `string`).
- A live exception already on **any** date of the range → `409 Conflict` for the whole request, nothing created (`details[].field="date"`, no date echoed).
- `409 ScheduleConflictsUnconfirmed` when the new exceptions strand future non-terminal consultations and `confirmConflicts` is not `true`.
- Response `201` `data`: the created rows ascending by date.

#### 3.1.5 `DELETE /api/doctors/me/exceptions/{id}`
Query `confirmConflicts` (strict `true`/`false`, else 400; C1). Soft delete (`deleted_at`). An id absent, already deleted, or on another doctor's
profile → `404 NotFound`. Deleting a `day_off` can never strand a booking. Deleting a `custom_hours` whose date is ≥ today in the doctor's timezone
reverts that date to the weekday's hours and runs the impact check; an unconfirmed non-empty result → `409 ScheduleConflictsUnconfirmed` and the delete is rolled back.
Deleting a past exception skips the check. `204` has no body.

#### 3.1.6 `GET /api/doctors/me/consultation-types`
Query: `cursor`, `limit`, `isActive` (strict boolean). Order `id ASC`; cursor `(id, id)`. Live (non-deleted) types only.
Item `ConsultationType`: `{ id, name, durationMinutes, price, currency, isActive, createdAt, updatedAt }`.

#### 3.1.7 `POST /api/doctors/me/consultation-types`
Body `ConsultationTypeCreate` `{ name, durationMinutes, price, currency }`. Created with `isActive=true`. Rules:
`name` 2–100 code points, no control characters, at least one non-whitespace character; `durationMinutes` int 5–240; `price` int 0–2147483647 (C4);
`currency` must be `^[A-Z]{3}$`, in `ALLOWED_CURRENCIES` **and equal to the doctor's profile currency**, else `400` (`details[].field="currency"`);
duplicate live `name` → `409 Conflict` (`details[].field="name"`); more than **20** live types (active or inactive) → `409 Conflict` (`details[].field="consultationTypes"`, C5).

#### 3.1.8 `PATCH /api/doctors/me/consultation-types/{id}`
Body `ConsultationTypeUpdate`, every member optional, `{}` → `400` (`details[].field="body"`), `null` for any member → 400. Same value rules as create;
`currency`, when given, must equal the profile currency. `isActive` changes freely, including deactivating the last active type (the doctor stops being bookable
immediately, S-R14). Changes affect future bookings only. A request that changes nothing → `200` with the current row, no write, no audit, no listener.
Duplicate name → `409 Conflict`. Foreign/absent id → `404`.

### 3.2 Route composition (`src/app/schedules/routes.ts`)
```ts
export function buildSchedulesRouter(): Router {
    const router = Router();
    const controller = container.resolve<SchedulesController>(TOKENS.SchedulesController);
    const doctors = container.resolve<DoctorsService>(TOKENS.DoctorsService);
    const p = buildSchedulesPolicies(doctors);
    const writeLimit = () => rateLimit({ name: "schedules-write-user", limit: SCHEDULES_WRITE_USER_LIMIT, windowMs: SCHEDULES_RATE_WINDOW_MS, subject: byUser });
    const readLimit  = () => rateLimit({ name: "schedules-read-user",  limit: SCHEDULES_READ_USER_LIMIT,  windowMs: SCHEDULES_RATE_WINDOW_MS, subject: byUser });

    router.get   ("/doctors/me/working-hours",           userGuard(), authorize(p.getWorkingHours),     readLimit(),  controller.getWorkingHours);
    router.put   ("/doctors/me/working-hours",           userGuard(), authorize(p.replaceWorkingHours), writeLimit(), controller.replaceWorkingHours);
    router.get   ("/doctors/me/exceptions",              userGuard(), authorize(p.listExceptions),      readLimit(),  controller.listExceptions);
    router.post  ("/doctors/me/exceptions",              userGuard(), authorize(p.createException),     writeLimit(), idempotency({ required: false }), controller.createException);
    router.delete("/doctors/me/exceptions/:id",          userGuard(), authorize(p.deleteException),     writeLimit(), controller.deleteException);
    router.get   ("/doctors/me/consultation-types",      userGuard(), authorize(p.listTypes),           readLimit(),  controller.listTypes);
    router.post  ("/doctors/me/consultation-types",      userGuard(), authorize(p.createType),          writeLimit(), idempotency({ required: false }), controller.createType);
    router.patch ("/doctors/me/consultation-types/:id",  userGuard(), authorize(p.updateType),          writeLimit(), controller.updateType);
    return sealRouter(router);
}
```
Order: guard → `authorize` → user limiter → idempotency → handler. Mounted in `src/routes.ts` with `router.use(buildSchedulesRouter())` after
`buildDoctorsRouter()`; the discovery module's `GET /doctors/:doctorUserId` must be registered after every `/doctors/me*` router. Route labels are the
8 full paths with `:id`. No `router.param`.

### 3.3 File list
```
src/app/schedules/
  constants.ts                          SCHEDULES_WRITE_USER_LIMIT (30), SCHEDULES_READ_USER_LIMIT (120), SCHEDULES_RATE_WINDOW_MS (60_000),
                                        MAX_INTERVALS_PER_DAY (6), MAX_EXCEPTION_RANGE_DATES (60), MAX_CONSULTATION_TYPES_PER_DOCTOR (20),
                                        DURATION_MIN/MAX (5/240), PRICE_MAX (2_147_483_647), NAME_MIN/MAX_LENGTH (2/100), REASON_MAX_LENGTH (500),
                                        TIME_OF_DAY_PATTERN, AUDIT_CONFLICT_IDS_MAX (20),
                                        DOCTOR_PROFILE_ENTITY_TYPE ("doctor_profile"), SCHEDULE_EXCEPTION_ENTITY_TYPE ("schedule_exception"),
                                        CONSULTATION_TYPE_ENTITY_TYPE ("consultation_type"),
                                        UQ_SCHEDULE_EXCEPTION_DATE ("uq_schedule_exceptions_doctor_profile_id_date"),
                                        UQ_CONSULTATION_TYPE_NAME ("uq_consultation_types_doctor_profile_id_name")
  enums.ts                              ScheduleExceptionType { DayOff = "day_off", CustomHours = "custom_hours" } (= DB check),
                                        ScheduleAuditAction { HoursReplaced, ExceptionCreated, ExceptionDeleted, ConflictsConfirmed } (wire strings above),
                                        ConsultationTypeAuditAction { Created, Updated }, ScheduleChangeKind { WorkingHours, ScheduleException, ConsultationType },
                                        ConsultationTypeField { Name, DurationMinutes, Price, Currency, IsActive } (wire names)
  errors.ts                             InvalidWorkingHours-style ValidationFailed.withDetails constants, ExceptionDateTaken, ConsultationTypeNameTaken,
                                        ConsultationTypeLimitReached, EmptyConsultationTypeUpdate, scheduleConflictsUnconfirmed(ids) factory (§6)
  types.ts                              WorkingHoursRow, ScheduleExceptionRow, ConsultationTypeRow, ScheduleOwner, WorkingHoursInput, WorkingHoursView,
                                        ExceptionInput, ExceptionPageParams, ConsultationTypeInput, ConsultationTypeChanges, ConsultationTypeColumnChanges,
                                        TypePageParams, ScheduleChange, ScheduleImpactContext, ScheduleChangedEvent, ScheduleImpactProvider,
                                        ScheduleChangeListener, ScheduleOwnerResolver, SchedulesRoute, SchedulesPolicies
  rules.ts                              pure Care rules (no I/O): normalizeHours, assertValidHours, expandExceptionDates, assertExceptionShape,
                                        sameHours, diffConsultationType
  entity/working-hour.entity.ts, entity/schedule-exception.entity.ts, entity/consultation-type.entity.ts
  dto/schedules.request.dto.ts          TimeIntervalDto, WorkingHoursDayDto, WorkingHoursReplaceDto, ScheduleExceptionCreateDto, ListExceptionsQueryDto,
                                        DeleteExceptionQueryDto, ConsultationTypeCreateDto, ConsultationTypeUpdateDto, ListTypesQueryDto
  dto/schedules.response.dto.ts         WorkingHoursResponseDto, ScheduleExceptionResponseDto, ConsultationTypeResponseDto
  repository/working-hours.repo.ts      WORKING_HOURS_COLUMNS, listLiveHours, softDeleteLiveHours, insertHours
  repository/schedule-exceptions.repo.ts  SCHEDULE_EXCEPTION_COLUMNS, listExceptionsPage(Query), insertExceptions, findExceptionById, softDeleteException
  repository/consultation-types.repo.ts CONSULTATION_TYPE_COLUMNS, listTypesPage(Query), countLiveTypes, insertType, findTypeById, updateType, hasActiveType
  service/schedules.service.ts          SchedulesService (@injectable)
  service/noop-schedule-impact.provider.ts   NoopScheduleImpactProvider (default; returns [] / does nothing)
  service/noop-schedule-change-listener.ts   NoopScheduleChangeListener (default)
  policies.ts                           buildSchedulesPolicies(doctorsService)
  controller/schedules.controller.ts    SchedulesController (@injectable, arrow-function methods)
  routes.ts                             buildSchedulesRouter()
src/app/doctors/schedule-owner.resolver.ts   buildScheduleOwnerResolver(getDoctors: () => DoctorsService): ScheduleOwnerResolver (lazy; §3.9.4)
src/app/doctors/service/doctors.service.ts   + findProfileForSchedule(userId, conn), lockProfileForSchedule(userId, trx); loadView gains the active-type query (§4.2)
src/app/doctors/types.ts, dto/doctors.response.dto.ts   DoctorProfileView.hasActiveConsultationType; isBookable(p, view.hasActiveConsultationType)
src/lib/validation/date-decorator.ts         IsCalendarDate() (real YYYY-MM-DD date, luxon; domain-free → lib)
src/lib/di/tokens.ts, src/bootstrap.ts       SchedulesService, SchedulesController, ScheduleImpactProvider, ScheduleChangeListener, ScheduleOwnerResolver
src/routes.ts                                mounts buildSchedulesRouter()
src/pkg/slots/                               types.ts, local-time.ts, local-date.ts, instant.ts, intervals.ts, resolve-open-intervals.ts  (§3.10)
src/migrations/<ts>_create_working_hours.ts, <ts>_create_schedule_exceptions.ts, <ts>_create_consultation_types.ts
tests/…                                      §9
```
Every type alias and interface lives in `types.ts` (ESLint enforces it, `pkg/slots/types.ts` included). `.env.example` is unchanged.

### 3.4 Entities
Plain classes, `constructor(data: Partial<X>)`, camelCase mirrors of the selected columns (`WorkingHour { id, weekday, startTime, endTime }`,
`ScheduleException { id, date, type, startTime, endTime, reason, createdAt }`, `ConsultationType { id, name, durationMinutes, price, currency, isActive, createdAt, updatedAt }`).
`doctor_profile_id` and `deleted_at` are never on an entity (rows are always read scoped and live). `date` is a `YYYY-MM-DD` string (the pg `DATE` parser is
overridden per query with `date::text`/`to_char`, never a `Date`, so no timezone shift is possible); `startTime`/`endTime` are `HH:mm` strings (`to_char(start_time, 'HH24:MI')` is not used because
`24:00:00` does not format — `toEntity` slices the pg `TIME` text `HH:MM:SS` to `HH:MM`).

### 3.5 Request DTOs (`dto/schedules.request.dto.ts`)
Validated with `lib/validation` (`whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues`, no implicit conversion). Bodies are JSON (strings for numbers → 400);
query booleans/integers carry `ToBoolean()` / `ToInt()`. Rejected values are never echoed; nothing is trimmed or lower-cased.
```ts
export class TimeIntervalDto {
    @Matches(TIME_OF_DAY_PATTERN) startTime!: string;
    @Matches(TIME_OF_DAY_PATTERN) endTime!: string;
}
export class WorkingHoursDayDto {
    @IsInt() @Min(1) @Max(7) weekday!: number;
    @IsArray() @ArrayMinSize(1) @ArrayMaxSize(6) @ValidateNested({ each: true }) @Type(() => TimeIntervalDto) intervals!: TimeIntervalDto[];
}
export class WorkingHoursReplaceDto {
    @IsArray() @ArrayMaxSize(7) @ValidateNested({ each: true }) @Type(() => WorkingHoursDayDto) days!: WorkingHoursDayDto[];
    @ValidateIf((_o, v) => v !== undefined) @IsBoolean() confirmConflicts?: boolean;
    toInput(): WorkingHoursInput;                       // { days: [{weekday, intervals:[{startMinute,endMinute}]}], confirmConflicts: boolean }
}
export class ScheduleExceptionCreateDto {
    @IsIn(Object.values(ScheduleExceptionType)) type!: ScheduleExceptionType;
    @IsCalendarDate() date!: string;
    @ValidateIf((_o, v) => v !== undefined) @IsCalendarDate() endDate?: string;
    @ValidateIf((_o, v) => v !== undefined) @Matches(TIME_OF_DAY_PATTERN) startTime?: string;
    @ValidateIf((_o, v) => v !== undefined) @Matches(TIME_OF_DAY_PATTERN) endTime?: string;
    @ValidateIf((_o, v) => v !== undefined) @IsString() @CodePointLength(0, 500) @NoControlCharacters("nul") reason?: string;
    @ValidateIf((_o, v) => v !== undefined) @IsBoolean() confirmConflicts?: boolean;
    toInput(): ExceptionInput;
}
export class ListExceptionsQueryDto extends PaginationQueryDto {
    @IsOptional() @IsCalendarDate() fromDate?: string;
    @IsOptional() @IsCalendarDate() toDate?: string;
}
export class DeleteExceptionQueryDto { @IsOptional() @ToBoolean() @IsBoolean() confirmConflicts?: boolean; }
export class ConsultationTypeCreateDto {
    @IsString() @CodePointLength(2, 100) @NoControlCharacters("all") @Matches(/\S/) name!: string;
    @IsInt() @Min(5) @Max(240) durationMinutes!: number;
    @IsInt() @Min(0) @Max(2_147_483_647) price!: number;
    @IsString() @Matches(/^[A-Z]{3}$/) currency!: string;
}
export class ConsultationTypeUpdateDto {                  // every member optional; absent = unchanged; null → 400
    name?, durationMinutes?, price?, currency?, isActive? (IsBoolean — JSON boolean only)
    isEmpty(): boolean;                                   // every member undefined (never Object.keys) — minProperties: 1
    toChanges(): ConsultationTypeChanges;
}
export class ListTypesQueryDto extends PaginationQueryDto { @IsOptional() @ToBoolean() @IsBoolean() isActive?: boolean; }
```
- `TIME_OF_DAY_PATTERN = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$|^24:00$/` (the contract's pattern). `toInput()` converts `HH:mm` to minutes since midnight via `parseTimeOfDay` (`pkg/slots`).
- Cross-field rules are in `rules.ts` and raised as module `ValidationFailed` constants with `details[].field`: weekday uniqueness, `end > start`, same-weekday overlap, exception
  shape (`day_off` forbids times/needs none, `custom_hours` requires both and forbids `endDate`), `date ≤ endDate`, range ≤ 60 dates, `fromDate ≤ toDate`, `date ≥ today`.
- `IsCalendarDate()` (new, `lib/validation/date-decorator.ts`): `^\d{4}-\d{2}-\d{2}$` **and** a real calendar date (`2027-02-30` → invalid); message "must be a valid calendar date".
- `reason`, `name` are free text: never logged, never in audit metadata.

### 3.6 Response DTOs (`dto/schedules.response.dto.ts`)
Plain classes with `static from(...)`, explicit field-by-field copies, dates via `toISOString()` (`createdAt`/`updatedAt` millisecond `Z`); `date`/times are the entity strings.
No row, entity, `doctor_profile_id`, or `deleted_at` reaches the wire. No `viewer` parameter: only the owner reaches these routes, and no admin DTO exists (no admin route).
A unit test asserts the produced keys equal the contract's `required` lists: `WorkingHours` (`timezone`, `days`), `WorkingHoursDay`, `ScheduleException`, `ConsultationType`.

### 3.7 Repositories (functions, `conn: Knex = db`, explicit columns, `whereNull('deleted_at')` on every read, never `SELECT *`)
| Function | SQL |
|---|---|
| `listLiveHours(profileId, conn)` | `SELECT id, weekday, start_time, end_time FROM working_hours WHERE doctor_profile_id = ? AND deleted_at IS NULL ORDER BY weekday, start_time` (`idx_working_hours_doctor_profile_id`) |
| `softDeleteLiveHours(profileId, trx)` | `UPDATE working_hours SET deleted_at = NOW(), updated_at = NOW() WHERE doctor_profile_id = ? AND deleted_at IS NULL` |
| `insertHours(profileId, rows, trx)` | one multi-row `INSERT INTO working_hours (doctor_profile_id, weekday, start_time, end_time) VALUES … RETURNING id, weekday, start_time, end_time` (empty list → no statement) |
| `listExceptionsPage(profileId, params, conn)` | `SELECT id, date::text AS date, type, start_time, end_time, reason, created_at FROM schedule_exceptions WHERE doctor_profile_id = ? AND deleted_at IS NULL AND date >= ? [AND date <= ?] [AND (date, id) > (?, ?)] ORDER BY date, id LIMIT ?` (`uq_schedule_exceptions_…_date`) |
| `insertExceptions(profileId, rows, trx)` | one multi-row `INSERT … VALUES … RETURNING <cols>` (≤ 60 rows); `23505` on `uq_schedule_exceptions_doctor_profile_id_date` is mapped by the service |
| `findExceptionById(profileId, id, trx)` | `SELECT <cols> FROM schedule_exceptions WHERE id = ? AND doctor_profile_id = ? AND deleted_at IS NULL` (scoped: a foreign id is `undefined`) |
| `softDeleteException(id, trx)` | `UPDATE schedule_exceptions SET deleted_at = NOW(), updated_at = NOW() WHERE id = ? AND deleted_at IS NULL` |
| `listTypesPage(profileId, params, conn)` | `SELECT <cols> FROM consultation_types WHERE doctor_profile_id = ? AND deleted_at IS NULL [AND is_active = ?] [AND id > ?] ORDER BY id LIMIT ?` |
| `countLiveTypes(profileId, trx)` | `SELECT count(*)::int FROM consultation_types WHERE doctor_profile_id = ? AND deleted_at IS NULL` |
| `insertType(profileId, input, trx)` | `INSERT … (doctor_profile_id, name, duration_minutes, price, currency, is_active) VALUES (…, true) RETURNING <cols>` |
| `findTypeById(profileId, id, conn)` | `SELECT <cols> FROM consultation_types WHERE id = ? AND doctor_profile_id = ? AND deleted_at IS NULL` |
| `updateType(id, changes, trx)` | `UPDATE consultation_types SET <changed columns>, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL RETURNING <cols>` |
| `hasActiveType(profileId, conn)` | `SELECT 1 FROM consultation_types WHERE doctor_profile_id = ? AND is_active AND deleted_at IS NULL LIMIT 1` (`idx_consultation_types_doctor_profile_id_active`) |

The page queries are exported (`…Query`) so an EXPLAIN test inspects exactly what runs. Cursors: exceptions `(date, id)` through `decodeTextCursor(cursor, 10)` plus a
calendar-date check; types `(id, id)` through `decodeCursor`, requiring `sortValue === id`; a malformed cursor → `400 ValidationFailed` (`cursor`). A cursor is a position, never a
grant: every query keeps its profile filter.

### 3.8 Controller (`controller/schedules.controller.ts`)
`@injectable()`, arrow-function methods, validate → service → `sendSuccess` / `sendNoContent`; no business logic. `PUT`/`POST`/`PATCH`: `validateBody`; `{}` on `PATCH` → `EmptyConsultationTypeUpdate`;
lists: `validateQuery` → `buildPage` meta; `:id` via `parsePositiveId` (`undefined` → `NotFound`). Order of failure: guard 401 → `authorize` 403 (role, status, `doctor_not_suspended`) → limiter 429 → body/query 400 → service (404 → 409/400 rules).

### 3.9 Service (`service/schedules.service.ts`)
```ts
@injectable()
export class SchedulesService {
    constructor(
        @inject(TOKENS.Db) private readonly db: Knex,
        @inject(TOKENS.AuditRecorder) private readonly audit: AuditRecorder,
        @inject(TOKENS.Env) private readonly env: Env,
        @inject(TOKENS.Logger) private readonly logger: Logger,
        @inject(TOKENS.ScheduleOwnerResolver) private readonly owners: ScheduleOwnerResolver,
        @inject(TOKENS.ScheduleImpactProvider) private readonly impact: ScheduleImpactProvider,
        @inject(TOKENS.ScheduleChangeListener) private readonly listener: ScheduleChangeListener,
    ) {}
    getWorkingHours(actor): Promise<WorkingHoursView>;
    replaceWorkingHours(actor, input: WorkingHoursInput): Promise<WorkingHoursView>;
    listExceptions(actor, query): Promise<Page<ScheduleException>>;
    createExceptions(actor, input: ExceptionInput): Promise<ScheduleException[]>;
    deleteException(actor, id: number, confirmConflicts: boolean): Promise<void>;
    listConsultationTypes(actor, query): Promise<Page<ConsultationType>>;
    createConsultationType(actor, input: ConsultationTypeInput): Promise<ConsultationType>;
    updateConsultationType(actor, id: number, changes: ConsultationTypeChanges): Promise<ConsultationType>;
    hasActiveConsultationType(profileId: number, conn?: Knex): Promise<boolean>;     // for doctors' isBookable
}
```
`now` is read once per request (`new Date()`) and passed into every pure function and the provider context (tests use jest fake timers; `pkg/` never reads a clock).

#### 3.9.1 Shared write skeleton
Every write: `await this.db.transaction(async (trx) => { owner = await owners.lock(actor.userId, trx); … })` (Knex handler form, never nested, no Identity/storage call).
1. `lock` = `SELECT … FROM doctor_profiles WHERE user_id = ? AND deleted_at IS NULL FOR UPDATE`; absent → `NotFound`; `owner.isSuspended` → `Forbidden` (re-check under the lock; S-R17).
2. the rule checks and writes of the operation;
3. impact check (§3.9.2) where the operation has one;
4. `audit.record(trx, …)` (all rows of the operation, same transaction);
5. after the callback resolved: `await this.notifyChanged(event)` (§3.9.3).
Reads use `owners.find(userId, this.db)` (no lock) and map absent → `NotFound`.

#### 3.9.2 Impact check (`ScheduleImpactProvider`, inside the transaction, after the rows are written)
```ts
const ids = await this.impact.findAffected(ctx, trx);      // sorted ascending; default []
if (ids.length > 0 && !confirmConflicts) throw scheduleConflictsUnconfirmed(ids);   // throwing rolls the writes back
if (ids.length > 0) {
    await this.impact.flagAffected(ctx, ids, trx);            // consultations: needs_admin_followup + followup_reason='schedule_blocked' + notification_outbox rows
    await this.audit.record(trx, { action: ConflictsConfirmed, entityType: "doctor_profile", entityId: owner.profileId,
        metadata: { change, count: ids.length, consultationIds: firstIds, idsTruncated: ids.length > 20 } });
}
```
`ctx = { doctorProfileId, doctorUserId, timezone, now, change }` with `change` ∈ `{ kind: 'working_hours' } | { kind: 'schedule_exception_created', fromDate, toDate } | { kind: 'schedule_exception_deleted', date }`.
The provider reads the **new** state from the same `trx` (the rows are already written) and returns future (`starts_at > now`) non-terminal consultations whose interval is no longer
inside the doctor's open intervals (`pkg/slots`). It never moves or cancels a consultation. `consultationIds` in the audit metadata is the first 20 ids joined by `,` (≤ 500 chars by construction).
The 409 body carries **all** ids; if `consultations` needs a bound it adds one in its own spec (the contract has none). Default provider: `findAffected → []`, `flagAffected → no-op` — it can never block a write.

#### 3.9.3 Change listener (after commit)
`ScheduleChangedEvent = { doctorProfileId, doctorUserId, kind: ScheduleChangeKind }`. Invoked once after the commit of: `PUT` with a real change, `POST /exceptions`, `DELETE /exceptions/{id}`,
`POST /consultation-types`, `PATCH /consultation-types/{id}` with a real change. Never on a no-op, a validation failure, a 409, or a rollback. The call is wrapped in `try/catch`:
a rejection is logged (`schedule_change_listener_failed`, `requestId`, `doctorProfileId`, `kind`, no other data) and **never** fails the already-committed write (cache invalidation is derived data with a TTL).
Default listener: no-op. `availability` rebinds it to invalidate `slots:*` / `next-available:*` and enqueue the coalesced refresh (ADR 0010).

#### 3.9.4 The `doctors` ↔ `schedules` seam
`DoctorsService` injects `SchedulesService` (to compute `isBookable`'s last term). `SchedulesService` needs the profile (id, timezone, currency, suspension) from `doctors` without a constructor cycle:
`ScheduleOwnerResolver = { find(userId, conn): Promise<ScheduleOwner | undefined>; lock(userId, trx): Promise<ScheduleOwner | undefined> }`, `ScheduleOwner = { profileId, userId, timezone, currency, isSuspended }`.
`bootstrap.ts` registers it with `useFactory: (c) => buildScheduleOwnerResolver(() => c.resolve(TOKENS.DoctorsService))` — the lookup is lazy (at call time), so construction order is
`DoctorsService → SchedulesService → resolver (no DoctorsService yet)`. `buildScheduleOwnerResolver` (in `src/app/doctors/`) maps `DoctorsService.findProfileForSchedule` / `lockProfileForSchedule`
(thin wrappers of `findProfileByUserId` / `findProfileByUserIdForUpdate`) to `ScheduleOwner`. Policies build `doctorNotSuspendedCheck(doctorsService)` in `routes.ts`, as doctors does.

#### 3.9.5 Operations
**`getWorkingHours`** (no transaction): `owners.find` → `listLiveHours` → group by weekday → `{ timezone: owner.timezone, days }`. 2 queries.

**`replaceWorkingHours(actor, { days, confirmConflicts })`** — validate (`assertValidHours`: duplicate weekday, `end > start`, overlap, ≤ 6/day; before any I/O), then one transaction:
1. lock owner (§3.9.1). 2. `current = listLiveHours`; if `sameHours(current, normalizeHours(days))` → return the current view (S-R3: no write/audit/provider/listener).
3. `softDeleteLiveHours` → `insertHours(normalized rows)`. 4. impact check with `{ kind: 'working_hours' }`. 5. `audit` `schedule.hours_replaced`, entity `doctor_profile`/profile id,
metadata `{ dayCount, intervalCount, confirmed: ids.length > 0 }`. 6. view from the inserted rows. After commit: listener `WorkingHours`.
Concurrency: two simultaneous `PUT`s of one doctor serialize on the profile lock; the second reads the first's committed set; the final live set is exactly one request's set (S-R1).

**`listExceptions`** — `owners.find`; `fromDate ?? today(owner.timezone)`; `fromDate ≤ toDate`; `listExceptionsPage` (`limit + 1`) → `buildPage` with position `(date, id)`. 2 queries.

**`createExceptions(actor, input)`** — `assertExceptionShape` + `expandExceptionDates(date, endDate)` (pure; ≤ 60 dates), then one transaction:
1. lock owner. 2. `today = localDateOf(now, owner.timezone)`; any date `< today` → `400 date`. 3. `insertExceptions` (rows: type, times in minutes→`TIME`, `reason ?? null`); `23505` with constraint
`uq_schedule_exceptions_doctor_profile_id_date` → `Conflict` (`ExceptionDateTaken`), the transaction rolls back (no partial range). 4. impact check with `{ kind: 'schedule_exception_created', fromDate, toDate }`.
5. `audit` `schedule.exception_created`, entity `doctor_profile`/profile id, metadata `{ type, fromDate, toDate, count }`. 6. After commit: listener `ScheduleException`. Returns the inserted rows ascending by date.

**`deleteException(actor, id, confirmConflicts)`** — one transaction: lock owner → `findExceptionById(profileId, id)` → `NotFound` if undefined → `softDeleteException` → if `type = custom_hours` and
`date >= today(owner.timezone)`: impact check `{ kind: 'schedule_exception_deleted', date }` → `audit` `schedule.exception_deleted`, entity `schedule_exception`/exception id, metadata `{ type, date }`. After commit: listener `ScheduleException`.

**`listConsultationTypes`** — `owners.find` → `listTypesPage`. 2 queries.

**`createConsultationType(actor, input)`** — `assertCurrencyAllowed` (in `ALLOWED_CURRENCIES`) is a pure env check before the transaction; then: lock owner → `input.currency !== owner.currency` → `400 currency` →
`countLiveTypes >= 20` → `409 Conflict` (`ConsultationTypeLimitReached`) → `insertType` (`23505` on `uq_consultation_types_doctor_profile_id_name` → `Conflict` `ConsultationTypeNameTaken`) →
`audit` `consultation_type.created`, entity `consultation_type`/type id, metadata `{ durationMinutes, price, currency }` → after commit: listener `ConsultationType`.

**`updateConsultationType(actor, id, changes)`** — `currency` given: env allowlist check before the transaction; then lock owner → `findTypeById(profileId, id)` → `NotFound` → `currency` given and `!== owner.currency` → `400 currency` →
`diffConsultationType(current, changes)` (a field is changed only when provided and different); no change → return current (no write/audit/listener) → `updateType` (`23505` name → `Conflict`) →
`audit` `consultation_type.updated`, metadata `{ changedFields: "<sorted wire names joined by ','>" }` (names only) → after commit: listener `ConsultationType`.

**`hasActiveConsultationType(profileId, conn = this.db)`** — `hasActiveType` → boolean. One indexed query; the caller (doctors) passes its own `conn`/`trx`.

### 3.10 `src/pkg/slots` — open-interval resolution (pure)
Framework-free: imports only `luxon` and `pkg/utils`; no `lib/`, no `app/`, no env, no clock, no singletons. Instants are epoch milliseconds; local dates `YYYY-MM-DD` strings;
local times are **minutes since doctor-local midnight** (`0..1440`, `1440` = `24:00`). Intervals are half-open `[start, end)`.
```ts
// types.ts
export interface LocalInterval { startMinute: number; endMinute: number }                      // 0 ≤ start < end ≤ 1440
export interface WeeklyHoursRule { weekday: number; intervals: readonly LocalInterval[] }     // ISO weekday 1..7
export interface ExceptionRule { date: string; type: "day_off" | "custom_hours"; startMinute: number | null; endMinute: number | null }
export interface UtcInterval { startMs: number; endMs: number }
export interface ResolveOpenIntervalsInput { timezone: string; weekly: readonly WeeklyHoursRule[]; exceptions: readonly ExceptionRule[]; fromDate: string; toDate: string }
export interface OpenDay { date: string; intervals: UtcInterval[] }
```
| Function | Contract |
|---|---|
| `parseTimeOfDay(text)` / `formatTimeOfDay(minutes)` | `"HH:mm"` or `"24:00"` ↔ minutes `0..1440`; anything else throws `RangeError` |
| `addDays(date, n)` / `localDateOf(instantMs, timezone)` / `isoWeekday(date)` | calendar maths in luxon (UTC for pure date arithmetic, the zone for `localDateOf`); no `Date` arithmetic |
| `localInstant(date, minute, timezone, edge)` | the UTC instant of a doctor-local wall time, `edge ∈ "start" \| "end"`; DST rules below; `minute = 1440` ⇒ local midnight of `addDays(date, 1)` |
| `mergeLocalIntervals(intervals)` / `mergeUtcIntervals(intervals)` | sort, merge overlapping **and touching** intervals, drop empty ones; input not mutated |
| `resolveOpenIntervals(input)` | one `OpenDay` per date in `[fromDate, toDate]` inclusive (days with no hours get `intervals: []`) |

**Resolution per local date** (S-R7): a `day_off` exception → `[]`; a `custom_hours` exception → `[ [startMinute, endMinute] ]` (it **replaces** the weekday's hours, never merged with them);
otherwise the merged weekly intervals of `isoWeekday(date)`. Each local interval is converted with `localInstant(date, start, tz, "start")` and `localInstant(date, end, tz, "end")`, empty results
dropped, the day's UTC intervals merged. Cross-date merging is the caller's choice (`mergeUtcIntervals`); `22:00-24:00` Monday and `00:00-02:00` Tuesday stay on their own dates.
Errors (`RangeError`): invalid zone, `toDate < fromDate`, more than 400 dates, two exceptions for one date, an interval outside `0 ≤ start < end ≤ 1440`.

**`localInstant` (DST):** let `W` = the wall time read as UTC milliseconds, `a` = zone offset at `W − 24 h`, `b` = zone offset at `W + 24 h`. Candidate instants are `W − a` and `W − b`, each kept only
if the zone's offset **at that instant** equals the offset used. Then:
- **One valid candidate** — that instant (the normal case).
- **Two valid distinct candidates (fall-back overlap, ambiguous wall time)** — `start` edge → the **earlier** instant, `end` edge → the **later** instant, so an interval spans its full wall-clock extent.
- **No valid candidate (spring-forward gap, nonexistent wall time)** — the **transition instant** (first instant after the gap), found by bisection on the zone offset at one-minute resolution between `W − max(a,b)` and `W − min(a,b)`;
  both edges map to it, so a slot never starts inside the gap and an interval wholly inside the gap becomes empty and is dropped.
Durations are always real elapsed minutes.

Reference values (unit tests assert these as UTC literals, 2027):
| Zone / day | Local interval | UTC result |
|---|---|---|
| `Europe/Berlin`, Sun 03-28 (gap 02:00-03:00, transition 01:00Z) | 01:00-04:00 | 00:00Z-02:00Z (2 h real) |
| same | 02:30-03:30 | 01:00Z-01:30Z (start in gap → transition) |
| same | 02:15-02:45 | dropped (wholly in the gap) |
| same | 00:00-02:30 | 23:00Z (03-27)-01:00Z (end in gap → transition) |
| `Europe/Berlin`, Sun 10-31 (overlap 02:00-03:00, transition 01:00Z) | 01:00-04:00 | 23:00Z (10-30)-03:00Z (4 h real) |
| same | 02:30-03:30 | 00:30Z-02:30Z (start ambiguous → earlier) |
| same | 01:00-02:30 | 23:00Z (10-30)-01:30Z (end ambiguous → later) |
| `Africa/Cairo`, Thu 04-29 → midnight of Fri 04-30 does not exist (DST starts 00:00→01:00, transition 22:00Z) | 18:00-24:00 | 16:00Z-22:00Z (`24:00` = next local midnight → transition) |
| `Africa/Cairo`, Fri 04-30 | 00:00-02:00 | 22:00Z (04-29)-23:00Z (start at the gap → transition; 02:00 = 23:00Z) |
| `Africa/Cairo`, Thu 10-28 (DST ends at 24:00, transition 21:00Z; 23:00-24:00 ambiguous) | 22:00-24:00 | 19:00Z-22:00Z (3 h real; `24:00` = Fri 00:00 EET) |
| `America/New_York`, Sun 2027-03-14 / 11-07 | analogous cases | computed from the zone data in the test; assertions on real elapsed minutes |

### 3.11 Policies (`policies.ts`) and DI
```ts
export function buildSchedulesPolicies(doctors: Pick<DoctorsService, "isLocallySuspended">): SchedulesPolicies {
    const base = { kind: "user" as const, roles: ["doctor"] as const, owner: { kind: "self" as const },
                   accountState: { statuses: { doctor: ["active"] as const } }, checks: [doctorNotSuspendedCheck(doctors)] };
    return { getWorkingHours: base, replaceWorkingHours: { ...base, audit: "admin-action" }, listExceptions: base,
             createException: { ...base, audit: "admin-action" }, deleteException: { ...base, audit: "admin-action" },
             listTypes: base, createType: base, updateType: base };
}
```
- Matches `x-roles: [doctor]`, `x-ownership: self`, `x-account-state` of the eight operations (a unit test reads them from the contract). `audit: "admin-action"` mirrors `x-audit` on the operations that can affect bookings (C1 adds it to `deleteMyException`).
- Tokens (`Symbol.for`): `SchedulesService`, `SchedulesController`, `ScheduleImpactProvider`, `ScheduleChangeListener`, `ScheduleOwnerResolver`. `registerSingleton` for the service, controller and the two no-op defaults; the resolver by `useFactory` (§3.9.4).
  Every constructor parameter uses `@inject(TOKENS.X)` (ADR 0016).

---

## 4. Business rules

### 4.1 Rules (numbered, testable; "Enforced by" names the guarantee)
| # | Rule | Enforced by |
|---|---|---|
| S-R1 | `PUT working-hours` is atomic: after any outcome (success, validation failure, 409, concurrent replace) exactly one coherent live set exists; concurrent replaces leave exactly one request's set | one transaction + profile row lock + `softDelete`/`insert` |
| S-R2 | Per weekday: 1–6 intervals, `start < end ≤ 24:00`, no overlap (touching allowed), one entry per weekday; at most 7 days | DTO + `rules.ts` + `chk_working_hours_time_order` + `excl_working_hours_no_overlap` |
| S-R3 | A `PUT` equal to the current set (after sorting) is a no-op: 200, no write, no audit, no provider call, no listener. `days: []` clears all hours | service (`sameHours`) |
| S-R4 | Hours and exceptions are doctor-local wall clock, evaluated in `doctor_profiles.timezone`; `date` is a doctor-local date; times are `HH:mm` on the wire and `TIME` in the DB, `24:00` round-trips | schema + `pkg/slots` + DTO |
| S-R5 | Exception shape: `day_off` has no times (range `date..endDate` ≤ 60 dates → one row per date); `custom_hours` has both times, `end > start`, exactly one date and no `endDate` | DTO + `rules.ts` + `chk_schedule_exceptions_shape` |
| S-R6 | An exception dated before today in the doctor's timezone is `400`; a live exception on any date of the request → `409 Conflict` for the **whole** request (nothing created) | service + `uq_schedule_exceptions_doctor_profile_id_date` |
| S-R7 | `custom_hours` **replaces** that date's weekday hours (never merged); `day_off` removes the date; the resolver is pure and total over a date range | `pkg/slots` |
| S-R8 | `DELETE` is a soft delete; an absent, already-deleted, or foreign id → `404 NotFound` | scoped repository query |
| S-R9 | Deleting a `custom_hours` dated ≥ today (doctor tz) runs the impact check; deleting a `day_off` or a past exception never does | service |
| S-R10 | When the impact provider returns ids and `confirmConflicts` is not `true` → `409 ScheduleConflictsUnconfirmed` with all ids and `count`, and **no row changes**; with `true` → apply, `flagAffected`, one `schedule.conflicts_confirmed` audit row; consultations are never moved or cancelled; the default provider never blocks | service inside the transaction (+ stub in tests) |
| S-R11 | The change listener runs after commit only for real changes; its failure never fails the request | service (`try/catch` after `await transaction`) |
| S-R12 | A type has `durationMinutes` 5–240, `price` 0–2147483647, `name` 2–100 code points; the duration of a booking always comes from the type (Domain rule 4); live names are unique per doctor; at most 20 live types per doctor (active or inactive) | DTO + `chk_consultation_types_*` + `uq_consultation_types_…_name` + `countLiveTypes` under the lock |
| S-R13 | A type's `currency` is in `ALLOWED_CURRENCIES` **and** equals the doctor's profile currency, else `400 currency`. A later change of the profile currency does not rewrite existing types (a booking snapshots the type's own price and currency) | service |
| S-R14 | Types are never removed; `isActive=false` deactivates. `isBookable` is true only with ≥ 1 live **active** type, so deactivating the last active type makes the doctor not bookable on the next read | service + `idx_consultation_types_doctor_profile_id_active` |
| S-R15 | `PATCH` changes only provided members; `{}` → `400 body`; `null` → 400; a no-op → 200 with no write/audit/listener. Changes affect future bookings only | DTO + service (`diffConsultationType`) |
| S-R16 | Ownership `self`: every row is scoped by the profile resolved from `auth.userId`; a body cannot name a profile (unknown members → 400); a foreign id is `404` | token + scoped queries + `forbidNonWhitelisted` |
| S-R17 | Roles/state: only `doctor` with token `status=active`; patient/admin/`pending`/`rejected`/`suspended` token → `403`; a locally suspended doctor (`suspended_at IS NOT NULL`) → `403` on all eight routes immediately, and writes re-check it under the profile lock | `authorize` (`doctor_not_suspended`) + service |
| S-R18 | Every write has its audit row(s) in the same transaction (a failing audit insert rolls the write back); metadata never contains `reason`, `name` or any free text | `AuditRecorder` in the transaction |
| S-R19 | Writes of one doctor serialize on the profile row (`FOR UPDATE`); reads take no lock | service |
| S-R20 | Lists are keyset-paginated (`limit + 1`, `meta`), exceptions by `(date, id)`, types by `id`; live rows only | repository + `buildPage` |
| S-R21 | Limits: writes 30/min, reads 120/min per user → `429 RateLimited` | `rateLimit` |
| S-R22 | `Idempotency-Key` on `POST exceptions` / `POST consultation-types` (optional): same key + same body → original response replayed (one set of rows); different body → `422`; in flight → `409 Conflict` + `Retry-After: 1` | `idempotency({ required: false })` |
| S-R23 | No hard delete: `vcare_app` has no `DELETE` on the three tables (42501); soft-deleted rows are invisible to every read | grants + `deleted_at IS NULL` |
| S-R24 | `pkg/slots` is pure: no I/O, no clock, no env; DST gap start → transition instant, overlap start → earlier / end → later, `24:00` → next local midnight; durations are real elapsed minutes | `pkg/slots` |
| S-R25 | Domain rule 3 (past/horizon) and 2 (booking inside open intervals) are **not** checked here; this module supplies the inputs and the resolver only | scope |

### 4.2 `isBookable` wiring (Domain rule 6, decision 3) — change to `doctors`
- `DoctorProfileView` gains `hasActiveConsultationType: boolean`; `DoctorsService.loadView` fetches it with `SchedulesService.hasActiveConsultationType(profile.id, conn)` in the same
  `Promise.all` as the languages and specialty links, so `GET /doctors/me` is **5** queries (profile, languages ∥ links ∥ active-type, specialties `= ANY`, plus the policy check in `authorize` unchanged), no longer 4.
  `apply` and `PATCH` build their view the same way (one more indexed read). The query always runs, even for a profile that cannot be bookable, to keep the count fixed and the code branch-free.
- `DoctorProfileOwnResponseDto.from(view)` calls `isBookable(profile, view.hasActiveConsultationType)` (the function and its signature are unchanged).
- Doctors tests: the unit assertion "four queries" becomes five; the `isBookable` truth table keeps its cases; a new integration case proves `isBookable` flips `true` → `false` when the last active type is deactivated through `PATCH /consultation-types/{id}` (owner SQL sets `verification_status='approved'`, `identity_sync_status='synced'`).
- **doctors spec as-built delta (for `/update-docs`):** §3.9 `getOwn` "4 queries" → 5; D-R12 "always `false` in this slice" → "true when an active live consultation type exists"; §14 note; §10 "Working hours, exceptions, consultation types" → delivered by `schedules`; the new `DoctorsService` methods `findProfileForSchedule` / `lockProfileForSchedule`.
- **Deferred (recorded in the doctors deferred list):** a `PATCH /doctors/me` that changes `timezone` re-interprets every working hour and every future booking; the impact check for it is out of scope here and goes to `consultations` (or a follow-up on `doctors`) using the same `ScheduleImpactProvider` with `change.kind = 'working_hours'`.

---

## 5. Cross-service behavior

**None.** No call to Identity (Cases 1–4 do not apply), storage, video, email, or any worker. The only Identity-related step is `userGuard`'s local token verification. Internal seams only:
- `ScheduleImpactProvider` / `ScheduleChangeListener` are in-process ports (defaults no-op). `consultations` and `availability` rebind them; neither is a cross-service call.
- Search-time Case 2 hydration belongs to `availability`; notifications (`notification_outbox`) are written by the `consultations` provider implementation.

---

## 6. Error codes

No new code; all are in the contract `ErrorCode` enum.

| Code | HTTP | When (this module) | Emitted by |
|---|---|---|---|
| `ValidationFailed` | 400 | invalid body/query (unknown member, wrong type, `null` where not allowed, bad `TimeOfDay`/date, `weekday` out of range or repeated, interval `end ≤ start` or overlap or > 6 per day, exception shape/range/past date, `fromDate > toDate`, `currency` not allowed or ≠ profile currency, out-of-range duration/price/name, empty `PATCH`, malformed cursor, bad `confirmConflicts`/`isActive`/`Idempotency-Key`) | `lib/validation`, controller, `rules.ts`, service, `idempotency` |
| `Unauthorized` / `TokenExpired` | 401 | missing/invalid/expired bearer token | `userGuard` |
| `Forbidden` | 403 | role is not `doctor`; token status not `active`; local suspension (`check:doctor_not_suspended`, and the re-check under the lock) | `authorize`, service |
| `NotFound` | 404 | no live profile; absent/foreign/already-deleted exception or type id; non-numeric path id | service, controller |
| `ScheduleConflictsUnconfirmed` | 409 | the change strands future non-terminal consultations and `confirmConflicts` is not `true` (body adds `conflicts: { consultationIds, count }`) | service (`withExtra`) |
| `Conflict` | 409 | live exception already on a requested date · duplicate live type name · 20-type cap reached · `Idempotency-Key` whose first request is in flight (`Retry-After: 1`) | service, `idempotency` |
| `IdempotencyConflict` | 422 | same `Idempotency-Key`, different body (`POST` exceptions / types) | `idempotency` |
| `RateLimited` | 429 | a limiter tripped (`Retry-After` ≥ 1) | `rateLimit` |
| `InternalError` | 500 | unhandled, including a failed audit insert (the write rolls back) or an `excl_working_hours_no_overlap` violation | `errorHandler` |

Module constants (`errors.ts`; details never echo values):
```ts
export const ExceptionDateTaken = Conflict.withDetails([{ field: "date", issue: "already has a schedule exception" }]);
export const ConsultationTypeNameTaken = Conflict.withDetails([{ field: "name", issue: "is already used by another consultation type" }]);
export const ConsultationTypeLimitReached = Conflict.withDetails([{ field: "consultationTypes", issue: "limit of 20 consultation types reached" }]);
export const TypeCurrencyMismatch = ValidationFailed.withDetails([{ field: "currency", issue: "must equal the profile currency and be an allowed currency" }]);
export const ExceptionInPast = ValidationFailed.withDetails([{ field: "date", issue: "must not be before today in the doctor's timezone" }]);
export const EmptyConsultationTypeUpdate = ValidationFailed.withDetails([{ field: "body", issue: "must contain at least one property" }]);
export function scheduleConflictsUnconfirmed(ids: readonly number[]): AppError;   // code ScheduleConflictsUnconfirmed, 409, withExtra({ conflicts: { consultationIds: ids, count: ids.length } })
```

---

## 7. Security & privacy

- **RBAC summary:** `doctor` only, token `active`, ownership `self`, plus the live local-suspension check, on all eight routes; deny-by-default via `authorize`; the boot assertion proves every route is `guard → authorize`.
  Patient and admin are `403` everywhere (no admin schedule editing; doctors are independent, PRD §3). `X-User-Id`/`X-Role` are ignored; nothing in a body names a profile.
- **Audit events:** `schedule.hours_replaced` (`{ dayCount, intervalCount, confirmed }`), `schedule.exception_created` (`{ type, fromDate, toDate, count }`), `schedule.exception_deleted` (`{ type, date }`),
  `schedule.conflicts_confirmed` (`{ change, count, consultationIds (first 20, comma-joined), idsTruncated }`), `consultation_type.created` (`{ durationMinutes, price, currency }`),
  `consultation_type.updated` (`{ changedFields }`). Actor = the doctor (`actorFromAuth`), `request_id` = the request's id, entity types `doctor_profile` / `schedule_exception` / `consultation_type`.
  Metadata keys avoid every redacted key name (`AuditRecorder` rejects them). No-ops and reads write none.
- **Never logged or audited:** the exception `reason` (free text), type `name`, `Authorization`, tokens, request bodies (the request logger never logs bodies), rate-limit subjects, audit metadata values. `reason` is deliberately **not** added to
  `REDACTED_KEYS`: the key is a legitimate audit/log field elsewhere (suspension and sync reasons) and a global redaction would reject those audit rows; the guarantee is "never passed to the logger", proved by a log-hygiene test.
- **Not clinical:** hours, dates and prices are professional data. `no-store` is not required. All fixtures are synthetic (`SYNTHETIC-REASON-4417`, `Synthetic Visit 001`).
- **Database privileges:** `vcare_app` — `SELECT, INSERT, UPDATE` + sequence `USAGE` on the three tables; no `DELETE`, no `TRUNCATE`.
- **Rate limits:** S-R21 (Redis sliding window with the per-instance fallback). **Files:** none.

---

## 8. Performance

No budget exists in CLAUDE.md for these routes; the targets are review ceilings.

| Path | Round trips (excluding the limiter's one Redis `EVAL`) | Index | Target (p95, server) |
|---|---|---|---|
| `GET /working-hours` | 1 (`authorize` suspension check) + profile + hours = 3 | `uq_doctor_profiles_user_id`, `idx_working_hours_doctor_profile_id` | < 100 ms |
| `PUT /working-hours` | 1 check; `BEGIN`, profile `FOR UPDATE`, current hours, [no-op → `COMMIT`] soft-delete, insert (1 multi-row), audit (+1 if conflicts), `COMMIT` | same | < 200 ms |
| `GET /exceptions` | 1 check + profile + page = 3 | `uq_schedule_exceptions_…_date` | < 100 ms |
| `POST /exceptions` | 1 check; `BEGIN`, lock, insert (1 multi-row ≤ 60), audit (+1), `COMMIT` | same | < 200 ms |
| `DELETE /exceptions/{id}` | 1 check; `BEGIN`, lock, find, update, audit (+1), `COMMIT` | PK, scoped | < 200 ms |
| `GET /consultation-types` | 1 check + profile + page = 3 | `uq_consultation_types_…_name` | < 100 ms |
| `POST /consultation-types` | 1 check; `BEGIN`, lock, count, insert, audit, `COMMIT` | same | < 200 ms |
| `PATCH /consultation-types/{id}` | 1 check; `BEGIN`, lock, find, update, audit, `COMMIT` (no-op: no update/audit) | PK, scoped | < 200 ms |
| `GET /doctors/me` (doctors, changed) | profile, languages ∥ links ∥ active-type, specialties = 5 | `idx_consultation_types_doctor_profile_id_active` | < 100 ms |

- No N+1; every child statement is set-based (one multi-row insert/update per set). At most 42 hour rows, 60 exception rows per request, 20 types per doctor.
- `pkg/slots`: resolving a 14-day window with 3 shifts/day and exceptions runs in < 5 ms in memory (unit budget test); the future slot hot path (< 300 ms, 14 days) is the `availability` budget and uses 3 of its 5 fixed queries from these tables.
- `EXPLAIN` integration tests (with `enable_seqscan = off`): `listLiveHours` → `idx_working_hours_doctor_profile_id`; `listExceptionsPage` → `uq_schedule_exceptions_doctor_profile_id_date`; `listTypesPage` → `uq_consultation_types_doctor_profile_id_name`; `hasActiveType` → `idx_consultation_types_doctor_profile_id_active`.

---

## 9. Test plan outline

Names follow `should <do something> when <condition>`. Unit tests mock collaborators (repositories, audit, resolver, provider, listener, clock). Integration tests use the real `src/routes.ts` wiring, real Postgres as
`care_app` (owner `ownerDb` only for setup and assertions), real Redis, the fake JWKS helpers; each suite runs `truncateAll()` (add `consultation_types`, `schedule_exceptions`, `working_hours` **before** `doctor_profiles`)
and `flushByPrefix(["idem:", "rl:"])` in `beforeEach`. Tokens: doctor 202 (`active`; plus `pending`, `rejected`, `suspended` variants), second doctor 204, patient 101, admin 303.

### 9.1 Unit (`tests/unit/`)
- `pkg/slots/*.test.ts` (**exhaustive**, pure, no clock): `parseTimeOfDay`/`formatTimeOfDay` — should round-trip `00:00`, `09:30`, `23:59`, `24:00`; should reject `24:01`, `9:00`, `ab`, `25:00`.
  `mergeLocalIntervals`/`mergeUtcIntervals` — should merge overlapping and touching, keep gaps, sort, drop empty, and not mutate the input. `localInstant` — should return the offset instant for a normal time (UTC, `Africa/Cairo` winter and summer, `America/New_York`); should return the transition instant for a nonexistent time at both edges (Berlin 02:30, Cairo 00:30, New York 02:30); should return the earlier instant for an ambiguous start and the later for an ambiguous end (Berlin 02:30, New York 01:30, Cairo 23:30); should map `1440` to the next local midnight, including a nonexistent midnight (Cairo 04-30) and across a month/year end. `resolveOpenIntervals` — should: return weekly hours per weekday; keep a split shift as two intervals with a gap (09-12, 14-18); merge overlapping weekly rows; apply `day_off` (empty day); apply `custom_hours` as a **replacement** (not a union) and ignore the weekday's rows; ignore exceptions outside the range; return empty days for a weekday without rows; keep `22:00-24:00` Monday and `00:00-02:00` Tuesday on separate dates with adjacent UTC edges (and merge them only through `mergeUtcIntervals`); render the same local hours as different UTC instants for UTC+3 and UTC−5 zones; produce every row of the §3.10 reference table (Berlin spring/fall, Cairo `24:00` on both DST days, New York both days); drop an interval wholly inside a gap; yield real elapsed minutes across DST; handle a range spanning the DST change; throw `RangeError` for an invalid zone, reversed range, > 400 dates, duplicate exception dates, bad intervals; stay under 5 ms for 14 days × 3 shifts; never read the clock (frozen-time test and an import-surface lint check: no `lib/`, `app/`, env).
- `lib/validation/date-decorator.test.ts`: should accept `2027-02-28`, `2028-02-29`; should reject `2027-02-30`, `2027-13-01`, `27-01-01`, `2027-1-1`, non-strings.
- `app/schedules/schedules.request.dto.test.ts`: working hours — should accept a valid body and `days: []`; should reject weekday 0/8/1.5/"1", 0 or 7 intervals on a day, `25:00`, `9:00`, unknown members (`doctorProfileId`, `userId`), non-boolean `confirmConflicts`, > 7 days. exceptions — should accept `day_off` with `endDate`, `custom_hours` with times; should reject `2027-02-30`, `reason` of 501 code points or `null` or NUL, unknown `type`. types — should reject name of 1 / 101 code points / whitespace-only / control characters, duration 4/241/1.5, price −1 / 2147483648 / 1.5, currency `egp`; update — should report `isEmpty` for `{}`, reject `null` members, omit absent members in `toChanges`. queries — should reject `isActive=yes`, `limit=0`, `limit=101`, `confirmConflicts=1`.
- `app/schedules/schedules.rules.test.ts`: `assertValidHours` — should reject a duplicate weekday, `end ≤ start`, overlap (09-12 vs 11-14), `start = 24:00`; should accept touching (09-12, 12-14); `sameHours` ignores order; `expandExceptionDates` — 1 date, a 60-date range, rejects 61 and `endDate < date` and a month-boundary/leap-day range correctly; `assertExceptionShape` — `day_off` with times, `custom_hours` without times or with `endDate`, `end ≤ start`; `diffConsultationType` — changed names sorted, equal values unchanged.
- `app/schedules/schedules.response.dto.test.ts`: should produce exactly the contract `required` keys of `WorkingHours`, `WorkingHoursDay`, `ScheduleException`, `ConsultationType`; should render `createdAt` with `toISOString`; should never expose `doctor_profile_id` or `deleted_at`.
- `app/schedules/schedules.service.test.ts` (mocked repos/ports, `jest` fake timers):
  hours — should lock the owner, soft-delete, insert, audit `schedule.hours_replaced` in one transaction (S-R1) · should return the current set with no write, audit, provider or listener call when equal (S-R3) · should clear all hours for `days: []` · should throw `NotFound` without a profile and `Forbidden` when the locked owner is suspended (S-R17) · should reject (so Knex rolls back) when the audit throws (S-R18).
  **conflicts (stub provider — the only coverage of this path until `consultations`):** should throw `ScheduleConflictsUnconfirmed` with all ids, ascending, `count`, and write no audit when the stub returns ids and `confirmConflicts` is false, for `replaceWorkingHours`, `createExceptions`, and `deleteException` of a `custom_hours` (S-R10, S-R9) · should call `flagAffected` and write `schedule.conflicts_confirmed` (count, first 20 ids joined, `idsTruncated` for 25 ids) plus the operation's own audit when `confirmConflicts` is true · should never call the provider for a `day_off` delete or a past exception delete · should pass `{ kind, fromDate, toDate, now, timezone }` in the context · the default provider returning `[]` never blocks · the 409 rolls back the callback (the transaction handler rejects).
  exceptions — should reject a date before today in the doctor's timezone (a UTC instant that is already tomorrow in `Pacific/Kiritimati` and still yesterday in `Pacific/Pago_Pago`) · should map `23505` on `uq_schedule_exceptions_doctor_profile_id_date` to `Conflict` and not on another constraint · should insert one row per date of a range in one statement · should return `NotFound` for a foreign id.
  listener — should call the listener once after commit for each real change with the right `kind` · should not call it for a no-op, a 409, a validation failure, or a rolled-back write · should log `schedule_change_listener_failed` without data and still return success when it rejects (S-R11).
  types — should enforce the currency rule on create and update (S-R13) · should map `23505` on `uq_consultation_types_doctor_profile_id_name` to `Conflict` · should throw `ConsultationTypeLimitReached` at 20 live types and accept the 20th · should treat a no-op `PATCH` as 200 without write/audit/listener · should audit only the changed wire names sorted · `hasActiveConsultationType` delegates.
- `app/schedules/schedules.policies.test.ts`: should declare roles `[doctor]`, owner `self`, status `active` and the suspension check for every route per `x-roles`/`x-ownership`/`x-account-state` read from the contract; `admin-action` audit class where `x-audit` is declared.
- `app/schedules/schedules.routes.test.ts`: should compose POST exceptions/types as [guard, authorize, rateLimit, idempotency, handler], the other writes as [guard, authorize, rateLimit, handler], reads as [guard, authorize, rateLimit, handler] · should pass `assertRoutesAuthorized` · should register no `router.param`.
- `app/schedules/schedule-owner.resolver.test.ts`: should resolve `DoctorsService` lazily (not at construction) and map a profile to `ScheduleOwner` with `isSuspended` from `suspendedAt`.
- `app/schedules/noop-defaults.test.ts`: the default provider returns `[]` and the default listener resolves.
- `app/doctors/*` (**changed**): `doctors.service.test.ts` — "four queries" becomes **five** on `getOwn`; `loadView` passes the active-type result into the view · `doctors.response.dto.test.ts` — `isBookable` uses `view.hasActiveConsultationType` · the `isBookable` truth table is unchanged.
- `tests/unit/contract/schedules-contract.test.ts`: the eight operations' `x-roles`, `x-ownership`, `x-account-state`, declared status sets (incl. C1/C2 additions), `Idempotency-Key` presence only on the two POSTs, `confirmConflicts` query on `deleteMyException`, `ConsultationType`/`WorkingHours`/`ScheduleException` `required` lists.

### 9.2 Integration — `tests/integration/schedules.test.ts` (real `src/routes.ts`, default ports)
**RBAC per route** (all eight; CLAUDE.md → Testing policy):

| Route | none | patient | admin | doctor `active` | doctor `pending` / `rejected` token | doctor locally suspended (token still `active`, owner sets `suspended_at`) | doctor token `suspended` |
|---|---|---|---|---|---|---|---|
| each of the 8 routes | 401 | 403 | 403 | allowed (200/201/204; 404 without a profile) | 403 | **403** (`check:doctor_not_suspended`) | 403 |

Plus: expired token → `401 TokenExpired` · patient token with `X-Role: doctor` / `X-User-Id: 202` → still 403 · **non-owner:** doctor 204 sending doctor 202's exception id or type id → `404` on `DELETE`/`PATCH`, never sees 202's rows in any list,
and a body `doctorProfileId`/`userId` → 400 · wrong-role denial precedes body validation.
**Working hours:** should return `days: []` before any PUT · should store a split shift and `24:00` and return them sorted · should replace the whole set and soft-delete the old rows (owner SQL shows `deleted_at` set, one live set) ·
should return 400 for duplicate weekday, overlap, `end ≤ start`, `start 24:00`, 7 intervals, unknown members, with no change to the stored set · identical PUT → 200, `updated_at` of the live rows unchanged, no audit row ·
`days: []` clears · audit row `schedule.hours_replaced` (actor 202, role doctor, request id echoed, entity `doctor_profile`) in the same transaction (**audit failure rolls back:** the owner adds `CHECK (action <> 'schedule.hours_replaced')` on `audit_logs`, PUT → 500, previous set intact; dropped in `finally`) ·
**PUT concurrency race:** N (≥ 8) simultaneous `PUT`s with different sets by one doctor → every response 200, final live rows equal exactly one request's set, no mixed rows, `excl_working_hours_no_overlap` never fired · the owner's direct overlapping `INSERT` → `23P01` on the named constraint.
**Exceptions:** `day_off` single date and a 60-date range (60 rows, one audit row with `count=60`) · 61 dates → 400 · `custom_hours` with times · `custom_hours` with `endDate` → 400 · `day_off` with times → 400 · date before today in the doctor's timezone → 400 · today → 201 ·
live exception on one date of a range → `409 Conflict`, **no** partial rows · list: default `fromDate` = today, `toDate`, page 2 on the default `(date, id)` sort, deleted rows hidden, malformed cursor → 400, `fromDate > toDate` → 400 ·
`DELETE` → 204, soft delete, second `DELETE` → 404, `confirmConflicts=maybe` → 400, audit `schedule.exception_deleted`; deleting an exception frees its date for a new `POST` (partial unique index) ·
idempotency: same key + same body → same response and one set of rows; different body → 422; same key in flight → 409 + `Retry-After: 1`; non-UUID key → 400.
**Conflict flow (default provider):** `confirmConflicts` absent and true both succeed and write **no** `schedule.conflicts_confirmed` row (the default provider returns `[]`). *The real end-to-end 409/flagging test needs `consultations` and is a task of that spec (§10).* A **stub-provider integration test** rebinds `ScheduleImpactProvider` in the container to return ids to prove the full HTTP shape: `409`, body `{ error.code: "ScheduleConflictsUnconfirmed", conflicts: { consultationIds, count } }` passes the contract's `ScheduleConflicts` check, rows unchanged; then `confirmConflicts=true` → success + `schedule.conflicts_confirmed` audit (for PUT, POST exceptions, DELETE of a `custom_hours`).
**Listener:** a stub `ScheduleChangeListener` records one call per real change, none for no-ops/409/rollback, and a throwing listener does not change the 2xx response.
**Consultation types:** create → 201 with `isActive:true` · duplicate live name → 409 (`details[].field="name"`) · same name for another doctor → 201 · 21st type → 409 `consultationTypes`, the 20th → 201 · currency ≠ profile currency or outside `ALLOWED_CURRENCIES` → 400 `currency` (create and PATCH) ·
price 2147483648 → 400, never 500 · duration 4/241 → 400 · PATCH renames, reprices, deactivates and reactivates; `{}` → 400 `body`; `{ "name": null }` → 400; no-op → 200, `updated_at` unchanged, no audit row; rename to an existing name → 409 ·
`isActive` filter and page 2 on the default `id` sort · foreign/absent/non-numeric id → 404 · audit `consultation_type.created` / `.updated` with `changedFields` names only · `Idempotency-Key` replay on create.
**`isBookable` (doctors):** `GET /doctors/me` is `false` with no type; owner SQL approves + syncs the profile; creating a type flips it to `true`; `PATCH isActive:false` on the only active type flips it back immediately; a second active type keeps it `true` · the doctors RBAC/idempotency suites stay green with the 5-query view.
**Rate limit:** the 31st write in a minute → `429 RateLimited` with `Retry-After`, keys `rl:schedules-write-user:202` / `rl:schedules-read-user:202`; the 121st read likewise.
**Grants and schema (as `care_app`):** `DELETE` and `TRUNCATE` on each of the three tables → 42501 · owner `INSERT`s violating each `chk_*` (weekday 0/8, `end ≤ start`, fractional minutes, exception shape, type duration/price/currency/name length), the live-date unique index and the live-name unique index → the named constraint (23514/23505) · soft-deleted exception/type rows no longer collide with new ones.
**EXPLAIN:** the four plans of §8. **Migrations:** `migrations.test.ts` round-trips the three migrations (`latest`/`rollback`/`latest`), including the exclusion constraint.
**Logs:** captured logs contain no token, no `Authorization`, and neither `SYNTHETIC-REASON-4417` nor `Synthetic Visit 001`; the persisted `audit_logs.metadata` of every schedule action contains neither string; every `request_completed.route` is one of the eight labels.
**Contract conformance:** each returned status ∈ `contractResponseCodes(path, method)` (after C1/C2); error bodies pass `expectErrorEnvelope`; success bodies pass the `required`-key checks of §3.6; `idempotentOperations()` lists exactly the two POSTs.

### 9.3 Other suites touched
`boot.test.ts`: the real `buildPublicRoutes()` answers `GET /api/doctors/me/working-hours` without a token with 401 · `db-roles.test.ts`: the grants of §2 · `tests/helpers/db.ts`: `truncateAll` order.

### 9.4 Mandatory scenarios that apply
Each rule S-R1–S-R25 (one test line each above) · RBAC per route (wrong role, owner allowed, non-owner → 404, suspended doctor → 403; admin denied on every route) · idempotent replay and conflicting body (the two POSTs) ·
pagination page 2 on the default sort (exceptions, types) · slot/hours computation (`pkg/slots` exhaustive, DST, `24:00`, cross-midnight) · every audited write writes its row in its transaction · logs free of fixtures.
Not applicable: concurrent booking (no consultations yet — the PUT race is this module's concurrency test), Cases 1–4, record lock, uploads/download URLs, admin-on-clinical (no clinical data), the 300 ms slot budget (`availability`).

### 9.5 Manual QA (`/manual-qa schedules`)
Against a local Identity with real doctor (`active`, `pending`), patient and admin tokens: the RBAC table, split-shift PUT and read-back, overlap/duplicate 400s, day-off range and `custom_hours`, past-date 400, duplicate-date 409,
delete + 404 on repeat, type create/rename/deactivate, duplicate-name 409, the 21st-type 409, currency 400, idempotent replay, 429 on the 31st write, local suspension (owner SQL) → 403, and `isBookable` on `GET /doctors/me`. Record no tokens;
script `scripts/curl-test-schedules.sh`.

---

## 10. Out of scope
- Slot, calendar and search endpoints; busy-interval subtraction; slicing and grid alignment; the `slots:*` and `next-available:*` caches and their invalidation (the listener is the hook) → `availability`.
- The `consultations` table, booking validation (rules 2, 3, 5), `needs_admin_followup` flagging, patient notifications and the real `ScheduleImpactProvider` → `consultations`.
  **Task for the `consultations` spec:** implement and bind `ScheduleImpactProvider` (future non-terminal consultations outside the new open intervals via `pkg/slots`, `flagAffected` with `followup_reason='schedule_blocked'` + outbox rows) and add the **end-to-end test** of `409 ScheduleConflictsUnconfirmed` → `confirmConflicts=true` → flagged consultations, for `PUT working-hours`, `POST exceptions`, and `DELETE` of a `custom_hours` exception.
- Reacting to a doctor **timezone change** (`PATCH /doctors/me` already accepts it): not handled here; recorded in the doctors deferred list (§4.2).
- Admin editing of a doctor's schedule; consultation-type deletion; a lead-time, buffer or break rule; per-type working hours; holidays calendars; recurring exceptions.
- Syncing the profile fee with type prices (independent by design: the profile fee is the search "from" price, the type price is what a booking snapshots).
- Any Identity call and `lib/identity-client`.

---

## 11. Open questions

**None.** All questions of the brainstorm were decided by the user on 2026-10-08 (conflict ports, `pkg/slots` scope, `isBookable` wiring, type currency, delete-with-`confirmConflicts`, 20-type cap, 30/min write limiter, past-exception rejection, `24:00` handling, timezone change out of scope). The decisions below were made while writing this spec and follow existing precedents; each is reversible before `/develop`:
- Read limiter 120/min per user (doctors precedent); `excl_working_hours_no_overlap` and the whole-minute checks as DB safety nets (data-model delta); exception range = **60 dates inclusive**; a path id that is not a positive integer → 404 (specialties precedent); a caller without a profile → 404 on every route; the cap counts active and inactive live types; type names are case-sensitive.

### Contract changes required (decided; applied in `/develop` step 0, then the hub sync `../vcare-hub/scripts/sync-from-spoke.sh`)
No operation, route or schema member is added or removed.
- **C1 — `deleteMyException`:** add query parameter `confirmConflicts` (boolean, default `false`); add responses `400` (`ValidationFailed`, malformed `confirmConflicts`) and `409` (`$ref: '#/components/responses/ScheduleConflictsUnconfirmed'`);
  `x-audit: admin-action`; `x-audit-actions: [schedule.exception_deleted, schedule.conflicts_confirmed]`; description: deleting a `custom_hours` exception reverts its date to the weekly hours and, if that leaves future non-terminal consultations outside working hours, returns `409 ScheduleConflictsUnconfirmed` unless `confirmConflicts=true`; deleting a `day_off` or a past exception never conflicts.
- **C2 — missing `404`:** add `'404': $ref NotFound` to `listMyExceptions`, `createMyException`, `listMyConsultationTypes`, `createMyConsultationType` (a caller without a live doctor profile).
- **C3 — `ScheduleExceptionCreate` / `createMyException` clarifications:** `endDate` description → "`day_off` only; inclusive; at most 60 dates in total (`endDate` ≤ `date` + 59 days)"; operation description adds: dates before today in the doctor's timezone are `400 ValidationFailed`; `startTime`/`endTime` are forbidden for `day_off` and required for `custom_hours`; `endDate` is forbidden for `custom_hours`.
- **C4 — price bound:** `ConsultationType.price`, `ConsultationTypeCreate.price`, `ConsultationTypeUpdate.price` add `maximum: 2147483647` (the `INT` column; otherwise a database `22003` → `500`).
- **C5 — type rules in descriptions:** `createMyConsultationType`: a doctor has at most 20 consultation types (active or inactive), beyond that `409 Conflict`; `currency` must equal the doctor's profile currency and be in the service's allowlist (`ALLOWED_CURRENCIES`), else `400 ValidationFailed` with `details[].field = "currency"`; a duplicate live `name` is `409 Conflict`. `updateMyConsultationType` and `ConsultationTypeUpdate.currency`: same currency rule.
- **C6 — `replaceMyWorkingHours` description:** one entry per weekday (a repeated `weekday` is `400`), touching intervals are allowed, an interval needs `endTime > startTime` (`24:00` only as an end); `ScheduleConflictsUnconfirmed` response text: also returned by `deleteMyException`.

### Platform changes required (/system-design)
None.

---

## 12. Task ordering (CLAUDE.md → Build order for a new module)

`[code]` = implementation (src, migrations, tests); `[docs]` = docs and contract.

| Step | Work | Who |
|---|---|---|
| 0 | Contract C1–C6 + hub sync | [docs] |
| 0a (lib/pkg) | `pkg/slots` (§3.10) and its exhaustive unit tests; `lib/validation/date-decorator.ts` (`IsCalendarDate`) and its test | [code] |
| 1 | Migrations 1–3 (§2), `truncateAll` order, migrations round-trip test | [code] |
| 2 | `constants.ts`, `enums.ts`, `errors.ts`, `types.ts`, `rules.ts` | [code] |
| 3 | Entities | [code] |
| 4 | Request DTOs | [code] |
| 5 | Response DTOs | [code] |
| 6 | Repositories | [code] |
| 7 | `SchedulesService`, no-op provider/listener, `buildScheduleOwnerResolver`, `DoctorsService` additions (`findProfileForSchedule`, `lockProfileForSchedule`, active-type in `loadView`), tokens + `bootstrap.ts` registration | [code] |
| 8 | `policies.ts` | [code] |
| 9 | Controller + DI registration | [code] |
| 10 | `routes.ts` | [code] |
| 11 | Mount in `src/routes.ts` | [code] |
| 12 | Tests of §9 (incl. the changed doctors tests) | [code] |
| 13 | Manual QA (§9.5) | [docs] |
| 14 | Docs of §13, `docs/INDEX.md`, service card | [docs] |

## 13. Required follow-ups (docs; not open)
- `/update-docs schedules`: `architecture/data-model.md` (built-so-far line; `excl_working_hours_no_overlap`, whole-minute checks, `chk_consultation_types_name_length`, grants) · `architecture/api.md` and `architecture/rbac.md` (rows, rate limits, audit actions) ·
  `architecture/scheduling-slots.md` (`pkg/slots` open-interval API, the two ports) · this spec's as-built notes.
- `/update-docs doctors`: the as-built delta of §4.2 (5-query `getOwn`, D-R12, §10, new service methods) and the deferred timezone-change item.
- **`docs/service-card.md`** is affected: owned data gains working hours, exceptions and consultation types; the endpoint family `/api/doctors/me/{working-hours,exceptions,consultation-types}` is live; no new dependency, env variable or cross-service call. Then the hub sync (never hand-copy).
- ADRs: none needed (`luxon` is covered by ADR 0019; the ports are module-internal and recorded here).

---

## 14. As-built notes (2026-10-09, v1.1.0)

The module is implemented as specified: eight routes, three migrations (`20261008120000`, `20261008120100`, `20261008120200`; DDL identical to section 2), `pkg/slots`, the three ports with no-op defaults, and the `isBookable` wiring. Contract edits C1-C6 are applied; the code and `contracts/openapi.yaml` agree on routes, status sets, `x-roles`, `x-ownership`, `x-account-state`, `x-audit-actions` and the `Idempotency-Key` presence (two POSTs only). No intentional divergence from sections 2-4, 6 and 7 was found.

**Tests (2026-10-09).** Unit: 1541 tests in total across the repository (all green); the schedules share is `tests/unit/pkg/slots/*` (five files: `instant`, `intervals`, `local-date`, `local-time`, `resolve-open-intervals`, with the DST reference table), `tests/unit/app/schedules/*` (DTO, rules, response DTO, service, policies, routes, resolver, no-op defaults), `tests/unit/contract/schedules-contract.test.ts`, `tests/unit/lib/validation/date-decorator.test.ts`, and the doctors unit changes (five queries, `isBookable` from the view flag). Integration: `tests/integration/schedules.test.ts` has **116** tests (RBAC for all eight routes including the locally-suspended doctor, ownership, working-hours PUT race, exceptions, types, stub-provider and stub-listener flows, rate limits, grants and schema checks, EXPLAIN, log and audit hygiene, contract conformance); additions to `boot.test.ts`, `db-roles.test.ts` and `doctors.test.ts` (the `isBookable` flip). Targeted integration run (schedules, doctors, boot, db-roles): 226 green. The full integration run fails only on the MinIO storage-adapter suite (no MinIO locally) and the known `migrations` flake under load (passes alone).

**Manual QA (2026-10-09).** [manual-qa.md](./manual-qa.md): **220 pass / 0 fail** against a real Care listener (`care_app`, real Postgres and Redis, fake JWKS Identity). Not verified end to end, by design or environment:
- `409 ScheduleConflictsUnconfirmed` and the `schedule.conflicts_confirmed` audit row: the default `ScheduleImpactProvider` is a no-op until `consultations` exists, so these are covered only through the stub provider (unit and integration). The end-to-end test remains a task of the `consultations` spec (section 10).
- The in-flight duplicate `Idempotency-Key` path (`409 Conflict` + `Retry-After: 1`): needs a deterministic race over HTTP.
- The Redis-down fallback limiter.
- Behaviour on a real Identity (fake JWKS only) and the production build (`dist/`).

**Resolved - `resolveOpenIntervals` budget (review 20261009-1500, C3).** The cost was the uncached `IANAZone.isValidZone` in `assertValidZone` (it builds an `Intl.DateTimeFormat` per call), plus per-edge luxon ISO parsing and a redundant offset re-check. Fixed in `src/pkg/slots`: validated zone names are memoized in a module-level `Set` (only successes are added; invalid zones are still rejected), `localInstant` returns directly when the offsets at wall -/+ 1 day are equal (no transition in the window), and the local midnight comes from plain integer calendar arithmetic (`utcMidnightMs`, which also throws `RangeError` on a non-calendar date, so the earlier `NaN` minor finding is gone). Measured in jest on the dev machine (14 days x 3 shifts x 7 weekdays, best of 10 to 100 after warm-up): about 11 to 13 ms before, **3.4 to 4.3 ms** after (isolated run); under the full parallel unit suite it can read 6 to 8 ms (CPU contention; 1 failure in 9 full runs, 0 in 9 isolated runs). The 5 ms budget is unchanged and is verified by the opt-in benchmark `npm run test:bench` (`tests/bench/resolve-open-intervals.bench.test.ts`, best of 100, run alone: 3.07 to 3.30 ms in 4 runs; 3.4 to 4.3 ms in earlier isolated runs). A wall-clock assert flaked under the parallel suite, so `npm test` carries only deterministic guards: zone validation runs a constant number of times (not per `localInstant` call) and a < 50 ms regression guard. Also fixed (C1): year 0000 is rejected by `isCalendarDate`/`IsCalendarDate`/`parseDate` (Postgres `DATE` rejects it), so `fromDate`, `toDate` and a forged cursor now yield `400 ValidationFailed`.

**Minor findings (no action taken, not blocking).**
- `localInstant` now throws `RangeError` for a non-calendar date (resolved in the fix-review: the local midnight comes from `utcMidnightMs`, which validates).
- Section 8 says the `listTypesPage` EXPLAIN uses `uq_consultation_types_doctor_profile_id_name`. As built, the planner may use that index or the primary key (a <= 20-row set filtered by profile), never a sequential scan; the integration test asserts "an index scan, not a seq scan" and does not pin the index name.

**Doctors consequence.** `GET /api/doctors/me` and the `apply`/`PATCH` views now issue five queries and `isBookable` needs a live active consultation type (doctors spec v1.3.0, section 14). The doctors timezone-change impact on schedules is recorded as deferred there.
