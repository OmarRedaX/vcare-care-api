---
title: patients — Spec
owner: care-team
service: care-service
module: patients
status: implemented
version: 1.2.0
diataxis: reference
last_verified: 2026-10-12
tags: [spec, patients, patient-profile, clinical-privacy, audit, migration, upsert]
related: [patients-brainstorm, doctors-spec, schedules-spec, access-spec, audit-spec, data-model, api, rbac, clinical-records, adr-0017-generic-helpers-and-transaction-scoping, adr-0018-db-role-split-explicit-grants-partition-function, adr-0019-luxon-for-doctor-timezone-validation]
contracts: [contracts/openapi.yaml]
---

# patients — Spec

The patient's own **profile**: demographics, allergies, chronic conditions and IANA timezone. Two self-owned routes
(`GET` and `PATCH /api/patients/me`), one table (`patient_profiles`), no cross-service call. It sits on the `access`
base (`userGuard` → `authorize(policy)` → `AuditRecorder.record(trx, …)`) and follows the `doctors` onboarding slice
for upsert, race handling, DTO and test style.

Scope follows [brainstorm.md](./brainstorm.md) (decided 2026-10-11). The doctor-facing `GET /api/patients/{patientUserId}`
and `GET /api/patients/{patientUserId}/records` are **not** built here: both need the doctor-to-patient `EXISTS` on
`consultations` (the timeline also needs `medical_records`) and ship with `consultations` / `records`. The contract
operations stay as written; this module does not mount them. *(As built: `GET /api/patients/{patientUserId}` shipped with `consultations` on 2026-10-12, see section 14; the `/records` timeline is still planned.)*

Binding rules: CLAUDE.md → "Database rules", "API conventions", "Authorization — RBAC and ownership", "Privacy and
logging", "Security rules", "Domain rules" (16, 17, 19, 20, 22), "Testing policy", "Build order for a new module".
Precedents: [doctors/spec.md](../doctors/spec.md), [schedules/spec.md](../schedules/spec.md).

---

## 1. Overview

### 1.1 What `patients` owns in this slice
| Area | Delivers |
|---|---|
| Table | `patient_profiles` (one migration, raw SQL) |
| Routes | `GET /api/patients/me` (`getMyPatientProfile`) · `PATCH /api/patients/me` (`upsertMyPatientProfile`); role `patient`, ownership `self` |
| Audit | `patient_profile.read` (every successful read), `patient_profile.updated` (create or real change) |
| Service API for later modules | `PatientsService.findTimezoneByUserId(userId)` is **not** added now (YAGNI); `consultations` adds the accessor it needs when it needs it |
| Env / dependencies | none (`luxon` pinned by ADR 0019). No new ADR |
| Contract | **no change** (confirmed, see section 11 and the drift check below) |

### 1.2 Principles
- **Self only.** The row is always resolved from `auth.userId`; no id in a path or body names another patient. Unknown body members (including `id`, `userId`) are rejected `400`.
- **Clinical by default.** Allergies, chronic conditions, blood type, date of birth and gender are clinical/PII: never logged, never in audit metadata, `Cache-Control: no-store` on both responses, never shown to admins (no admin route exists; the DTO also refuses an admin viewer).
- **Reads are audited, before returning.** The audit row is written in the same transaction as the read.
- **Write = audit in the same transaction.** Concurrent first-time writes resolve on `uq_patient_profiles_user_id`; the loser retries as an update, never a 500.
- **No Identity data.** No name, email, phone or avatar is stored or returned.

### 1.3 Dependencies
- **Other modules:** none at runtime. Later: `consultations` (reads the patient's timezone to render local times, owns the doctor-facing profile read), `records` (patient timeline).
- **Other service:** none. Platform deltas: none.

### 1.4 Contract confirmation (drift check against `contracts/openapi.yaml`)
Checked 2026-10-11, operations `getMyPatientProfile` / `upsertMyPatientProfile`, schemas `PatientProfile`, `PatientProfileUpdate`, response `PatientProfileOk`:
- `x-roles: [patient]`, `x-ownership: self`, `x-audit: clinical-read | clinical-write`, `x-audit-actions` match section 3. No `x-account-state` is declared, so the default (`active`) applies — matches CLAUDE.md ("patients must have `status=active`"). Email verification is **not** required (only booking needs it).
- `PATCH` declares `200` only (no `201`): first-time creation also answers `200`. No `409` is declared: the first-write race is resolved internally (rule P-R9), never surfaced. No `404` on `PATCH`; `GET` declares `404`.
- `PatientProfileOk` carries `Cache-Control: no-store`; `PatientProfile` `required` = `id, userId, dateOfBirth, gender, bloodType, allergies, chronicConditions, timezone, createdAt, updatedAt` (all emitted, nullable ones as `null`).
- `PatientProfileUpdate`: `additionalProperties: false`, `minProperties: 1`, array `maxItems: 50`, item `maxLength: 200`, `timezone` `maxLength: 64`, nullable `dateOfBirth`/`gender`/`bloodType`. The extra rules in section 3 (non-blank items, duplicates, `dateOfBirth` not in the future, IANA validity) are `400 ValidationFailed` refinements, a status the contract already declares.
- No `Idempotency-Key` is declared on `PATCH`: no middleware; a sent header is ignored (PATCH is naturally idempotent).

Result: **no contract change required.**

---

## 2. Database schema

### 2.1 Migration (`npm run migrate:make`; sorts after `20261009120000_add_audit_logs_read_indexes`)
| # | File (`src/migrations/<ts>_<name>.ts`) | Change |
|---|---|---|
| 1 | `20261011120000_create_patient_profiles` | table, checks, partial unique index, comments, grants |

Raw SQL, each statement its own `await knex.raw(...)`, run as the owner (`MIGRATION_DATABASE_URL`). `down` drops the table
(no `CASCADE`). No FK: `user_id` is an Identity id; `consultations.patient_user_id` will reference it logically.

### 2.2 `patient_profiles`
```sql
CREATE TABLE patient_profiles (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             BIGINT NOT NULL,                -- Identity user id (no FK)
    date_of_birth       DATE,                           -- clinical/PII; never logged
    gender              VARCHAR(16),
    blood_type          VARCHAR(8),                     -- clinical; never logged
    allergies           TEXT[] NOT NULL DEFAULT '{}',   -- clinical; never logged
    chronic_conditions  TEXT[] NOT NULL DEFAULT '{}',   -- clinical; never logged
    timezone            VARCHAR(64) NOT NULL,           -- canonical IANA zone; no default
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ,
    CONSTRAINT chk_patient_profiles_gender CHECK (gender IS NULL OR gender IN ('female', 'male', 'other', 'undisclosed')),
    CONSTRAINT chk_patient_profiles_blood_type
        CHECK (blood_type IS NULL OR blood_type IN ('A+','A-','B+','B-','AB+','AB-','O+','O-','unknown')),
    CONSTRAINT chk_patient_profiles_allergies_len CHECK (cardinality(allergies) <= 50),
    CONSTRAINT chk_patient_profiles_conditions_len CHECK (cardinality(chronic_conditions) <= 50)
);
COMMENT ON TABLE patient_profiles IS 'Clinical patient profile (demographics, allergies, chronic conditions, timezone). One live row per Identity user. Soft delete only; no route sets deleted_at.';
COMMENT ON COLUMN patient_profiles.user_id IS 'Identity user id';

-- GET/PATCH /patients/me (and the later GET /patients/:patientUserId): SELECT … WHERE user_id = $1 AND deleted_at IS NULL [FOR UPDATE].
-- Partial unique index = the one-live-profile guarantee that resolves the concurrent first PATCH (23505).
CREATE UNIQUE INDEX uq_patient_profiles_user_id ON patient_profiles (user_id) WHERE deleted_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON patient_profiles TO vcare_app;     -- UPDATE sets columns and (later) deleted_at; no DELETE, no TRUNCATE
GRANT USAGE ON SEQUENCE patient_profiles_id_seq TO vcare_app;
```
Notes:
- Identical to `docs/architecture/data-model.md` `patient_profiles`; the document needs no change except the as-built migration name (section 13).
- `uq_patient_profiles_user_id` is a partial unique **index**; the service maps `23505` by `error.constraint = 'uq_patient_profiles_user_id'` (the index name), as `doctors` does.
- Per-element length (≤ 200) and non-blank/duplicate rules for the arrays are **DTO-only**: a PostgreSQL `CHECK` cannot iterate an array without a helper function, and the brainstorm's "DB CHECK" is satisfied for the item **count** (≤ 50) only. This is a deliberate deviation from the brainstorm wording (decision D-1, section 4).
- The `DEFAULT '{}'` on the two arrays comes from the data model (not a critical column); the repository `INSERT` states both values explicitly.
- `date_of_birth <= today` is service-side (a `CHECK` on `CURRENT_DATE` is not immutable and depends on the patient's zone).
- No other index: the only reads are by `user_id`.

---

## 3. API contract and file-level design

### 3.1 Endpoints (mirror `contracts/openapi.yaml`; the contract wins on disagreement)
Common: guard `userGuard()` · **roles** `patient` (`x-roles`) · **ownership** `self` — the profile whose `user_id = auth.userId`, resolved from the database and the verified token, never from the request (`x-ownership: self`) · account state: token `status=active` (default; `pending`/`rejected`/`suspended` patients → `403 Forbidden`); `emailVerified` **not** required · doctor and admin tokens → `403 Forbidden` (role check, deny by default) · `Cache-Control: no-store` on both responses (also on error responses of these routes, via `noStore()` on the path).

| | `GET /api/patients/me` (`getMyPatientProfile`) | `PATCH /api/patients/me` (`upsertMyPatientProfile`) |
|---|---|---|
| Guard | `userGuard()` | `userGuard()` |
| **Roles** | patient | patient |
| **Ownership** | `self` (`user_id = auth.userId`) | `self` |
| Account state | `status=active` | `status=active` |
| Audit (`x-audit-actions`) | `patient_profile.read` (200 only) | `patient_profile.updated` (create, or a real change; none on a no-op) |
| `Idempotency-Key` | n/a | not declared: no middleware; header ignored |
| Rate limit | 120/min per user (`patients-read-user`) | 20/min per user (`patients-write-user`) |
| Request | — | body `PatientProfileUpdate` |
| Success | `200` `PatientProfile` | `200` `PatientProfile` (created, changed, or unchanged) |
| Errors | 401 `Unauthorized`/`TokenExpired`, 403 `Forbidden`, 404 `NotFound` (no profile yet), 429, 500 | 400 `ValidationFailed`, 401, 403, 429, 500 |
| Pagination / filters | none | none |

Neither limit is in CLAUDE.md's table; both are module constants (the `doctors` figures). Window 60 s; `429 RateLimited` + `Retry-After`.
`X-User-Id`, `X-Role` and every other identity header are ignored.

**Response `PatientProfile`** (identical key set to the contract `required` list):
`{ id, userId, dateOfBirth | null, gender | null, bloodType | null, allergies: string[], chronicConditions: string[], timezone, createdAt, updatedAt }`.
`dateOfBirth` is `YYYY-MM-DD`; timestamps are millisecond ISO-8601 with `Z`; arrays keep stored order (insertion order of the last write).

**Request `PatientProfileUpdate`** (all members optional individually; at least one required):
| Field | Rule |
|---|---|
| `dateOfBirth` | `string \| null`; real `YYYY-MM-DD` calendar date (`IsCalendarDate`), not after today in the effective timezone (service); `null` clears |
| `gender` | `null` or one of `female, male, other, undisclosed` |
| `bloodType` | `null` or one of `A+, A-, B+, B-, AB+, AB-, O+, O-, unknown` |
| `allergies` | array ≤ 50; each item a string of 1–200 code points, not blank, no control characters; no duplicate items (exact match); `null` → 400; `[]` clears |
| `chronicConditions` | same rules as `allergies` |
| `timezone` | non-null string ≤ 64, valid IANA zone (`IsIanaTimezone`, luxon); stored canonical (`canonicalIanaTimezone`); **required when no live profile exists** |

- Unknown members → `400` (`forbidNonWhitelisted`); `{}` (every member absent) → `400` (`details[].field = "body"`); a non-object body → `400`.
- Create (no live profile): `timezone` absent → `400` (`details[].field = "timezone"`), nothing written; absent array members create as `[]`, absent nullable members as `null`.
- Update: only provided members change; `null` clears `dateOfBirth`/`gender`/`bloodType`; arrays are replaced whole, never merged.
- Rejected values are never echoed in `details` (clinical text); `details[].field` names the member, `message` is a rule description.
- `null` on `timezone`, `allergies` or `chronicConditions` → `400`.

### 3.2 Route composition (`src/app/patients/routes.ts`)
```ts
export function buildPatientsRouter(): Router {
    const router = Router();
    const controller = container.resolve<PatientsController>(TOKENS.PatientsController);
    const p = PATIENTS_POLICIES;
    const writeLimit = () => rateLimit({ name: "patients-write-user", limit: PATIENTS_WRITE_USER_LIMIT, windowMs: PATIENTS_RATE_WINDOW_MS, subject: byUser });
    const readLimit  = () => rateLimit({ name: "patients-read-user",  limit: PATIENTS_READ_USER_LIMIT,  windowMs: PATIENTS_RATE_WINDOW_MS, subject: byUser });
    router.use("/patients/me", noStore());
    router.get  ("/patients/me", userGuard(), authorize(p.getMe),    readLimit(),  controller.getMe);
    router.patch("/patients/me", userGuard(), authorize(p.updateMe), writeLimit(), controller.updateMe);
    return sealRouter(router);
}
```
- Order: guard → `authorize` → user limiter → handler. No idempotency middleware (not declared).
- Mounted in `src/routes.ts` with `router.use(buildPatientsRouter())`. **Mount order for later modules:** `GET /patients/:patientUserId` (consultations) must be registered **after** `/patients/me` so `me` is never captured as a path parameter. No `router.param`. Route labels: `/api/patients/me` for both.

### 3.3 File list
```
src/app/patients/
  constants.ts        PATIENTS_WRITE_USER_LIMIT (20), PATIENTS_READ_USER_LIMIT (120), PATIENTS_RATE_WINDOW_MS (60_000),
                      MAX_PROFILE_LIST_ITEMS (50), PROFILE_LIST_ITEM_MAX_LENGTH (200),
                      PATIENT_PROFILE_ENTITY_TYPE ("patient_profile"), PATIENT_PROFILE_UNIQUE_USER ("uq_patient_profiles_user_id")
  enums.ts            Gender (female|male|other|undisclosed) and BloodType ({A+..unknown}) = DB checks;
                      PatientAuditAction { Read = "patient_profile.read", Updated = "patient_profile.updated" };
                      PatientProfileField { DateOfBirth = "dateOfBirth", Gender = "gender", BloodType = "bloodType", Allergies = "allergies",
                      ChronicConditions = "chronicConditions", Timezone = "timezone" } (wire names)
  errors.ts           ValidationFailed.withDetails constants: TimezoneRequiredOnCreate (field timezone), EmptyPatientProfileUpdate (field body),
                      DateOfBirthInFuture (field dateOfBirth); reuses NotFound from lib/error/errors
  types.ts            PatientProfileRow, PatientProfileInput (create), PatientProfileChanges (update), PatientProfileColumnChanges,
                      PatientProfileViewer, PatientsRoute, PatientsPolicies
  entity/patient-profile.entity.ts
  dto/patients.request.dto.ts     PatientProfileUpdateDto
  dto/patients.response.dto.ts    PatientProfileResponseDto
  repository/patient-profiles.repo.ts   PATIENT_PROFILE_COLUMNS, findProfileByUserId, findProfileByUserIdForUpdate, insertProfile, updateProfile
  service/patients.service.ts     PatientsService (@injectable)
  policies.ts         PATIENTS_POLICIES
  controller/patients.controller.ts     PatientsController (@injectable, arrow-function methods)
  routes.ts           buildPatientsRouter()
src/lib/validation/text-list-decorator.ts   IsTextList(maxLength) (as built, section 14)
src/app.ts                    noStore() on /api/patients before the JSON parser (as built, section 14)
src/lib/logger/redact.ts      + "gender" in REDACTED_KEYS (one redaction unit-test row)
src/lib/di/tokens.ts, src/bootstrap.ts    PatientsService, PatientsController (Symbol.for tokens, registerSingleton)
src/routes.ts                 mounts buildPatientsRouter()
src/migrations/20261011120000_create_patient_profiles.ts
tests/…                       section 9
```
Every type alias and interface lives in `types.ts` (ESLint enforces). `.env.example` is unchanged. No `lib/` helper is added: transaction scoping, `uniqueViolationConstraint`, `IsCalendarDate`, `IsIanaTimezone`/`canonicalIanaTimezone`, `CodePointLength`, `NoControlCharacters`, `NotBlank`, `noStore`, `rateLimit`/`byUser`, `actorFromAuth` already exist.

### 3.4 Entity
`PatientProfile { id, userId, dateOfBirth: string | null, gender, bloodType, allergies: string[], chronicConditions: string[], timezone, createdAt: Date, updatedAt: Date }`;
plain class, `constructor(data: Partial<PatientProfile>)`, no decorators. `deleted_at` never on the entity (rows are always read live). `dateOfBirth` is a string: the repository selects `to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth` (never a JS `Date`, so no timezone shift).

### 3.5 Request DTO (`dto/patients.request.dto.ts`)
Validated with `lib/validation` (`whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues`, no implicit conversion). Bodies are JSON.
```ts
export class PatientProfileUpdateDto {
    @ValidateIf((_o, v) => v !== undefined && v !== null) @IsCalendarDate() dateOfBirth?: string | null;   // null allowed
    @ValidateIf((_o, v) => v !== undefined && v !== null) @IsIn(Object.values(Gender)) gender?: Gender | null;
    @ValidateIf((_o, v) => v !== undefined && v !== null) @IsIn(Object.values(BloodType)) bloodType?: BloodType | null;
    @ValidateIf((_o, v) => v !== undefined) @IsArray() @ArrayMaxSize(50) @IsTextList(200) allergies?: string[];
    @ValidateIf((_o, v) => v !== undefined) @IsArray() @ArrayMaxSize(50) @IsTextList(200) chronicConditions?: string[];
    @ValidateIf((_o, v) => v !== undefined) @IsIanaTimezone() timezone?: string;
    isEmpty(): boolean;            // every member undefined (never Object.keys) — minProperties: 1
    toChanges(): PatientProfileChanges;
}
```
- Per-item rules (1–200 code points, not blank, no control characters, no duplicates) are enforced on each array member by the single `IsTextList` validator (as built, section 14); the failing member is reported as `allergies` / `chronicConditions` without the value.
- The "not in the future" `dateOfBirth` rule needs the effective timezone and lives in the service.
- Nothing is trimmed or case-folded; list order is preserved.

### 3.6 Response DTO (`dto/patients.response.dto.ts`)
`PatientProfileResponseDto.from(entity, viewer)` — explicit field-by-field copy, `toISOString()` for timestamps. Viewer-aware as CLAUDE.md requires: `viewer = { userId, role }`; the clinical fields are emitted only when `viewer.role === "patient"` and `viewer.userId === entity.userId` (the only reachable case); any other viewer (admin included) makes `from` throw a programming error (→ `500`, never partial data). No row, entity, `deleted_at` or internal key reaches the wire. A unit test asserts the produced keys equal the contract's `PatientProfile.required`.

### 3.7 Repository (functions, `conn: Knex = db`, explicit columns, `whereNull('deleted_at')` on every read, never `SELECT *`)
| Function | SQL |
|---|---|
| `findProfileByUserId(userId, conn)` | `SELECT <PATIENT_PROFILE_COLUMNS> FROM patient_profiles WHERE user_id = ? AND deleted_at IS NULL` (`uq_patient_profiles_user_id`) |
| `findProfileByUserIdForUpdate(userId, trx)` | same with `FOR UPDATE` |
| `insertProfile(userId, input, trx)` | `INSERT INTO patient_profiles (user_id, date_of_birth, gender, blood_type, allergies, chronic_conditions, timezone) VALUES (…) RETURNING <cols>`; arrays bound as `text[]` |
| `updateProfile(id, columns, trx)` | `UPDATE patient_profiles SET <changed columns>, updated_at = NOW() WHERE id = ? AND deleted_at IS NULL RETURNING <cols>` |

`PATIENT_PROFILE_COLUMNS = id, user_id, to_char(date_of_birth,'YYYY-MM-DD') AS date_of_birth, gender, blood_type, allergies, chronic_conditions, timezone, created_at, updated_at`. A private `toEntity(row)`; the repository never logs.

### 3.8 Controller (`controller/patients.controller.ts`)
`@injectable()`, arrow-function methods, validate → service → `sendSuccess`; no business logic. `updateMe`: `validateBody(PatientProfileUpdateDto)` → `dto.isEmpty()` → `EmptyPatientProfileUpdate` → `service.upsert(req.auth, dto.toChanges())`. Failure order: guard 401 → `authorize` 403 (role, status) → limiter 429 → body 400 → service. The viewer passed to `from` is `{ userId: auth.userId, role: auth.role }`.

### 3.9 Service (`service/patients.service.ts`)
```ts
@injectable()
export class PatientsService {
    constructor(
        @inject(TOKENS.Db) private readonly db: Knex,
        @inject(TOKENS.AuditRecorder) private readonly audit: AuditRecorder,
    ) {}
    getOwn(actor: AuthContext): Promise<PatientProfile>;                                  // NotFound when no live profile
    upsert(actor: AuthContext, changes: PatientProfileChanges): Promise<PatientProfile>;
}
```
**`getOwn`** — one transaction (the audit insert needs one): `findProfileByUserId(actor.userId, trx)` → `NotFound` if absent (**no audit row** for a 404: nothing clinical was accessed) → `audit.record(trx, { actor: actorFromAuth(actor), action: Read, entityType: "patient_profile", entityId: profile.id, metadata: { patientUserId: actor.userId } })` → return. If the audit insert fails the read fails (`500`); data is never returned unaudited.

**`upsert`** — validate in the controller, then:
1. Try `upsertOnce`; if it throws `23505` whose `uniqueViolationConstraint(error) === PATIENT_PROFILE_UNIQUE_USER`, re-run `upsertOnce` **once** (outside the failed transaction, as `doctors.apply`); it now finds the winner's row and takes the update path. Any other error, or a second `23505`, propagates.
2. `upsertOnce` — one transaction (handler form): `findProfileByUserIdForUpdate`.
   - **Absent (create):** `changes.timezone === undefined` → `TimezoneRequiredOnCreate` (nothing written). `assertDateOfBirthNotFuture(changes.dateOfBirth, changes.timezone)`. `insertProfile` with `canonicalIanaTimezone(timezone)`, absent arrays `[]`, absent nullable members `null` → `audit.record(trx, { action: Updated, entityType, entityId: row.id, metadata: { created: true, changedFields: "<sorted wire names of the provided members>" } })` → return the inserted row.
   - **Present (update):** compute `diff(current, changes)` over provided members only. Effective timezone = `changes.timezone` (canonical) ?? `current.timezone`; `assertDateOfBirthNotFuture(changes.dateOfBirth, effectiveTimezone)` when `dateOfBirth` is a provided non-null value. Nothing changed → return the current row, **no write, no audit** (P-R8). Changed → `updateProfile(current.id, columns, trx)` → `audit.record(… { created: false, changedFields: "<sorted changed wire names>" })` → return the updated row.
3. Both outcomes answer `200`.

**`diff`** — a member changed only when provided (`!== undefined`) **and** different: scalars by `===` (`null` vs value counts); arrays by element-wise ordered equality (a re-ordered list is a change); timezone compared after canonicalization. `changedFields` names are the `PatientProfileField` wire names, sorted ascending, joined by `,` — names only, never values (≤ 80 characters by construction).

**`assertDateOfBirthNotFuture(dob, timezone)`** — `dob <= DateTime.now().setZone(timezone).toISODate()` using `luxon`; the service reads the clock through `luxon` `DateTime.now()` and tests control it with jest fake timers (no new clock abstraction). Violation → `DateOfBirthInFuture` (`400`, `details[].field = "dateOfBirth"`).

No call to Identity, storage, video or email; nothing happens after the transaction.

### 3.10 Policies (`policies.ts`)
```ts
export const PATIENTS_POLICIES: PatientsPolicies = {
    getMe:    { kind: "user", roles: ["patient"], owner: { kind: "self" }, audit: "clinical-read" },
    updateMe: { kind: "user", roles: ["patient"], owner: { kind: "self" }, audit: "clinical-write" },
};
```
- No `accountState` override: the default (`active`) is the rule. No `checks` (no suspension concept for patients; Identity status in the token governs).
- `owner: self` is trivially satisfied by the route shape (no id parameter); the service scopes every query by `auth.userId`.
- Admin and doctor tokens fail the role check → `403 Forbidden`.

### 3.11 Env and DI
No env variables. Tokens `PatientsService`, `PatientsController` (`Symbol.for`) in `lib/di/tokens.ts`, `registerSingleton` in `src/bootstrap.ts`; the boot route assertion (access spec) covers the two routes.

---

## 4. Business rules

| # | Rule | Enforced by |
|---|---|---|
| P-R1 | Only a patient with token `status=active` can call either route; doctors, admins, and non-active patients get `403` | `authorize` role + account-state check |
| P-R2 | A caller only ever reads or writes the profile with `user_id = auth.userId`; no request member selects the row (Domain rules 16, 17) | service scoping + DTO whitelist |
| P-R3 | `GET` answers `404 NotFound` until the profile exists | service |
| P-R4 | Every successful `GET` writes one `patient_profile.read` audit row in the same transaction; a 404 writes none | service transaction |
| P-R5 | Creating the profile requires `timezone` (Domain rule 20); the stored zone is the canonical IANA name | DTO (`IsIanaTimezone`) + service |
| P-R6 | `PATCH` is partial: only provided members change; `null` clears `dateOfBirth`, `gender`, `bloodType`; arrays are replaced whole; `timezone`/arrays are never null | DTO + service `diff` |
| P-R7 | `allergies` / `chronicConditions`: ≤ 50 items (DTO + DB `CHECK`), each 1–200 code points, non-blank, no control characters, no duplicates (DTO) | DTO + `chk_patient_profiles_allergies_len`, `chk_patient_profiles_conditions_len` |
| P-R8 | A `PATCH` that changes nothing answers `200` with the current row, writes nothing and audits nothing | service |
| P-R9 | Two concurrent first-time `PATCH`es end with exactly one row and both `200`; the loser retries as an update, never a `500`/`409` | `uq_patient_profiles_user_id` + one service retry |
| P-R10 | A real create or change writes one `patient_profile.updated` audit row in the same transaction; metadata holds `created` and changed field **names** only | service transaction |
| P-R11 | `dateOfBirth` is a real calendar date, not after today in the patient's (effective) timezone | DTO + service |
| P-R12 | Allergies, conditions, blood type, date of birth and gender never appear in logs, audit metadata, `details`, or error messages | logger redaction (defence in depth) + code discipline |
| P-R13 | Both responses carry `Cache-Control: no-store` and the DTO refuses a non-owner or admin viewer | `noStore()` + `PatientProfileResponseDto.from` |
| P-R14 | Soft delete only: reads filter `deleted_at IS NULL`; the app role has no `DELETE`; no route sets `deleted_at` | repository + grants |
| P-R15 | The patient never writes medical-record fields (Domain rule 16): the profile holds no diagnosis, notes or treatment | DTO whitelist |

### Decisions (taken by this spec; none changes the contract)
- **D-1** Per-item array rules are DTO-only (section 2.2 note).
- **D-2** Creation answers `200`, the single declared success status; a distinct `patient_profile.created` action is not added — `patient_profile.updated` with `created: true` in metadata (no contract change).
- **D-4** Duplicate list items are rejected, not silently de-duplicated (no hidden mutation of clinical text).
- **D-5** A 404 read is not audited (no clinical data was accessed); a read that fails to audit fails.
- **D-6** Rate limits mirror `doctors` (120/min read, 20/min write).

---

## 5. Cross-service behavior
None. No call to Identity (the role and status come from the verified token; no name, email or avatar is stored), storage, video, or email. No failure policy applies.

---

## 6. Error codes
| Code | HTTP | When |
|---|---|---|
| `ValidationFailed` | 400 | any DTO rule (section 3.1); empty body (`field: body`); create without `timezone` (`field: timezone`); `dateOfBirth` in the future; unknown member |
| `Unauthorized` / `TokenExpired` | 401 | missing, invalid or expired bearer token |
| `Forbidden` | 403 | role is not `patient`; patient token status not `active` |
| `NotFound` | 404 | `GET` before the profile exists |
| `RateLimited` | 429 | limiter tripped (`Retry-After`) |
| `InternalError` | 500 | unhandled, including a failed audit insert |

No new codes. `Conflict`/`409` is never emitted by this module.

---

## 7. Security & privacy
- **RBAC summary:** `patient` (self, active) only. Doctor: `403` on the two `/patients/me` routes (a doctor reads a patient through `GET /patients/{id}`, built in `consultations` on 2026-10-12, section 14). Admin: `403` on both routes; admins never receive clinical fields.
- **Audit events:** `patient_profile.read` (entity `patient_profile`, entity id = profile id, metadata `{ patientUserId }`); `patient_profile.updated` (metadata `{ created, changedFields }`). Actor from the verified token via `actorFromAuth`; request id attached automatically.
- **Never logged / never audited:** `allergies`, `chronicConditions`, `bloodType`, `dateOfBirth`, `gender` (the key list in `lib/logger/redact.ts`; `gender` is added by this module), and the request and response bodies of these routes. The controller and service pass no profile data to the logger; `AuditRecorder` already rejects redacted key names in metadata.
- **Responses:** `Cache-Control: no-store` on both routes and on their error responses.
- **Rate limits:** read 120/min per user, write 20/min per user (Redis sliding window).
- **Files:** none. No Idempotency-Key.
- **Synthetic fixtures only:** tests use clearly fake strings (for example `"TEST-ALLERGEN-A"`), asserted absent from captured logs.

---

## 8. Performance
Not a hot path; no CLAUDE.md budget. Target p95 below the 200 ms booking-write budget.
- `GET`: one transaction, 2 statements (profile select by `user_id`, audit insert) plus `BEGIN`/`COMMIT`.
- `PATCH`: one transaction, 3 statements (`SELECT … FOR UPDATE`, `INSERT`/`UPDATE … RETURNING`, audit insert); a no-op is 1 statement.
- Index coverage: `uq_patient_profiles_user_id` serves every query. A unit/integration test runs `EXPLAIN` on the select (index scan on a seeded table, no seq scan).
- No N+1, no cache, no Redis use beyond the rate limiter.

---

## 9. Test plan outline

### 9.1 Unit (`tests/unit/`)
- `patients.request.dto`: should reject `{}` as empty; unknown member (`userId`, `id`, `fullName`); null `timezone`/arrays; invalid IANA zone; bad `gender`/`bloodType`; array of 51 items; item of 201 code points; blank item; control character; duplicate item; non-calendar `dateOfBirth` (`2027-02-30`); accept `null` for the three nullable members; accept a valid full body.
- `patients.response.dto`: should emit exactly the contract's `PatientProfile.required` keys; should throw for an admin or another user's viewer; timestamps are ms ISO `Z`.
- `patients.service` (repo/audit mocked): P-R3 (404, no audit), P-R4 (read audits once with the id and `patientUserId` only), P-R5 (create without timezone → `TimezoneRequiredOnCreate`, nothing written; canonical zone stored), P-R6 (clearing with `null`, whole-array replace), P-R8 (no-op → no update, no audit), P-R9 (first `23505` on the right constraint → exactly one retry that updates; other constraint or second `23505` propagates), P-R10 (metadata has only `created` and sorted field names, never values), P-R11 (future date in the effective timezone rejected using fake timers; a date that is "tomorrow" in UTC but "today" in `Pacific/Kiritimati` accepted), audit failure on read → error, no data returned.
- `diff`: ordered array equality, canonical timezone comparison, `null` vs value.
- Redaction: `gender` row added to the redaction unit test.
- `policies`: roles `[patient]`, owner `self`, no account-state override (default `active`).

### 9.2 Integration (`tests/integration/patients.test.ts`, real `src/routes.ts`, real Postgres and Redis; no mocked services or repositories)
- **RBAC per route** (both): no token 401; expired token 401; patient `active` allowed; patient `pending`/`rejected` 403; doctor (each status) 403; **admin 403 on both**; identity headers (`X-User-Id`, `X-Role`) ignored.
- **Ownership:** two patients each see only their own profile; a body member `userId` is rejected 400 and cannot redirect the write.
- **Flow:** GET before create → 404; PATCH without `timezone` → 400 and no row; PATCH with `timezone` → 200 with `[]` arrays and `null` scalars; GET → 200 equal body; partial PATCH keeps untouched members; `null` clears; arrays replaced; no-op PATCH leaves `updated_at` unchanged and writes no audit row.
- **Concurrency:** N parallel first-time PATCHes of one patient → every response 200, exactly one live row.
- **Audit:** each GET 200 writes one `patient_profile.read` row (actor, role, entity id, request id); 404 GET writes none; create and real change write one `patient_profile.updated` row with `created` / `changedFields` and **no clinical value in `metadata`**; every profile write has exactly one matching audit row (row and audit counts agree); the rollback-on-audit-failure case is a unit test.
- **Contract conformance:** statuses, the `ValidationFailed` envelope with `details`, and the `PatientProfile` schema validated against `contracts/openapi.yaml`; `Cache-Control: no-store` and `X-Request-Id` present on 200, 400, 403, 404.
- **Logs contain no clinical fixture strings** after exercising create, update, read and the 400 paths.
- **Rate limit:** the 21st PATCH in a window → `429` with `Retry-After`.
- **Schema:** migration up/down; `vcare_app` has `SELECT, INSERT, UPDATE` and no `DELETE`; checks reject an invalid `gender`/`blood_type`/51-item array via `care_app`; a soft-deleted row does not block a new live row for the same `user_id`.
- **EXPLAIN:** the select by `user_id` uses `uq_patient_profiles_user_id`.

### 9.3 Mandatory scenarios from "Testing policy" that apply
RBAC per route including admin denied; every clinical read writes an audit row; logs contain no clinical fixture strings; Domain rules 16, 17, 20, 22. Not applicable here: concurrent booking, idempotent replay, Case 1–4, files, slot budget, pagination.

### 9.4 Manual QA (`/manual-qa patients`)
CURL both routes with patient, doctor and admin tokens plus `X-Request-Id`; compare statuses and error codes to the contract; never record clinical fixture text or tokens.

---

## 10. Out of scope
- `GET /api/patients/{patientUserId}` and `GET /api/patients/{patientUserId}/records` (doctor access via `consultations` `EXISTS`; timeline needs `medical_records`) — `consultations` / `records`.
- Names, emails, phones, avatars (Identity-owned; hydrated by Case 2 elsewhere); any Identity call.
- A delete or deactivate endpoint (`deleted_at` exists for the platform rule only).
- Medical-record fields, attachments, documents, uploads.
- Admin access of any kind; patient search or lists.
- Notifications, caches, background work.
- Phase-2 AI draft artifacts.

---

## 11. Open questions
None. Contract changes required: **none** (section 1.4). Platform changes required (`/system-design`): none.

The brainstorm's question about which module ships `GET /patients/{id}` is a scoping decision for the `consultations` brainstorm and does not affect this module.

---

## 12. Task ordering (CLAUDE.md → Build order for a new module)
0. Contract: no edit. 1. Migration `20261011120000_create_patient_profiles`. 2. `enums.ts`, `errors.ts`, `types.ts`, `constants.ts`. 3. Entity. 4. Request DTO. 5. Response DTO. 6. Repository. 7. Service + `gender` redaction key + DI tokens. 8. `policies.ts`. 9. Controller. 10. `routes.ts`. 11. Mount in `src/routes.ts`. 12. Tests (unit, integration, RBAC, contract, concurrency). 13. Manual QA + `scripts/curl-test-patients.sh`. 14. Docs.

## 13. Required follow-ups (docs; not open questions)
Done 2026-10-11: `docs/service-card.md` (`patient_profiles` built, `GET/PATCH /api/patients/me` live), `docs/architecture/data-model.md` (as-built migration name, DTO-only per-item rules), `api.md`, `rbac.md`, `overview.md`, `docs/INDEX.md`, `quickstart.md`.
Remaining: run the hub sync (`../vcare-hub/scripts/sync-from-spoke.sh`) for the service card; never hand-copy into the hub.

---

## 14. As-built notes (2026-10-11, version 1.1.0)
Intentional divergences from sections 1-13; the contract is unchanged.
- **No lower bound on `dateOfBirth`.** The only date rules are a real calendar date (`IsCalendarDate`) and not after today in the effective timezone. A 1900 floor was considered but not built; do not read any minimum into the contract (`format: date` only).
- **`IsTextList(maxLength)` replaces the planned per-item decorator stack.** Per-item rules for `allergies` / `chronicConditions` (1..200 code points, not blank, no control characters, no duplicates; non-arrays left to `IsArray`) live in one domain-free validator, `src/lib/validation/text-list-decorator.ts`, under the generic-helpers rule; the rejected value is never in the message. Unit-tested in `tests/unit/lib/validation/text-list-decorator.test.ts`. Section 3.5 behavior is unchanged.
- **`dateOfBirth` is selected with `to_char(date_of_birth, 'YYYY-MM-DD')`** in `PATIENT_PROFILE_COLUMNS`, so the entity carries a string and no JS `Date` timezone shift is possible (as written in sections 3.4 and 3.7).
- **`noStore()` is mounted twice.** Besides `router.use("/patients/me", noStore())`, `src/app.ts` mounts `app.use("/api/patients", markPreAuth(noStore()))` **before** `express.json`, so parser-level errors (malformed JSON, oversize body, wrong content type) on the whole `/api/patients` prefix also carry `Cache-Control: no-store` (found by manual QA). The prefix also covers `/api/patients/{patientUserId}`. **Superseded 2026-10-12 (consultations):** the per-router `router.use("/patients/me", noStore())` is gone; the prefix is now one entry of `NO_STORE_PREFIXES` (`src/routes.ts`: `/api/patients`, `/api/consultations`, `/api/admin`, `/api/audit-logs`), mounted by a loop in `src/app.ts` before `express.json`.
- **Policies declare the audit class.** `PATIENTS_POLICIES` sets `audit: "clinical-read"` (`getMe`) and `audit: "clinical-write"` (`updateMe`), mirroring the contract's `x-audit`; the field is declarative, the service writes the rows (section 3.10 updated).
- **`gender` added to `REDACTED_KEYS`** (`src/lib/logger/redact.ts`), as planned.
- **`GET /api/patients/{patientUserId}` is built (2026-10-12, version 1.2.0, `consultations` module).** The route lives in this module's router, registered after `/patients/me`; policy `getById` (roles patient and doctor, resolver `consulted_patient_or_self`, check `doctor_not_suspended`, audit class `clinical-read`). Access: the patient only for their own id; a doctor with a non-deleted `booked`, `waiting`, `in_progress` or `completed` consultation with that patient (decision D-R4: a `booked` consultation counts, for pre-visit intake; `cancelled`/`no_show` alone do not); everyone else `404`; admin `403`; a suspended doctor `403`; a patient with no profile row yet `404`; a non-numeric id `404`. `PatientsService.getForViewer` loads the profile and writes `patient_profile.read` (`{ patientUserId, viewerRole }`) in a transaction before returning; `PatientProfileResponseDto.from` accepts the owning patient or a doctor viewer and still throws for an admin. The relationship comes through the `PatientRelationshipChecker` port (implemented by `ConsultationsService.hasConsultationRelationship`, `idx_consultations_doctor_user_id_patient_user_id`). Rate limit: the patients read limiter, 120/min per user, shared with `/patients/me`. [consultations spec](../consultations/spec.md) section 3.1.
- **Still planned:** `GET /api/patients/{patientUserId}/records` (needs `medical_records`; ships with `records`) and its use of the same relationship resolver.
- Verification: manual QA 135 pass / 0 fail ([manual-qa.md](./manual-qa.md)).
