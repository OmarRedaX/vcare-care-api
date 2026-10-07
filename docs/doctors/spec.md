---
title: doctors — Spec
owner: care-team
service: care-service
module: doctors
status: implemented
version: 1.1.0
diataxis: reference
last_verified: 2026-10-07
tags: [spec, doctors, onboarding, profile, specialties, validation, rate-limit, idempotency, audit, migration]
related: [doctors-brainstorm, specialties-spec, access-spec, foundation-spec, rbac, data-model, api, integration, adr-0004-cross-service-failure-policies, adr-0012-doctor-reinstatement, adr-0016-foundation-runtime-dependencies, adr-0017-generic-helpers-and-transaction-scoping, adr-0018-db-role-split-explicit-grants-partition-function]
contracts: [contracts/openapi.yaml]
---

# doctors — Spec

The first slice of the doctor marketplace: the doctor's own **profile** (`doctor_profiles` with its language and
specialty child sets) and the four onboarding routes that create, edit, and read it. It sits on the `access` base
(`userGuard` → `authorize(policy)` → `AuditRecorder.record(trx, …)`, the boot route assertion) and the `specialties`
catalog, and it supplies the `doctor_not_suspended` policy check the access base reserved for it.

Scope follows [brainstorm.md](./brainstorm.md) exactly. Documents and the admin decision (`verification`), suspension and
reinstatement (Cases 3 and 4), search and public read (`availability`), schedules, and every Identity call are **out of
scope**; this slice makes **no cross-service call**.

Binding rules: CLAUDE.md → "Database rules", "API conventions", "Authentication and service-to-service auth",
"Authorization — RBAC and ownership", "Security rules", "Privacy and logging", "Testing policy", "Build order for a new
module". Precedent for depth and shape: [specialties/spec.md](../specialties/spec.md); the access base:
[access/spec.md](../access/spec.md) (§3.2 route composition, §3.4 `authorize` and `AccessCheck`, §3.5 `AuditRecorder`).

---

## 1. Overview

### 1.1 What `doctors` owns in this slice
| Area | Delivers |
|---|---|
| Tables | `doctor_profiles`, `doctor_languages`, `doctor_specialties` (three migrations, raw SQL) |
| Routes | `POST /api/doctors/apply`, `GET /api/doctors/me`, `PATCH /api/doctors/me`, `GET /api/doctors/me/application` (all role `doctor`, ownership `self`) |
| Audit | `doctor.profile_created`, `doctor.profile_updated`, written in the write's transaction |
| Policy check | `doctor_not_suspended` (`AccessCheck`, reads `doctor_profiles.suspended_at` by `auth.userId`), exported for every later practising-doctor policy |
| Env | `ALLOWED_CURRENCIES` (fee currency allowlist) |
| Dependencies added | `luxon` (locked-stack member, deferred by ADR 0016 "land with the module that needs them"; first use is timezone validation) and its dev typings — no new ADR |
| Logger | `headline`, `bio`, `reviewNote` added to `REDACTED_KEYS` |

### 1.2 Principles
- **Self only.** Every route acts on `auth.userId`; there is no id in any path and no member of any body can name
  another doctor (`userId` in a body → 400 "is not allowed"). Identity headers are ignored.
- **The database owns invariants it can own.** One live profile per user (`uq_doctor_profiles_user_id`), one primary
  specialty (`uq_doctor_specialties_primary`), unique language and specialty links, value checks. Concurrent first
  `apply` calls lose on the unique index and are resolved as an update, never a 500 (§3.9).
- **Audit in the same transaction**; field **names** only, never values; a no-op writes no audit row (specialties S1).
- **Professional data, not clinical** — but `headline`, `bio`, `reviewNote` stay out of logs and audit metadata by rule.
- **Contract-exact validation.** DTO rules equal the contract schemas and the DB checks, plus the currency allowlist
  (stricter than the contract's `^[A-Z]{3}$`, a user decision). Lengths count code points; control characters rejected
  (`CodePointLength`, `NoControlCharacters` from `lib/validation`, the specialties review lessons).
- **Dormant `submit`.** `submit=true` is contract-exact and always returns the documented `400` in this slice (no
  document can exist); it starts working when `verification` lands. No contract change.

### 1.3 Dependencies
- **Other modules:** foundation, access, and `specialties` — through `SpecialtiesService` only (never its repository):
  one new read method `findByIds(ids, conn?)` (§3.9; a new `= ANY($1)` repository function in the specialties module, no
  behaviour change to its routes).
- **Other service:** none. No Identity call, so `lib/identity-client` is not built here. Platform deltas: none.
- **New runtime dependency:** `luxon` (pin at install). **New env variable:** `ALLOWED_CURRENCIES` (§3.11).

---

## 2. Database schema

### 2.1 Migrations (timestamps assigned by `npm run migrate:make`, all sorting after the specialties migrations)
| # | File (`src/migrations/<ts>_<name>.ts`) | Change |
|---|---|---|
| 1 | `<ts>_create_doctor_profiles` | table, checks, partial unique index, comments, grants |
| 2 | `<ts>_create_doctor_languages` | table, constraints, comments, grants |
| 3 | `<ts>_create_doctor_specialties` | table, constraints, FK index, partial unique primary index, comments, grants |

One change per file, each statement its own `await knex.raw(...)`, run as the owner. `down` drops in reverse order with
no `CASCADE`. The specialties seed migration's `down` already guards on `to_regclass('public.doctor_specialties')`.

### 2.2 Migration 1 — `doctor_profiles`
Columns are those of [data-model.md → `doctor_profiles`](../architecture/data-model.md) (the whole row is created now,
so later modules add writers, not columns), with the checks below added.
```sql
CREATE TABLE doctor_profiles (
    id                     BIGSERIAL PRIMARY KEY,
    user_id                BIGINT NOT NULL,              -- Identity user id (no FK)
    headline               VARCHAR(160) NOT NULL,
    bio                    TEXT,
    years_experience       INT NOT NULL,
    consultation_fee       INT NOT NULL,                 -- minor units; no default
    currency               CHAR(3) NOT NULL,             -- no default
    default_slot_minutes   INT NOT NULL,                 -- no default
    timezone               VARCHAR(64) NOT NULL,         -- IANA, validated by the service with luxon
    is_accepting_patients  BOOLEAN NOT NULL,             -- no default: the INSERT states it
    verification_status    VARCHAR(16) NOT NULL,         -- no default: the INSERT states 'draft'
    submitted_at           TIMESTAMPTZ,
    reviewed_by            BIGINT,                       -- Identity user id (admin)
    review_note            TEXT,
    decided_at             TIMESTAMPTZ,
    identity_sync_status   VARCHAR(16) NOT NULL,         -- no default: the INSERT states 'not_required'
    suspended_at           TIMESTAMPTZ,
    suspended_by           BIGINT,                       -- Identity user id (admin)
    suspension_reason      TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at             TIMESTAMPTZ,
    CONSTRAINT chk_doctor_profiles_verification_status CHECK (verification_status IN ('draft','submitted','approved','rejected')),
    CONSTRAINT chk_doctor_profiles_identity_sync_status CHECK (identity_sync_status IN ('not_required','pending','synced','failed')),
    CONSTRAINT chk_doctor_profiles_years_experience CHECK (years_experience BETWEEN 0 AND 70),
    CONSTRAINT chk_doctor_profiles_fee CHECK (consultation_fee >= 0),
    CONSTRAINT chk_doctor_profiles_currency CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT chk_doctor_profiles_default_slot CHECK (default_slot_minutes BETWEEN 5 AND 240),
    CONSTRAINT chk_doctor_profiles_headline_length CHECK (char_length(headline) >= 5),   -- added: contract minLength 5
    CONSTRAINT chk_doctor_profiles_bio_length CHECK (bio IS NULL OR char_length(bio) <= 4000),  -- added: contract maxLength
    CONSTRAINT chk_doctor_profiles_suspension CHECK ((suspended_at IS NULL AND suspension_reason IS NULL) OR (suspended_at IS NOT NULL AND suspension_reason IS NOT NULL)),
    CONSTRAINT chk_doctor_profiles_decision CHECK (verification_status NOT IN ('approved','rejected') OR decided_at IS NOT NULL)
);
COMMENT ON TABLE doctor_profiles IS 'One live profile per Identity doctor account. Soft delete only (vcare_app has no DELETE).';

-- One live profile per account. Serves: SELECT … FROM doctor_profiles WHERE user_id = $auth.userId AND deleted_at IS NULL
-- (every route of this module, the doctor_not_suspended check, and later GET /doctors/:doctorUserId and PATCH /admin/doctors/:id/suspend);
-- the unique violation (23505) on it resolves a concurrent first apply.
CREATE UNIQUE INDEX uq_doctor_profiles_user_id ON doctor_profiles (user_id) WHERE deleted_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON doctor_profiles TO vcare_app;     -- no DELETE (soft delete), no TRUNCATE
GRANT USAGE ON SEQUENCE doctor_profiles_id_seq TO vcare_app;
```
- `uq_doctor_profiles_user_id` is a **unique index** (partial), not a table constraint — a partial unique cannot be a
  constraint; the service maps SQLSTATE `23505` by `error.constraint = 'uq_doctor_profiles_user_id'` (the index name).
- The search (`idx_doctor_profiles_bookable_*`) and verification-queue partial indexes of `data-model.md` are **deferred**:
  no query in this slice uses them; the `availability` and `verification` migrations add them.
- `created_at`/`updated_at` keep `DEFAULT NOW()` (technical timestamps, as in `specialties`); `updated_at` is set by the
  `UPDATE` statement (no trigger).

### 2.3 Migration 2 — `doctor_languages`
```sql
CREATE TABLE doctor_languages (
    id                 BIGSERIAL PRIMARY KEY,
    doctor_profile_id  BIGINT NOT NULL,
    language_code      CHAR(2) NOT NULL,                  -- ISO 639-1, lowercase
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_doctor_languages_doctor_profile_id FOREIGN KEY (doctor_profile_id) REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
    CONSTRAINT uq_doctor_languages_doctor_profile_id_language_code UNIQUE (doctor_profile_id, language_code),
    CONSTRAINT chk_doctor_languages_code CHECK (language_code ~ '^[a-z]{2}$')
);
-- The unique constraint covers the FK (leading column doctor_profile_id) and serves:
--   SELECT language_code FROM doctor_languages WHERE doctor_profile_id = $1 ORDER BY language_code
GRANT SELECT, INSERT, DELETE ON doctor_languages TO vcare_app;   -- the set is replaced by diff; link rows are not a soft-delete entity (data-model.md)
GRANT USAGE ON SEQUENCE doctor_languages_id_seq TO vcare_app;
```
The language-code search index of `data-model.md` is deferred to the search module.

### 2.4 Migration 3 — `doctor_specialties`
```sql
CREATE TABLE doctor_specialties (
    id                 BIGSERIAL PRIMARY KEY,
    doctor_profile_id  BIGINT NOT NULL,
    specialty_id       BIGINT NOT NULL,
    is_primary         BOOLEAN NOT NULL,                  -- no default
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_doctor_specialties_doctor_profile_id FOREIGN KEY (doctor_profile_id) REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
    CONSTRAINT fk_doctor_specialties_specialty_id FOREIGN KEY (specialty_id) REFERENCES specialties(id) ON DELETE RESTRICT,
    CONSTRAINT uq_doctor_specialties_doctor_profile_id_specialty_id UNIQUE (doctor_profile_id, specialty_id)
);
-- The unique constraint covers fk_…_doctor_profile_id and serves: SELECT specialty_id, is_primary FROM doctor_specialties WHERE doctor_profile_id = $1
-- Covers fk_doctor_specialties_specialty_id (RESTRICT check when a specialty row changes) and the future search filter ?specialty=.
CREATE INDEX idx_doctor_specialties_specialty_id_doctor_profile_id ON doctor_specialties (specialty_id, doctor_profile_id);
-- At most one primary specialty per profile (exactly one is enforced by the service in the same transaction, §4 D-R6).
CREATE UNIQUE INDEX uq_doctor_specialties_primary ON doctor_specialties (doctor_profile_id) WHERE is_primary;
GRANT SELECT, INSERT, UPDATE, DELETE ON doctor_specialties TO vcare_app;   -- UPDATE: is_primary moves; DELETE: removed links (diff)
GRANT USAGE ON SEQUENCE doctor_specialties_id_seq TO vcare_app;
```
- `ON DELETE RESTRICT` on both FKs; no cascade (clinical-adjacent tables never cascade).
- Because `specialties` rows are never deleted, `23503` cannot occur; an inactive specialty keeps its links (D5).
- A non-deferrable unique index is checked per row, so the service orders statements to avoid a transient second primary
  (§3.9 `replaceSpecialties`).

---

## 3. API contract and file-level design

### 3.1 Endpoints (mirror `contracts/openapi.yaml`; the contract wins on disagreement)
| | `POST /api/doctors/apply` (`applyAsDoctor`) | `GET /api/doctors/me` (`getMyDoctorProfile`) | `PATCH /api/doctors/me` (`updateMyDoctorProfile`) | `GET /api/doctors/me/application` (`getMyApplication`) |
|---|---|---|---|---|
| Guard | `userGuard()` | `userGuard()` | `userGuard()` | `userGuard()` |
| **Roles** (`x-roles`) | doctor | doctor | doctor | doctor |
| **Ownership** (`x-ownership`) | `self` — profile by `auth.userId` | `self` | `self` | `self` |
| Account state | token `pending`, `active`, or `rejected` | same | same **and** `doctor_not_suspended` | same |
| Audit (`x-audit-actions`) | `doctor.profile_created` (201), `doctor.profile_updated` (200 with a real change) — contract edit C1 | — | `doctor.profile_updated` (real change only) | — |
| `Idempotency-Key` | **optional** (`IdempotencyKeyOptional`) | n/a | not declared → no middleware; a sent header is ignored | n/a |
| Rate limit | 20/min per user (D7) | 120/min per user | 20/min per user | 120/min per user |
| Request | body `DoctorApplyRequest` | — | body `DoctorProfileUpdate` | — |
| Success | `201` created draft · `200` updated draft/rejected — both `{ success, data: DoctorProfileOwn }`; `202 ApprovalPendingSync` is declared but **never emitted in this slice** (D1) | `200` `DoctorProfileOwn` | `200` `DoctorProfileOwn` | `200` `VerificationApplication` |
| Errors | 400, 401, 403, 409 `Conflict`, 422 `IdempotencyConflict`, 429, 500 | 401, 403, 404, 429, 500 | 400, 401, 403, 404, 429, 500 | 401, 403, 404, 429, 500 |
| `Cache-Control: no-store` | not required (professional, not clinical or consultation) | not required | not required | not required |

Every status is declared by the contract for that operation. `409` on `apply` is the contract's `Conflict`
(`submitted`/`approved`). Locally-suspended `PATCH` → `403 Forbidden` (contract text). There is no `DELETE` route.

**Response `DoctorProfileOwn`** — exactly the contract's `required` list plus `reviewNote`; identical for every viewer
(only the owner can call these routes, so the DTO is not viewer-aware yet):
`{ id, userId, headline, bio | null, yearsExperience, languages: string[] (sorted ascending), specialties: SpecialtyRef[]
(primary first, then name ASC, id ASC), consultationFee: { amount, currency }, defaultSlotMinutes, timezone,
isAcceptingPatients, verificationStatus, reviewNote | null, identitySyncStatus, isSuspended, suspendedAt | null,
isBookable, createdAt, updatedAt }`. `isSuspended = suspended_at !== null`. Timestamps are millisecond ISO strings with
`Z`. `isBookable` is Domain rule 6 evaluated now (D-R12).

**Response `VerificationApplication`** for `GET /me/application` (D8): `{ id: profile id, doctorUserId, doctor:
{ displayName: null, avatarUrl: null, profileHydrated: false }, status, identitySyncStatus, specialties, yearsExperience,
submittedAt, decidedAt, reviewedBy, reviewNote, documents: [], missingRequirements }`.
`missingRequirements` = `["license_document", "id_document"]` while `status ∈ {draft, rejected}` (no document can exist
yet), else `[]`. The `doctor` block is the contract's degraded form (Case 2 shape); see Open question O3.

### 3.2 Route composition (`src/app/doctors/routes.ts`)
```ts
export function buildDoctorsRouter(): Router {
    const router = Router();
    const controller = container.resolve<DoctorsController>(TOKENS.DoctorsController);
    const p = DOCTORS_POLICIES;
    const writeLimit = (): RequestHandler => rateLimit({ name: "doctors-write-user", limit: DOCTORS_WRITE_USER_LIMIT, windowMs: DOCTORS_RATE_WINDOW_MS, subject: byUser });
    const readLimit = (): RequestHandler => rateLimit({ name: "doctors-read-user", limit: DOCTORS_READ_USER_LIMIT, windowMs: DOCTORS_RATE_WINDOW_MS, subject: byUser });

    router.post("/doctors/apply", userGuard(), authorize(p.apply), writeLimit(), idempotency({ required: false }), controller.apply);
    router.get("/doctors/me", userGuard(), authorize(p.getMe), readLimit(), controller.getMe);
    router.patch("/doctors/me", userGuard(), authorize(p.updateMe), writeLimit(), controller.updateMe);
    router.get("/doctors/me/application", userGuard(), authorize(p.getApplication), readLimit(), controller.getApplication);
    return sealRouter(router);
}
```
- Order: guard → `authorize` → user limiter → idempotency → handler (access spec §3.2). All callers are authenticated, so
  no pre-auth IP limiter (specialties used one because its list is public-read).
- Paths are full, mounted without a path in `src/routes.ts` (`router.use(buildDoctorsRouter())`); route labels are
  `/api/doctors/apply`, `/api/doctors/me`, `/api/doctors/me/application`.
- **Mount order for later modules:** `GET /doctors/:doctorUserId` (discovery) must be registered **after** the `/doctors/me*`
  routes so `me` is never captured as a path parameter. No `router.param`.

### 3.3 File list
```
src/app/doctors/
  constants.ts                          DOCTORS_WRITE_USER_LIMIT (20), DOCTORS_READ_USER_LIMIT (120), DOCTORS_RATE_WINDOW_MS (60_000),
                                        HEADLINE_MIN/MAX_LENGTH (5/160), BIO_MAX_LENGTH (4000), YEARS_EXPERIENCE_MIN/MAX (0/70),
                                        DEFAULT_SLOT_MINUTES_MIN/MAX (5/240), TIMEZONE_MAX_LENGTH (64), LANGUAGES_MIN/MAX (1/10),
                                        SPECIALTIES_MIN/MAX (1/5), FEE_AMOUNT_MAX (2_147_483_647), LANGUAGE_CODE_PATTERN,
                                        DOCTOR_PROFILE_ENTITY_TYPE ("doctor_profile"), DOCTOR_PROFILE_UNIQUE_USER ("uq_doctor_profiles_user_id")
  enums.ts                              VerificationStatus, IdentitySyncStatus (string enums = DB checks),
                                        DoctorAuditAction { ProfileCreated = "doctor.profile_created", ProfileUpdated = "doctor.profile_updated" },
                                        DoctorProfileField { Headline, Bio, YearsExperience, Languages, Specialties, PrimarySpecialty,
                                        ConsultationFee, DefaultSlotMinutes, Timezone, IsAcceptingPatients } (wire names)
  errors.ts                             ApplicationNotEditable, SubmitRequiresDocuments, UnknownSpecialty, PrimarySpecialtyNotLinked,
                                        PrimarySpecialtyRequired, CurrencyNotAllowed, EmptyDoctorProfileUpdate (§6)
  types.ts                              DoctorProfileRow, DoctorProfileInput, DoctorProfileColumnChanges, DoctorProfileChanges,
                                        DoctorProfileView, DoctorProfileDiff, SpecialtyLink, ApplyResult, DoctorsRoute, DoctorsPolicies
  entity/doctor-profile.entity.ts       class DoctorProfile
  dto/doctors.request.dto.ts            MoneyDto, DoctorApplyDto, DoctorProfileUpdateDto
  dto/doctors.response.dto.ts           DoctorProfileOwnResponseDto, VerificationApplicationResponseDto, MoneyResponseDto, SpecialtyRefResponseDto
  repository/doctor-profiles.repo.ts    DOCTOR_PROFILE_COLUMNS, findProfileByUserId, findProfileByUserIdForUpdate, insertProfile,
                                        updateProfile, isUserLocallySuspended
  repository/doctor-languages.repo.ts   listLanguages, insertLanguages, deleteLanguagesNotIn
  repository/doctor-specialties.repo.ts listSpecialtyLinks, deleteLinksNotIn, clearPrimaryExcept, insertLinks, markPrimary
  service/doctors.service.ts            DoctorsService (@injectable)
  checks.ts                             doctorNotSuspendedCheck(service): AccessCheck  (exported for later practising-doctor policies)
  policies.ts                           DOCTORS_POLICIES
  controller/doctors.controller.ts      DoctorsController (@injectable, arrow-function methods)
  routes.ts                             buildDoctorsRouter()
src/app/specialties/repository/specialties.repo.ts   + findSpecialtiesByIds(ids, conn)            (new function)
src/app/specialties/service/specialties.service.ts   + findByIds(ids, conn?)                       (new method, §3.9)
src/lib/validation/timezone-decorator.ts             IsIanaTimezone() (luxon IANAZone.isValidZone; domain-free → lib)
src/lib/validation/array-decorators.ts               ArrayUniqueValues() only if class-validator's ArrayUnique is not enough (see §3.5)
src/lib/config/env.ts (+ types.ts)                   ALLOWED_CURRENCIES (§3.11)
src/lib/logger/redact.ts                             + "headline", "bio", "reviewNote" (+ a row in the redaction unit test)
src/lib/knex/pg-errors.ts                            reuse uniqueViolationConstraint (specialties); no new helper
src/lib/di/tokens.ts, src/bootstrap.ts               DoctorsService, DoctorsController
src/routes.ts                                        mounts buildDoctorsRouter()
src/migrations/<ts>_create_doctor_profiles.ts, <ts>_create_doctor_languages.ts, <ts>_create_doctor_specialties.ts
tests/…                                              §9
```
Every type alias and interface lives in `types.ts` (ESLint enforces it). `.env.example` gains `ALLOWED_CURRENCIES`.

### 3.4 Entity (`entity/doctor-profile.entity.ts`)
Plain class, `constructor(data: Partial<DoctorProfile>)`, camelCase mirror of the row (`userId`, `consultationFeeAmount`,
`currency`, `verificationStatus`, `reviewedBy`, `suspendedAt`, `deletedAt`, …). `languages` and specialty links are
**not** on the entity; they travel in `DoctorProfileView = { profile: DoctorProfile; languages: string[]; specialties: SpecialtyRef[] }`.

### 3.5 Request DTOs (`dto/doctors.request.dto.ts`)
Validated with `lib/validation` (`whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues`, no implicit conversion).
Bodies are JSON, so integers are real numbers (strings → 400); no `ToInt`/`ToBoolean` is needed (no query or path field).
Rejected values are never echoed.
```ts
export class MoneyDto {
    @IsInt() @Min(0) @Max(FEE_AMOUNT_MAX)  amount!: number;            // Max: INT column (contract change C3)
    @IsString() @Matches(/^[A-Z]{3}$/)      currency!: string;          // allowlist is checked by the service (needs env)
}

export class DoctorApplyDto {
    @IsString() @CodePointLength(5, 160) @NoControlCharacters("all")        headline!: string;
    @ValidateIf((_o, v) => v !== undefined)
    @IsString() @CodePointLength(0, 4000) @NoControlCharacters("nul")       bio?: string;        // contract: type string (null → 400)
    @IsInt() @Min(0) @Max(70)                                               yearsExperience!: number;
    @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @ArrayUnique() @Matches(/^[a-z]{2}$/, { each: true })  languages!: string[];
    @IsArray() @ArrayMinSize(1) @ArrayMaxSize(5) @ArrayUnique() @IsInt({ each: true }) @Min(1, { each: true })  specialtyIds!: number[];
    @IsInt() @Min(1)                                                        primarySpecialtyId!: number;
    @ValidateNested() @Type(() => MoneyDto)                                 consultationFee!: MoneyDto;
    @IsInt() @Min(5) @Max(240)                                              defaultSlotMinutes!: number;
    @IsString() @MaxLength(64) @IsIanaTimezone()                            timezone!: string;
    @IsBoolean()                                                            submit!: boolean;    // required by the contract
}

export class DoctorProfileUpdateDto {                      // every member optional; absent = unchanged
    headline?, bio? (string | null; null clears), yearsExperience?, languages?, specialtyIds?, primarySpecialtyId?,
    consultationFee?, defaultSlotMinutes?, timezone?, isAcceptingPatients? (IsBoolean — JSON boolean only)
    isEmpty(): boolean;        // true when every member is undefined (never Object.keys) — minProperties: 1
    toChanges(): DoctorProfileChanges;     // only members !== undefined
}
```
- `@ValidateIf((_o, v) => v !== undefined)` on optional update members so `null` fails everywhere except `bio`
  (`@IsOptional()` there, contract `[string, 'null']`).
- `ArrayUnique` on `specialtyIds`/`languages` implements contract `uniqueItems: true` (duplicates → 400, not a silent dedupe).
- `languages` entries are matched case-sensitively: `AR` → 400 (`^[a-z]{2}$`). The service never lower-cases.
- `primarySpecialtyId ∈ specialtyIds` (apply) and the PATCH combinations (D11) are cross-field rules: checked by the
  service with module errors that carry `details[].field`, not by a DTO decorator.
- `timezone`: `IsIanaTimezone()` is a domain-free decorator in `lib/validation` (message "must be a valid IANA timezone").
  The service stores the canonical spelling (O1, resolved).
- Nested `MoneyDto` unknown members (e.g. `consultationFee.extra`) → 400 via `forbidNonWhitelisted`; the error's `field` is
  the dotted path (`consultationFee.amount`).
- No trimming or lower-casing of any value, except `timezone`, which is stored in canonical IANA spelling (O1).

### 3.6 Response DTOs (`dto/doctors.response.dto.ts`)
```ts
export class DoctorProfileOwnResponseDto {
    /** Explicit field-by-field copy; dates via toISOString(); suspendedAt null when not suspended. */
    static from(view: DoctorProfileView): DoctorProfileOwnResponseDto;
}
export class VerificationApplicationResponseDto {
    static from(view: DoctorProfileView): VerificationApplicationResponseDto;   // D8: degraded `doctor`, `documents: []`
}
```
No row, entity, or `deleted_at` ever reaches the wire. No `viewer` parameter: only the owner reaches these routes.
A unit test asserts the produced keys equal the contract's `DoctorProfileOwn.required` (+ `reviewNote`) and
`VerificationApplication.required`.

### 3.7 Repository
```ts
export const DOCTOR_PROFILE_COLUMNS = [ "id","user_id","headline","bio","years_experience","consultation_fee","currency",
  "default_slot_minutes","timezone","is_accepting_patients","verification_status","submitted_at","reviewed_by","review_note",
  "decided_at","identity_sync_status","suspended_at","created_at","updated_at" ] as const;   // never SELECT *; deleted_at not selected
```
| Function | SQL (explicit columns; `deleted_at IS NULL` on every read — `whereNull('deleted_at')`) |
|---|---|
| `findProfileByUserId(userId, conn = db)` | `SELECT <cols> FROM doctor_profiles WHERE user_id = ? AND deleted_at IS NULL` (`uq_doctor_profiles_user_id`) |
| `findProfileByUserIdForUpdate(userId, trx)` | same `… FOR UPDATE` — serializes concurrent edits of one profile |
| `insertProfile(input, trx)` | `INSERT INTO doctor_profiles (user_id, headline, bio, years_experience, consultation_fee, currency, default_slot_minutes, timezone, is_accepting_patients, verification_status, identity_sync_status) VALUES (…, true?, 'draft', 'not_required') RETURNING <cols>` — see O2 for `is_accepting_patients` |
| `updateProfile(id, changes, trx)` | `UPDATE doctor_profiles SET <changed columns>, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL RETURNING <cols>` |
| `isUserLocallySuspended(userId, conn = db)` | `SELECT 1 FROM doctor_profiles WHERE user_id = ? AND suspended_at IS NOT NULL AND deleted_at IS NULL LIMIT 1` |
| `listLanguages(profileId, conn)` | `SELECT language_code FROM doctor_languages WHERE doctor_profile_id = ? ORDER BY language_code` |
| `insertLanguages(profileId, codes, trx)` | `INSERT … VALUES (?, ?), … ON CONFLICT (doctor_profile_id, language_code) DO NOTHING` |
| `deleteLanguagesNotIn(profileId, codes, trx)` | `DELETE FROM doctor_languages WHERE doctor_profile_id = ? AND language_code <> ALL(?::text[])` |
| `listSpecialtyLinks(profileId, conn)` | `SELECT specialty_id, is_primary FROM doctor_specialties WHERE doctor_profile_id = ?` |
| `deleteLinksNotIn(profileId, ids, trx)` | `DELETE … WHERE doctor_profile_id = ? AND specialty_id <> ALL(?::bigint[])` |
| `clearPrimaryExcept(profileId, primaryId, trx)` | `UPDATE doctor_specialties SET is_primary = false WHERE doctor_profile_id = ? AND is_primary AND specialty_id <> ?` |
| `insertLinks(profileId, links, trx)` | `INSERT … (doctor_profile_id, specialty_id, is_primary) VALUES … ON CONFLICT (doctor_profile_id, specialty_id) DO NOTHING` |
| `markPrimary(profileId, primaryId, trx)` | `UPDATE doctor_specialties SET is_primary = true WHERE doctor_profile_id = ? AND specialty_id = ? AND NOT is_primary` |

Language codes come back from `CHAR(2)`; `toEntity` trims nothing (2 chars, no padding). Write functions take a
`Knex.Transaction`. Specialty names for the response come from `SpecialtiesService.findByIds`, not from a join.

### 3.8 Controller (`controller/doctors.controller.ts`)
```ts
@injectable()
export class DoctorsController {
    constructor(@inject(TOKENS.DoctorsService) private readonly service: DoctorsService) {}
    apply = async (req, res) => {
        const dto = await validateBody(DoctorApplyDto, req.body);
        const result = await this.service.apply(requireAuth(req), dto.toInput());
        sendSuccess(res, DoctorProfileOwnResponseDto.from(result.view), { status: result.created ? 201 : 200 });
    };
    getMe = async (req, res) => sendSuccess(res, DoctorProfileOwnResponseDto.from(await this.service.getOwn(requireAuth(req))));
    updateMe = async (req, res) => {
        const dto = await validateBody(DoctorProfileUpdateDto, req.body);
        if (dto.isEmpty()) throw EmptyDoctorProfileUpdate;       // contract minProperties: 1
        sendSuccess(res, DoctorProfileOwnResponseDto.from(await this.service.update(requireAuth(req), dto.toChanges())));
    };
    getApplication = async (req, res) => sendSuccess(res, VerificationApplicationResponseDto.from(await this.service.getOwn(requireAuth(req))));
}
```
Validation and mapping only. `PATCH` order: guard → `authorize` (role, status, `doctor_not_suspended`) → body `400` →
service (`404` when no profile).

### 3.9 Service (`service/doctors.service.ts`)
```ts
@injectable()
export class DoctorsService {
    constructor(
        @inject(TOKENS.Db) private readonly db: Knex,
        @inject(TOKENS.AuditRecorder) private readonly audit: AuditRecorder,
        @inject(TOKENS.Env) private readonly env: Env,
        @inject(TOKENS.SpecialtiesService) private readonly specialties: SpecialtiesService,
    ) {}
    apply(actor: AuthContext, input: DoctorProfileInput): Promise<ApplyResult>;   // { view, created }
    getOwn(actor: AuthContext): Promise<DoctorProfileView>;                       // NotFound when no profile
    update(actor: AuthContext, changes: DoctorProfileChanges): Promise<DoctorProfileView>;
    isLocallySuspended(userId: number): Promise<boolean>;                         // backs doctor_not_suspended
    // private: assertCurrencyAllowed, resolveSpecialties, diff, replaceLanguages, replaceSpecialties, loadView
}
```
**`getOwn`** (no transaction): `findProfileByUserId` → `NotFound` if absent → `listLanguages` ∥ `listSpecialtyLinks` →
`specialties.findByIds(linkIds)` → view. Fixed 4 queries.

**`apply`** — validate, then one transaction (Knex handler form), conflict mapped outside it:
1. `assertCurrencyAllowed(input.consultationFee.currency)` (`400 consultationFee.currency`); `primarySpecialtyId ∈
   specialtyIds` else `400 primarySpecialtyId` (`PrimarySpecialtyNotLinked`).
2. Transaction: `findProfileByUserIdForUpdate(actor.userId)`.
   - **Absent:** if `input.submit` → `SubmitRequiresDocuments` (nothing written). Else `resolveSpecialties(ids, [])` (every
     id must exist **and** be active, else `UnknownSpecialty` `400 specialtyIds`) → `insertProfile` → `insertLanguages` →
     `insertLinks` (primary flagged) → `audit.record(trx, { actor, action: ProfileCreated, entityType: "doctor_profile",
     entityId, metadata: {} })` → build the view from the same `trx` → `created = true`.
   - **Present, `verification_status ∈ {submitted, approved}`:** `ApplicationNotEditable` (`409 Conflict`).
   - **Present, `draft` or `rejected`:** if `input.submit` → `SubmitRequiresDocuments` (D1: the live-document count is 0 in this
     slice; the check is `liveDocumentCount(profileId) >= 1 license && >= 1 id`, and `verification` replaces the stub
     with its service). Else `resolveSpecialties(ids, currentLinkIds)` (only **newly linked** ids must be active, D5);
     `diff(current, input)`; no change → return the current view (`200`, no write, no audit); change → `updateProfile`
     (+ child replacement) → audit `ProfileUpdated` with `{ changedFields }` → view; status stays as it was (a `rejected`
     profile stays `rejected`).
3. **Concurrent first apply:** a `23505` whose `error.constraint === "uq_doctor_profiles_user_id"` thrown by the insert is
   caught **outside** the transaction (`uniqueViolationConstraint`), and the whole `apply` is re-run **once** — it now finds
   the winner's row and takes the update path (`200`). Any other error, or a second `23505`, propagates.
- `apply` is a full replace of the profile fields: an absent `bio` sets `bio = NULL` (D2).
- No call to Identity, storage, or video; nothing happens after the transaction.

**`update`** — one transaction:
1. `findProfileByUserIdForUpdate` → `NotFound` if absent. (Status `submitted`/`approved` is allowed — D4. Local suspension was already
   denied by the policy check; the service does **not** re-check it inside the transaction, see §4 D-R9.)
2. `assertCurrencyAllowed` if `consultationFee` given. Specialties (D11): `specialtyIds` given → effective set = `specialtyIds`,
   effective primary = `primarySpecialtyId` if given, else the current primary **if it is in the new set**, else
   `PrimarySpecialtyRequired` (`400 primarySpecialtyId`); `primarySpecialtyId` given **without** `specialtyIds` → must be one
   of the current links else `PrimarySpecialtyNotLinked`; given with `specialtyIds` → must be in it. Only newly linked ids
   must be active (D5).
3. `diff` over provided members only; nothing changed → return the current view, no write, no audit (D10).
4. `updateProfile` (only the changed columns, `updated_at` bumped even when only child rows changed), then the child replacement,
   then `audit.record(trx, { action: ProfileUpdated, metadata: { changedFields: "<sorted API names joined by ','>" } })`.
5. The view is built from the same `trx` after the writes.
- Cache invalidation of slot/next-available caches on `timezone`/`isAcceptingPatients` change is a **no-op here** (no cache
  exists); the `availability` module hooks the invalidation.

**`diff`** — a field changed only when provided (`!== undefined`) **and** different: scalars by `===`; `consultationFee` by
`(amount, currency)`; `languages` and `specialtyIds` as sets (order never counts); the primary by id. Names are the wire
names of `DoctorProfileField`, sorted alphabetically; audit `changedFields` ≤ 500 characters by construction.

**`replaceLanguages(profileId, desired, trx)`:** `deleteLanguagesNotIn` then `insertLanguages` (idempotent, `ON CONFLICT DO NOTHING`).

**`replaceSpecialties(profileId, ids, primaryId, trx)`** in this order (never two primaries, never a window with none):
`deleteLinksNotIn(ids)` → `clearPrimaryExcept(primaryId)` → `insertLinks(new ids, is_primary = id === primaryId)` →
`markPrimary(primaryId)`.

**`resolveSpecialties(requested, alreadyLinked)`:** `specialties.findByIds(requested, trx)` returns existing rows; every requested id must
be present, and every id **not** in `alreadyLinked` must have `isActive`; otherwise `UnknownSpecialty`. One query (`= ANY`), no N+1.

**`SpecialtiesService.findByIds(ids: number[], conn: Knex = this.db): Promise<Specialty[]>`** — new, backed by a new repository
function `findSpecialtiesByIds(ids, conn)` (`SELECT <SPECIALTY_COLUMNS> FROM specialties WHERE id = ANY(?) ORDER BY name, id`).
It returns inactive rows too (the caller decides). Unit-tested in the specialties suite.

### 3.10 Policies and the suspension check
```ts
// checks.ts
export function doctorNotSuspendedCheck(service: Pick<DoctorsService, "isLocallySuspended">): AccessCheck {
    return { name: "doctor_not_suspended", appliesTo: ["doctor"],
             run: async ({ auth }) => (await service.isLocallySuspended(auth.userId)) ? "deny-forbidden" : "allow" };
}
// policies.ts
const ONBOARDING = { statuses: { doctor: ["pending", "active", "rejected"] } } as const;
export function buildDoctorsPolicies(service): DoctorsPolicies => ({
    apply:          { kind: "user", roles: ["doctor"], owner: { kind: "self" }, accountState: ONBOARDING },
    getMe:          { kind: "user", roles: ["doctor"], owner: { kind: "self" }, accountState: ONBOARDING },
    updateMe:       { kind: "user", roles: ["doctor"], owner: { kind: "self" }, accountState: ONBOARDING, checks: [doctorNotSuspendedCheck(service)] },
    getApplication: { kind: "user", roles: ["doctor"], owner: { kind: "self" }, accountState: ONBOARDING },
});
```
- Matches `x-roles: [doctor]`, `x-ownership: self`, `x-account-state` of the four operations. `suspended` is never admitted.
- The check reads the database by `auth.userId` only (never `req.body`); a doctor with no profile is not suspended.
- Only `PATCH /me` carries the check (contract). `GET /me`, `GET /me/application` stay readable for a locally suspended doctor so the
  state can be seen; `apply` on a suspended doctor is already `409` (a suspended profile is `approved`).
- The check factory is exported for the practising-doctor policies of later modules (schedules, sessions, records); the
  policies are built where the container is resolved (`routes.ts`), as the specialties policies are.

### 3.11 Env and DI
- `ALLOWED_CURRENCIES` (zod, `lib/config/env.ts`): comma-separated ISO-4217 codes, each `^[A-Z]{3}$`, at least one, no duplicates;
  parsed to `readonly string[]` on `Env`. **Documented default `EGP`** (not a secret). Invalid value → boot fails with the zod issue.
- Tokens `DoctorsService`, `DoctorsController` (`Symbol.for`) in `lib/di/tokens.ts`; `registerSingleton` in `src/bootstrap.ts`; every
  constructor parameter uses `@inject(TOKENS.X)` (ADR 0016).

---

## 4. Business rules

| # | Rule (testable) | Enforced by |
|---|---|---|
| D-R1 | One live profile per Identity user; `POST /apply` with an existing live profile never creates a second | `uq_doctor_profiles_user_id` + `FOR UPDATE` |
| D-R2 | First `apply` → `201` with `verificationStatus='draft'`, `identitySyncStatus='not_required'`, `isSuspended=false`, `isBookable=false` | service + `insertProfile` |
| D-R3 | `apply` on `draft`/`rejected` → `200` full replace (absent `bio` → `null`); a `rejected` profile stays `rejected` | service |
| D-R4 | `apply` on `submitted` or `approved` → `409 Conflict`, nothing written | service |
| D-R5 | `submit=true` requires ≥ 1 live `license` and ≥ 1 live `id` document, else `400 ValidationFailed` with `details[].field="documents"`; in this slice no document exists, so it always fails and **creates nothing** | service (stub replaced by `verification`) |
| D-R6 | 1–5 unique specialties, exactly one primary, `primarySpecialtyId ∈ specialtyIds`; every **newly linked** specialty exists and is active (existing links to a later-deactivated specialty are kept, D5); unknown/inactive → `400 specialtyIds` | DTO + service; `uq_doctor_specialties_primary` (≤ 1) |
| D-R7 | 1–10 unique lowercase two-letter language codes; the stored set equals the request set exactly (arrays replace) | DTO + `uq_doctor_languages_…` + `replaceLanguages` |
| D-R8 | `timezone` is a valid IANA zone (luxon), ≤ 64 chars; `defaultSlotMinutes` 5–240; `yearsExperience` 0–70; `headline` 5–160 and `bio` ≤ 4000 code points with no control characters (NUL only in `bio`) | DTO + `chk_doctor_profiles_*` |
| D-R9 | A locally suspended doctor (`suspended_at IS NOT NULL`) gets `403 Forbidden` on `PATCH /me` even with a still-`active` token; a doctor whose token is `suspended` is `403` on every route | `doctor_not_suspended` check, `authorize` status step |
| D-R10 | `consultationFee.amount` is an integer in `[0, 2147483647]`; `currency` is in `ALLOWED_CURRENCIES` else `400` with `details[].field="consultationFee.currency"` | DTO + service + `chk_doctor_profiles_fee/currency` |
| D-R11 | `PATCH /me`: only provided members change; `{}` → `400 body: must contain at least one property`; `null` is accepted only for `bio`; `isAcceptingPatients=false` never cancels consultations | DTO + controller + service |
| D-R12 | `isBookable` = `verification_status='approved' ∧ identity_sync_status='synced' ∧ suspended_at IS NULL ∧ is_accepting_patients ∧ has an active consultation type` (Domain rule 6). The consultation-type term is `false` until `schedules` exists, and no profile can be `approved` yet, so it is always `false` in this slice; the function is pure and unit-tested over its truth table | service (pure function) |
| D-R13 | A create writes exactly one `doctor.profile_created` audit row; a real change (`apply` 200 or `PATCH`) writes exactly one `doctor.profile_updated` row with `changedFields` = sorted wire names; a no-op writes none; `metadata` never holds a value | service + `AuditRecorder`, same transaction |
| D-R14 | A rolled-back write (any error, audit failure) leaves neither profile, child rows, nor audit row | one transaction (Knex handler form) |
| D-R15 | Two concurrent first `apply` calls by one user → one row, no `500`: one `201` and one `200` (the loser's body applied over the winner's draft) | `uq_doctor_profiles_user_id` + one re-run |
| D-R16 | The caller never reads or writes another doctor's profile; ownership is `auth.userId`; a `userId` (or any unknown) body member → `400` | token + `forbidNonWhitelisted` |
| D-R17 | Other roles are denied: patient and admin → `403` on all four routes; no token → `401` | `authorize` |
| D-R18 | `apply` and `PATCH` limited to 20/min per user, `GET`s to 120/min per user → `429 RateLimited` + `Retry-After` | `rateLimit` (D7) |
| D-R19 | `POST /apply` with an `Idempotency-Key`: same key + same body → the original response replayed (one row, one audit row); same key + different body → `422 IdempotencyConflict`; same key in flight → `409` + `Retry-After: 1` | `idempotency({ required: false })` |
| D-R20 | There is no hard delete: `vcare_app` has no `DELETE` on `doctor_profiles` (42501); soft-deleted profiles are invisible to every read | grants + `deleted_at IS NULL` |
| D-R21 | `GET /me` and `GET /me/application` → `404 NotFound` until a profile exists | service |

### Decisions (adopted from the brainstorm and its defaults)
| # | Decision |
|---|---|
| D1 | `submit` is contract-exact and dormant: `submit=true` → `400 documents` until `verification` lands; `202`/Case 1 is never emitted here. No contract change |
| D2 | `apply` is a full replace of the profile fields (PUT-like upsert); `PATCH /me` is the partial path |
| D3 | `apply` on `rejected` updates but does not resubmit; resubmission and its Case 1 Identity call belong to `verification` |
| D4 | `PATCH /me` is allowed while `submitted`/`approved` (the contract blocks only local suspension) — see Open question O4 |
| D5 | Existing links to a specialty later deactivated are kept; only newly linked specialties must be active |
| D6 | Fee currency allowlist = env `ALLOWED_CURRENCIES` (default `EGP`), user decision; the DB check stays `^[A-Z]{3}$` |
| D7 | Rate limits (constants, not env): `apply` + `PATCH /me` 20/min per user; `GET /me` + `GET /me/application` 120/min per user |
| D8 | `GET /me/application` is a projection of the same row, `documents: []`, `doctor` in the degraded Case 2 shape (no Identity call) |
| D9 | Child sets are replaced by diff (delete missing, insert new) under the profile row lock, not delete-all/re-insert, so retained links keep their `created_at` and the partial-unique ordering is explicit |
| D10 | A no-op `apply`/`PATCH` answers `200` with the current state and writes neither rows nor audit |
| D11 | PATCH specialty rules: `specialtyIds` without `primarySpecialtyId` keeps the current primary if still present, else `400 primarySpecialtyId`; `primarySpecialtyId` alone must be one of the current links |

---

## 5. Cross-service behavior

**None in this slice.** No call to Identity (Cases 1–4 do not apply yet), no worker, storage, video, or email. The only
Identity-related step is `userGuard`'s local token verification. Deferred, by module:
- **Case 1** (`verification`): the `submit=true` path with documents, the `rejected → submitted` resubmission and its Identity `pending` call,
  admin approve/reject/reopen, the `202 identitySync: "pending"` answer.
- **Cases 3 and 4** (suspension module): `suspended_at` writers, `identity_sync_jobs`. Needs `lib/identity-client` and, for Case 4, Identity's
  internal status route to allow `suspended → active` (provider first; today it refuses it — Identity contract, internal status route).
- **Case 2** (`availability`/search): hydrated `displayName`/`avatarUrl` for public views and, per O3, for the own application view.

---

## 6. Error codes

No new code; all are in the contract `ErrorCode` enum.

| Code | HTTP | When (this module) | Emitted by |
|---|---|---|---|
| `ValidationFailed` | 400 | invalid body (D-R5–D-R11: lengths in code points, control characters, unknown members incl. `userId`, `null` where not allowed, duplicates, non-IANA timezone, currency outside the allowlist `details[].field="consultationFee.currency"`, unknown/inactive `specialtyIds`, `primarySpecialtyId` not in the set `details[].field="primarySpecialtyId"`, `submit=true` without documents `details[].field="documents"`); empty `PATCH` body; `Idempotency-Key` not a UUID | `lib/validation`, controller, service, `idempotency` |
| `Unauthorized` / `TokenExpired` | 401 | missing/invalid/expired bearer token | `userGuard` |
| `Forbidden` | 403 | role is not `doctor`; token status `suspended` or not in `{pending, active, rejected}`; `PATCH /me` while locally suspended (`check:doctor_not_suspended`) | `authorize` |
| `NotFound` | 404 | `GET /me`, `PATCH /me`, `GET /me/application` before `apply` | service |
| `Conflict` | 409 | `apply` on a `submitted`/`approved` profile; `Idempotency-Key` whose first request is in flight (`Retry-After: 1`) | service, `idempotency` |
| `IdempotencyConflict` | 422 | same `Idempotency-Key`, different body (`apply`) | `idempotency` |
| `RateLimited` | 429 | a limiter tripped (`Retry-After` ≥ 1) | `rateLimit` |
| `InternalError` | 500 | unhandled, including a failed audit insert (the write rolls back) | `errorHandler` |

Module constants (`errors.ts`), details never echo values:
```ts
export const ApplicationNotEditable = new AppError("Conflict", 409, "The application is under review or approved and cannot be replaced",
    [{ field: "verificationStatus", issue: "does not allow apply" }]);
export const SubmitRequiresDocuments = ValidationFailed.withDetails([{ field: "documents", issue: "a license and an id document are required to submit" }]);
export const UnknownSpecialty = ValidationFailed.withDetails([{ field: "specialtyIds", issue: "contains an unknown or inactive specialty" }]);
export const PrimarySpecialtyNotLinked = ValidationFailed.withDetails([{ field: "primarySpecialtyId", issue: "must be one of specialtyIds" }]);
export const PrimarySpecialtyRequired = ValidationFailed.withDetails([{ field: "primarySpecialtyId", issue: "is required when the current primary specialty is removed" }]);
export const CurrencyNotAllowed = ValidationFailed.withDetails([{ field: "consultationFee.currency", issue: "is not an allowed currency" }]);
export const EmptyDoctorProfileUpdate = ValidationFailed.withDetails([{ field: "body", issue: "must contain at least one property" }]);
```

---

## 7. Security & privacy

- **RBAC summary:** doctor only, token `pending`/`active`/`rejected`, ownership `self` on all four routes; `PATCH` adds the local-suspension check;
  patient, admin → `403`; deny-by-default via `authorize`; the boot assertion proves every route is `guard → authorize`. `X-User-Id`,
  `X-Role` are ignored; no body member influences authorization.
- **Audit events:** `doctor.profile_created` (metadata `{}`), `doctor.profile_updated` (metadata `{ changedFields }`), entity type
  `doctor_profile`, entity id = the profile id, actor = the doctor (`actorFromAuth`), `request_id` = the request's id. No audit class
  (`x-audit` absent: neither clinical nor admin action). No-ops and reads write none (not clinical reads).
- **Never logged:** `Authorization`, tokens, request bodies, `headline`, `bio`, `reviewNote` (redacted by key, added now), audit metadata
  values, rate-limit subjects. The request logger never logs bodies. Audit `metadata` holds field names only.
- **Database privileges:** `vcare_app` — `SELECT, INSERT, UPDATE` + sequence `USAGE` on `doctor_profiles` (no `DELETE`/`TRUNCATE`);
  `SELECT, INSERT, DELETE` on `doctor_languages`; `SELECT, INSERT, UPDATE, DELETE` on `doctor_specialties` (link rows, not soft-delete entities).
- **Rate limits:** D7, Redis sliding window with the per-instance fallback.
- **Files:** none (documents → `verification`). **Caching headers:** `no-store` not required.
- **Data:** all fixtures synthetic (`Synthetic Doctor 001`, `SYNTHETIC-HEADLINE-7731`).

---

## 8. Performance

No budget exists for onboarding; the targets below are review ceilings, not platform numbers.

| Path | Queries / round trips | Index | Target (p95, server) |
|---|---|---|---|
| `GET /doctors/me` | 4 reads: profile, languages ∥ links, specialties `= ANY`; 1 Redis `EVAL` (limiter); 0 Identity | `uq_doctor_profiles_user_id`, `uq_doctor_languages_…`, `uq_doctor_specialties_…`, PK | < 100 ms |
| `GET /doctors/me/application` | 3 reads (no languages) + limiter | same | < 100 ms |
| `POST /doctors/apply` (create) | `BEGIN`, `SELECT … FOR UPDATE`, specialties `= ANY`, `INSERT` profile, `INSERT` languages, `INSERT` links, audit `INSERT`, 3 view reads, `COMMIT`; + Redis `SET NX`/`SET` when a key is sent | PK, unique indexes | < 200 ms |
| `PATCH /doctors/me` | 1 check query in `authorize`; then `BEGIN`, `FOR UPDATE`, specialties `= ANY`, `UPDATE`, ≤ 6 child statements, audit, 3 view reads, `COMMIT` (no-op: no writes) | same | < 200 ms |

- No N+1; child statements are set-based (`ANY`, multi-row `VALUES`); at most 10 languages and 5 links per profile.
- `EXPLAIN` of `findProfileByUserId` (index `uq_doctor_profiles_user_id`) is an integration test (§9.2).

---

## 9. Test plan outline

Names follow `should <do something> when <condition>`. Unit tests mock collaborators; integration tests use the real wiring, real
Postgres as `care_app` (owner `ownerDb` only for setup and assertions), real Redis, the fake JWKS helpers. Each suite runs
`truncateAll()` (children before parents; the global setup seeds the 20 starter specialties) and `flushByPrefix(["idem:", "rl:"])`
in `beforeEach`. Tokens: doctor 202 (`pending` / `active` / `rejected` variants), second doctor 204, patient 101, admin 303, suspended
doctor token.

### 9.1 Unit (`tests/unit/`)
- `app/doctors/doctors.request.dto.test.ts`: apply — should accept a valid body · should reject headline 4 and 161 code points, bio 4001 or `null`,
  yearsExperience −1/71/1.5/"5", languages [] / 11 / duplicate / `"AR"` / `"ara"`, specialtyIds [] / 6 / duplicate / 0 / "1", primarySpecialtyId
  missing, fee amount −1 / 2147483648 / 1.5, currency `egp` / `EG`, defaultSlotMinutes 4/241, timezone `Not/AZone` / 65 chars, submit missing or "true",
  members `userId`, `isAcceptingPatients`, `consultationFee.extra`, control characters in headline and NUL in bio (D-R5–D-R10) · should count astral
  characters as one code point · update — should report isEmpty for `{}` and all-undefined · should reject `null` for every member except `bio` · should keep
  `bio: null` in `toChanges` · should omit absent members.
- `app/doctors/doctors.response.dto.test.ts`: should produce exactly the contract `DoctorProfileOwn.required` keys plus `reviewNote` · should produce
  exactly `VerificationApplication.required` keys · should render dates with `toISOString` and `isSuspended` from `suspendedAt` · should never expose `deleted_at`.
- `app/doctors/doctors.service.test.ts`: apply — should insert profile, languages, links and one `doctor.profile_created` audit with `{}` in one
  transaction (D-R2, D-R13) · should return 409 Conflict for submitted and approved without writing (D-R4) · should update a draft and a rejected profile and keep
  the status (D-R3) · should set bio to null when absent (D2) · should return the current view with no write and no audit when nothing changed (D10) · should
  throw SubmitRequiresDocuments for submit=true for a new and an existing profile and write nothing (D-R5) · should re-run once as an update when the insert
  throws 23505 on `uq_doctor_profiles_user_id` (D-R15) · should not re-run on another constraint or a second 23505 · should reject a currency outside the
  allowlist (D-R10) · should throw UnknownSpecialty for a missing id and for an inactive id that is newly linked, but accept an inactive id that is already
  linked (D5, D-R6) · should throw PrimarySpecialtyNotLinked when the primary is not in the set · should reject (so Knex rolls back) when the audit throws (D-R14).
  update — should throw NotFound when no profile · should audit only the changed wire names sorted · should treat the same language set in another order as
  unchanged · should keep the current primary when specialtyIds is given without a primary and it is still present, throw PrimarySpecialtyRequired when it is
  not, and require primarySpecialtyId alone to be a current link (D11) · should order replaceSpecialties as delete, clear-primary, insert, mark-primary.
  getOwn — should throw NotFound · should issue exactly 4 queries. `isBookable` truth table (D-R12). `isLocallySuspended` true/false/absent profile.
- `app/doctors/doctors.policies.test.ts`: should declare roles `[doctor]`, owner self, and statuses pending/active/rejected per `x-roles` / `x-ownership` /
  `x-account-state` read from the contract (`contractOperationBlock`) · should attach `doctor_not_suspended` to `updateMe` only · should build without throwing.
- `app/doctors/doctors.routes.test.ts`: should compose POST as [guard, authorize, rateLimit, idempotency, handler], PATCH as [guard, authorize, rateLimit, handler],
  GETs as [guard, authorize, rateLimit, handler] · should pass `assertRoutesAuthorized` · should register no `router.param`.
- `app/doctors/doctor-not-suspended.check.test.ts`: should allow a doctor with no profile or with `suspended_at` null · should deny-forbidden when suspended.
- `lib/validation/timezone-decorator.test.ts`: should accept `Africa/Cairo`, `UTC` · should reject `Foo/Bar`, empty, 65+ chars, non-strings.
- `lib/config/env.test.ts`: should parse `ALLOWED_CURRENCIES` "EGP,USD" to ["EGP","USD"] · should default to ["EGP"] · should reject `egp`, `EGPP`, empty, duplicates.
- `lib/logger/redact.test.ts`: rows for `headline`, `bio`, `reviewNote`.
- `app/specialties/specialties.service.test.ts` (+): `findByIds` should return rows for existing ids including inactive and nothing for unknown.

### 9.2 Integration — `tests/integration/doctors.test.ts` (real `src/routes.ts`)
**RBAC per route** (CLAUDE.md → Testing policy):

| Route | none | patient | admin | doctor pending / active / rejected | doctor locally suspended (token still active) | doctor token `suspended` |
|---|---|---|---|---|---|---|
| `POST /api/doctors/apply` | 401 | 403 | 403 | 201/200 | 409 (profile is approved) | 403 |
| `GET /api/doctors/me` | 401 | 403 | 403 | 200 (404 before apply) | 200 | 403 |
| `PATCH /api/doctors/me` | 401 | 403 | 403 | 200 (404 before apply) | **403** (`check:doctor_not_suspended`) | 403 |
| `GET /api/doctors/me/application` | 401 | 403 | 403 | 200 (404 before apply) | 200 | 403 |

Plus: expired token → `401 TokenExpired` · patient token with `X-Role: doctor` / `X-User-Id: 202` → still 403 · **non-owner:** doctor 204 never sees
doctor 202's data, and a body `userId: 202` from 204 → 400 · wrong-role check happens before body validation.
**Apply:** should return 201 with the contract `DoctorProfileOwn` (draft, not_required, `isBookable:false`, specialties primary-first) and write one profile,
N language rows, M link rows, one audit row (actor 202, role doctor, `doctor.profile_created`, entity `doctor_profile`, request id echoed, metadata `{}`) ·
should return 200 and one `doctor.profile_updated` row with sorted `changedFields` on a real change, and 200 with no audit row on an identical body ·
should update a `rejected` profile and leave it `rejected` · should return 409 after the owner sets `verification_status='submitted'` / `'approved'` (owner SQL) ·
should return 400 `documents` for `submit=true` for a new doctor and create no row (D-R5) · should return 400 for unknown/inactive/duplicate specialtyIds, primary not in set,
currency outside the allowlist, bad timezone, control characters, and every invalid body of §9.1 (never 500) · should keep an existing link to a specialty the admin
deactivated while rejecting a new link to it (D5) · **should return 201 and 200 with one row and no 500 for two concurrent first applies by one user** (D-R15) ·
idempotency: same key + same body → same response and one row/one audit row; different body → 422; key not a UUID → 400; same key in flight → 409 (D-R19) ·
**audit failure rolls back:** the owner adds `CHECK (action <> 'doctor.profile_created')` on `audit_logs`, POST → 500, no `doctor_profiles`/child rows; dropped in `finally` (D-R14).
**Get:** 404 before apply, 200 after; languages sorted; `GET /me/application` has `documents: []`, `missingRequirements` both items for draft/rejected, the degraded `doctor`
block, and passes the contract `VerificationApplication` key check.
**Patch:** should change one field and bump `updated_at` · should replace languages and specialties as sets (rows deleted/inserted, retained links keep `created_at`) ·
should move the primary without violating `uq_doctor_specialties_primary` · should clear bio with `null` · `{}` → 400 `body`; `{ "headline": null }`, `{ "isAcceptingPatients": "false" }`,
`{ "verificationStatus": "approved" }` → 400 · no-op → 200, `updated_at` unchanged, no audit row · allowed while `submitted`/`approved` (D4) · turning
`isAcceptingPatients` off leaves existing consultations untouched (no consultations table yet: asserted at the service level) · 403 when the owner sets `suspended_at` + reason.
**Rate limit:** 21st write in a minute → `429 RateLimited` with `Retry-After`; hits stored under `rl:doctors-write-user:202` and `rl:doctors-read-user:202` (D-R18).
**Grants and schema (as `care_app`):** `DELETE FROM doctor_profiles` and `TRUNCATE` → 42501 · `DELETE` on `doctor_languages` and `doctor_specialties` succeeds · owner `INSERT`s violating
each `chk_doctor_profiles_*`, `chk_doctor_languages_code`, a second primary, a duplicate link → the named constraint (23514/23505) · **EXPLAIN:** `findProfileByUserId` uses
`uq_doctor_profiles_user_id` (`enable_seqscan = off`) · soft-deleted profile (owner sets `deleted_at`) → `GET /me` 404 and a fresh `apply` creates a new row (D-R20, D-R1).
**Logs:** captured logs contain no token, no `Authorization`, and neither `SYNTHETIC-HEADLINE-7731` nor `SYNTHETIC-BIO-7731`; every `request_completed.route` is one of the four labels.
**Contract conformance:** each returned status ∈ `contractResponseCodes(path, method)`; error bodies pass `expectErrorEnvelope`; success bodies pass the `DoctorProfileOwn`
key check; `idempotentOperations()` lists `POST /api/doctors/apply`.

### 9.3 Other suites touched
- `migrations.test.ts`: should round-trip the three migrations (`latest`/`rollback`) · should leave the specialties seed `down` safe with `doctor_specialties` present and referencing a seeded row.
- `boot.test.ts`: the real `buildPublicRoutes()` answers `GET /api/doctors/me` without a token with 401.

### 9.4 Mandatory scenarios that apply
Each rule D-R1–D-R21 · RBAC per route (wrong role, owner allowed, non-owner cannot reach another doctor's row; ownership is `self`) · idempotent replay and
conflicting body (`apply`) · pagination: **not applicable** (no list) · logs free of fixtures · every audited write writes its row in the transaction.
Not applicable: concurrent booking, Cases 1–4 (no Identity call), record lock, slot budget, uploads, download URLs, admin-on-clinical (no clinical data; admins are denied on every route here).

### 9.5 Manual QA (`/manual-qa doctors`)
Against a local Identity with real doctor (`pending`, `active`, `rejected`), patient, and admin tokens: the RBAC table, create/replace/no-op/PATCH, `submit=true` → 400 `documents`,
specialty and currency failures, idempotent replay, 429 on the 21st write, and local suspension (owner SQL) → `PATCH` 403. Record no tokens in `manual-qa.md`; script
`scripts/curl-test-doctors.sh`.

---

## 10. Out of scope
- Documents and uploads (`/doctors/me/documents*`, `lib/storage`, `upload_intents`), the application `documents` content, admin approve/reject/reopen, Case 1 → `verification`.
- Suspend and reinstate, `suspended_at` writers, `identity_sync_jobs`, Cases 3 and 4 → the suspension module.
- `GET /doctors`, `GET /doctors/{doctorUserId}`, `/slots`, Case 2 hydration, the search and queue indexes, the `next_available_at` cache and its invalidation → `availability`.
- Working hours, exceptions, consultation types (so `isBookable`'s consultation-type term is a constant `false`) → `schedules`.
- `GET /internal/doctors/{userId}/summary` and the service guard.
- Any Identity call and `lib/identity-client`; avatar or name storage.
- A `DELETE` route, profile photos, ratings.

---

## 11. Open questions

All four were resolved by the user on 2026-10-05; kept here as a decision record.

- **O1 — Timezone canonicalization. RESOLVED (2026-10-05):** accept valid case variants (`africa/cairo`) and **store the canonical IANA spelling** (`Africa/Cairo`), so filters and cache keys never diverge. Validate with
  `IANAZone.isValidZone`, then canonicalize via `Intl.DateTimeFormat(undefined, { timeZone }).resolvedOptions().timeZone` in a shared `lib/validation`/`pkg/utils/time.ts` helper (one home, unit-tested); the service stores the canonical value and responses return it.
- **O2 — Initial `is_accepting_patients`. RESOLVED (2026-10-05):** the INSERT states `true`. Approval, Identity sync, and an active consultation type still gate bookability, so applying alone cannot open bookings.
- **O3 — `doctor` block of `GET /me/application`. RESOLVED (2026-10-05):** keep the contract-required `doctor` block in its degraded form (`displayName: null`, `avatarUrl: null`, `profileHydrated: false`) for this slice; it is contract-valid and honest about the missing Identity hydration.
- **O4 — `PATCH /me` while `submitted`. RESOLVED (2026-10-05):** allowed in this slice (D4) because submission is dormant. The `verification` module must **lock profile edits while `submitted`** (contract + spec change, new state error) **before** submissions become possible; approved doctors keep the normal edit path.

### Contract changes required
Applied in `/develop` step 0 (descriptions, extensions, and one `maximum`; no operation, route, status code, or schema member changes), then the hub sync (`../vcare-hub/scripts/sync-from-spoke.sh`):
- **C1** — `paths./api/doctors/apply.post.x-audit-actions`: `[verification.submitted, identity_sync.synced]` → `[doctor.profile_created, doctor.profile_updated, verification.submitted, identity_sync.synced]`.
- **C2** — document the currency allowlist: in `components.schemas.Money.properties.currency.description`, `DoctorApplyRequest.consultationFee` and `DoctorProfileUpdate.consultationFee` add "must be in the service's configured allowlist (`ALLOWED_CURRENCIES`); another currency is `400 ValidationFailed` with `details[].field = \"consultationFee.currency\"`". The `pattern` stays.
- **C3** — `components.schemas.Money.properties.amount`: add `maximum: 2147483647` (the `INT` column; today `amount: 2147483648` would be a database `22003` → `500`).
- No edit for `submit`: the contract stays exact and the dormant behavior is implementation state, not contract (D1).
- **Deferred to the suspension module (not this slice):** the contract has **no** `PATCH /api/admin/doctors/{doctorUserId}/reinstate` although ADR 0012 decided it, and `suspendDoctor`'s description still says "Reinstatement is out of scope for MVP". That module must add the operation (`ReinstateDoctor` request with `reason`, a `ReinstatementResult`/`202` pending response, `x-audit-actions: [doctor.reinstated, identity_sync.synced]`, `x-integration-case: 4`, `x-failure-policy: retry-report-pending`, errors 400/401/403/404/409 `InvalidTransition`/429/500) and remove that sentence. It also depends on **Identity**: its internal status route must allow `suspended → active` first (today it refuses it; provider first, hub ADR 0009).
- **Platform changes required (/system-design):** none.

---

## 12. Task ordering (CLAUDE.md → Build order for a new module)

`[code]` = implementation (src, migrations, tests); `[docs]` = docs and contract.

| Step | Work | Who |
|---|---|---|
| 0 | Contract C1–C3 + hub sync | [docs] |
| 0a (lib) | `luxon` dependency, `lib/validation/timezone-decorator.ts`, `ALLOWED_CURRENCIES` in `env.ts` + `.env.example`, redaction keys, `findSpecialtiesByIds` + `SpecialtiesService.findByIds`, and their unit tests | [code] |
| 1 | Migrations 1–3 (§2) | [code] |
| 2 | `constants.ts`, `enums.ts`, `errors.ts`, `types.ts` | [code] |
| 3 | Entity | [code] |
| 4 | Request DTOs | [code] |
| 5 | Response DTOs | [code] |
| 6 | Repositories | [code] |
| 7 | Service + DI token/registration | [code] |
| 8 | `checks.ts`, `policies.ts` | [code] |
| 9 | Controller + DI registration | [code] |
| 10 | `routes.ts` | [code] |
| 11 | Mount in `src/routes.ts` | [code] |
| 12 | Tests of §9 | [code] |
| 13 | Manual QA (§9.5) | [docs] |
| 14 | Docs of §13, INDEX, service card | [docs] |

## 13. Required follow-ups (docs; not open)
- `/update-docs doctors`: `architecture/data-model.md` (built-so-far line; the two added checks on `doctor_profiles`, link-table grants) · `architecture/rbac.md` and `architecture/api.md` (rows: rate limits,
  audit actions) · `architecture/infrastructure.md` (`ALLOWED_CURRENCIES`, `luxon` landed) · `access/spec.md` §3.4 note (`doctor_not_suspended` now supplied) ·
  **`docs/service-card.md`** (owned data gains doctor profiles; endpoint family `/api/doctors/{apply,me,me/application}` live; env var) then the hub sync · this spec's as-built notes.
- ADR 0016 needs no new ADR for `luxon` (locked stack); its "land with the module" sentence is satisfied here, earlier than `pkg/slots`.

## 14. As-built notes (2026-10-07)

- The four self-owned routes are mounted on the public listener. `POST /doctors/apply` has an optional idempotency key and a 20/min per-user write limit; the two reads have a 120/min per-user limit. All use `userGuard` and `authorize`. Only `PATCH /doctors/me` runs the local suspension check. The contract's document upload, submission transition, Identity sync, discovery and internal summary remain future module work; `submit=true` currently returns `400 ValidationFailed` on `documents`.
- Migrations `20261005120000` through `20261005120200` create `doctor_profiles`, `doctor_languages` and `doctor_specialties`. The profile migration includes the headline and bio length checks, Identity-id column comments, and the live-user partial unique index. Search and verification queue indexes remain deferred. The app role can update the soft-deleted profile table, and can delete only link rows when replacing a language or specialty set.
- `DOCTOR_PROFILE_COLUMNS` also selects `suspended_by` and `suspension_reason` beyond the list in §3.7. They stay on the entity and do not appear in either response. The timezone validator and `canonicalIanaTimezone` live together in `lib/validation/timezone-decorator.ts`; ICU canonicalization accepts case variants and may preserve aliases. ADR 0019 records the installed `luxon` dependency, superseding §1's statement that no new ADR was needed.
- `GET /me/application` returns the contract's degraded `doctor` fields (`displayName` and `avatarUrl` null, `profileHydrated: false`), an empty `documents` array, and missing license/id requirements while the application is draft or rejected. `isBookable` uses the Domain-rule-6 function with the active-consultation-type term set to false until schedules exist.
- The code review found no findings. The doctors unit/integration tests were green and the 2026-10-07 CURL QA recorded 37 HTTP cases plus one replay-data comparison, all passing (38 checks). No contract correction was needed for this built slice beyond C1–C3 already made in step 0.
