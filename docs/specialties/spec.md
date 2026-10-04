---
title: specialties — Spec
owner: care-team
service: care-service
module: specialties
status: ready
version: 1.0.0
diataxis: reference
last_verified: 2026-10-03
tags: [spec, specialties, catalog, pagination, keyset, validation, rate-limit, idempotency, audit, migration]
related: [specialties-brainstorm, access-spec, foundation-spec, rbac, data-model, api, adr-0017-generic-helpers-and-transaction-scoping, adr-0018-db-role-split-explicit-grants-partition-function]
contracts: [contracts/openapi.yaml]
---

# specialties — Spec

The admin-managed specialty catalog: one table, three routes, one service — the first business module on top of the
`access` base (`userGuard` → `authorize(policy)` → `AuditRecorder.record(trx, …)`, the boot route assertion) and the
first real user of keyset pagination, idempotency, and rate limiting on a mounted route. It also fixes three foundation
latent gaps its routes expose first: [#7](https://github.com/OmarRedaX/vcare-care-api/issues/7) (cursor precision),
[#8](https://github.com/OmarRedaX/vcare-care-api/issues/8) (implicit query conversion), and
[#9](https://github.com/OmarRedaX/vcare-care-api/issues/9) (rate-limit member).

Scope follows [brainstorm.md](./brainstorm.md) exactly, including decisions D1–D4, which this spec does not reopen.
The three items the brainstorm left to the spec are decided in §13.1 (S1–S3). One further decision (S4, doctor
account states on `GET /specialties`) and its contract description edit (C1) are in §13.

Binding rules: CLAUDE.md → "Database rules", "API conventions", "Authentication and service-to-service auth",
"Authorization — RBAC and ownership", "Security rules", "Privacy and logging", "Testing policy", "Build order for a new
module". The access base is specified in [access/spec.md](../access/spec.md) (§3.2 route composition, §3.4 `authorize`,
§3.5 `AuditRecorder`, §15 as-built); the foundation in [foundation/spec.md](../foundation/spec.md) (§13 wins over its
earlier sections).

---

## 1. Overview

### 1.1 What `specialties` owns
| Area | Delivers |
|---|---|
| Table | `specialties` (name, slug, optional description, `is_active`), never deleted; deactivated with `is_active=false` |
| Data | a starter catalog of 20 synthetic specialties in a **separate data migration** (D2) |
| Routes | `GET /api/specialties` (patient, doctor, admin), `POST /api/specialties` (admin), `PATCH /api/specialties/{id}` (admin) |
| Audit | `specialty.created`, `specialty.updated` (class `admin-action`), written in the write's transaction |
| Foundation fixes | #7 full-precision timestamp cursor (D1), #8 strict query/param conversion, #9 server-generated rate-limit member (§12) |
| Generic helpers (new, `lib/`) | `lib/http/pagination` text and timestamp cursor helpers, `lib/validation/transforms.ts` (`ToInt`, `ToBoolean`), `lib/knex/pg-errors.ts` (`uniqueViolationConstraint`), `lib/auth/require-auth.ts` (`requireAuth`) |

### 1.2 Principles
- **The constraint is the guarantee.** Name and slug uniqueness live in `uq_specialties_name` / `uq_specialties_slug`;
  the service maps SQLSTATE `23505` by **constraint name** to `409 Conflict`. There is no "does it exist?" pre-check.
- **Never deleted.** No `DELETE` route, no `DELETE` grant for `vcare_app`, no `deleted_at` column (D4): doctor links will
  reference these rows with `ON DELETE RESTRICT`.
- **Audit in the same transaction.** A write and its audit row commit or roll back together; a `409` leaves no audit row.
- **A no-op is not a write** (S1): a `PATCH` whose values equal the stored ones answers `200` with the current row and
  writes neither the row nor an audit row.
- **Contract-exact validation.** DTO rules equal the contract schemas and the database checks; unknown members are
  rejected; values are never transformed (no trimming, no lower-casing).
- **Position, not grant.** A cursor is a keyset position; every page re-applies the caller's filters.

### 1.3 Dependencies
- **Other modules:** foundation and access only. Later, `doctors` reads `specialties.id`/`slug`/`name` through this
  module's service (never its repository) and owns what an inactive specialty means for existing links and search
  (brainstorm → Out of scope).
- **Other service:** none. No Identity call (the admin comes from the verified token), no worker, no storage.
- **New runtime dependencies:** none.
- **New env variables:** none (rate-limit numbers are constants, §3.10).

---

## 2. Database schema

### 2.1 Migrations (in this order; timestamps assigned by `npm run migrate:make`, both sorting after `20261003120100`)
| # | File (`src/migrations/<ts>_<name>.ts`) | Change |
|---|---|---|
| 1 | `<ts>_create_specialties` | table, constraints, keyset index, comments, grants |
| 2 | `<ts>_seed_specialties_starter_catalog` | 20 synthetic rows, idempotent; `down` removes only those slugs, only when unreferenced |

One change per file (CLAUDE.md → Database rules). Both run as the owner (`MIGRATION_DATABASE_URL`) like every migration.

### 2.2 Migration 1 — `create_specialties`
```sql
-- up
CREATE TABLE specialties (
    id           BIGSERIAL PRIMARY KEY,
    name         VARCHAR(100) NOT NULL,
    slug         VARCHAR(100) NOT NULL,
    description  TEXT,
    is_active    BOOLEAN NOT NULL,                       -- no default: the INSERT states it (CLAUDE.md: no defaults on statuses)
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_specialties_slug UNIQUE (slug),
    CONSTRAINT uq_specialties_name UNIQUE (name),       -- case-sensitive by decision D3
    CONSTRAINT chk_specialties_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    CONSTRAINT chk_specialties_name_length CHECK (char_length(name) >= 2),
    CONSTRAINT chk_specialties_description_length CHECK (description IS NULL OR char_length(description) <= 2000)
);

COMMENT ON TABLE specialties IS 'Admin-managed specialty catalog. Never deleted (vcare_app has no DELETE): deactivated with is_active=false because doctor links reference rows.';

-- GET /api/specialties keyset page:
--   SELECT … FROM specialties [WHERE is_active = true] [AND (name, id) > ($name, $id)] ORDER BY name ASC, id ASC LIMIT $n
-- uq_specialties_slug also serves the future search filter ?specialty=<slug> (SELECT id FROM specialties WHERE slug = $1)
-- and uq_specialties_name the uniqueness check; neither can seek on the (name, id) row comparison.
CREATE INDEX idx_specialties_name_id ON specialties (name, id);

GRANT SELECT, INSERT, UPDATE ON specialties TO vcare_app;      -- no DELETE (never deleted), no TRUNCATE
GRANT USAGE ON SEQUENCE specialties_id_seq TO vcare_app;       -- nextval() for BIGSERIAL (belongs to the INSERT grant)

-- down (no CASCADE: doctor_specialties' own migration is rolled back first)
DROP TABLE IF EXISTS specialties;
```
- Each statement is its own `await knex.raw(...)` (style of `20261002120100_create_audit_logs.ts`). The regex literal
  contains no `?`, so no binding is involved.
- `chk_specialties_name_length` and `chk_specialties_description_length` are additions to the `data-model.md` design
  (brainstorm: "contract = DB checks"); `VARCHAR(100)` already caps name and slug at 100 characters. Docs follow-up §14.
- **No soft-delete column**, so the "`whereNull('deleted_at')` on every read" repository rule does not apply here;
  the repository says so in its header comment.
- `idx_specialties_name_id` is the only secondary index. The table is tiny (tens to hundreds of rows), so the planner
  will normally seq-scan; the integration test proves the index is usable with `enable_seqscan = off` (§9.4).

### 2.3 Migration 2 — `seed_specialties_starter_catalog` (D2, S3)
```ts
const STARTER_SPECIALTIES: ReadonlyArray<readonly [name: string, slug: string, description: string]> = [ /* §2.4 */ ];

export async function up(knex: Knex): Promise<void> {
    // One statement; values are BINDINGS (never interpolated), 3 per row.
    await knex.raw(
        `INSERT INTO specialties (name, slug, description, is_active)
         VALUES ${STARTER_SPECIALTIES.map(() => "(?, ?, ?, true)").join(", ")}
         ON CONFLICT DO NOTHING`,
        STARTER_SPECIALTIES.flat(),
    );
}

export async function down(knex: Knex): Promise<void> {
    const slugs = STARTER_SPECIALTIES.map(([, slug]) => slug);
    const linked = await knex.raw<{ rows: Array<{ exists: boolean }> }>(
        "SELECT to_regclass('public.doctor_specialties') IS NOT NULL AS exists",
    );
    if (linked.rows[0]?.exists === true) {
        await knex.raw(
            `DELETE FROM specialties s
             WHERE s.slug = ANY(?::text[])
               AND NOT EXISTS (SELECT 1 FROM doctor_specialties ds WHERE ds.specialty_id = s.id)`,
            [slugs],
        );
        return;
    }
    await knex.raw("DELETE FROM specialties WHERE slug = ANY(?::text[])", [slugs]);
}
```
- **`ON CONFLICT DO NOTHING` without a target** (refines the brainstorm's `ON CONFLICT (slug)`): it skips a row that
  collides on **either** `uq_specialties_slug` or `uq_specialties_name`, so a re-run after an admin created "Cardiology"
  under another slug cannot fail the release. Idempotent by construction.
- Seeded rows carry **no audit row**: a migration is not an API action and has no actor (brainstorm → In scope 5).
- `down` deletes only the 20 starter slugs, and only those not referenced by a doctor link (once that table exists).
  It runs as the owner, which holds `DELETE`; the app role never does. Production never rolls back a data migration
  (expand/migrate/contract) — `down` exists for dev/test round trips.
- The file header comment states: synthetic catalog data, no personal data (CLAUDE.md → Privacy and logging → "All seed
  and demo data is fully synthetic").

### 2.4 Starter catalog (S3)
| # | name | slug | description |
|---|---|---|---|
| 1 | Allergy and Immunology | `allergy-immunology` | Allergies, asthma, and immune system conditions. |
| 2 | Cardiology | `cardiology` | Heart and blood vessel conditions. |
| 3 | Dermatology | `dermatology` | Skin, hair, and nail conditions. |
| 4 | Endocrinology | `endocrinology` | Hormone and metabolic conditions, including diabetes and thyroid disorders. |
| 5 | Family Medicine | `family-medicine` | Ongoing primary care for patients of all ages. |
| 6 | Gastroenterology | `gastroenterology` | Digestive system and liver conditions. |
| 7 | General Practice | `general-practice` | First-contact care for common health concerns. |
| 8 | Infectious Diseases | `infectious-diseases` | Bacterial, viral, fungal, and parasitic infections. |
| 9 | Internal Medicine | `internal-medicine` | Prevention, diagnosis, and treatment of adult diseases. |
| 10 | Nephrology | `nephrology` | Kidney conditions. |
| 11 | Neurology | `neurology` | Brain, spinal cord, and nerve conditions. |
| 12 | Obstetrics and Gynecology | `obstetrics-gynecology` | Pregnancy care and reproductive health. |
| 13 | Ophthalmology | `ophthalmology` | Eye and vision conditions. |
| 14 | Orthopedics | `orthopedics` | Bone, joint, and muscle conditions. |
| 15 | Otolaryngology | `otolaryngology` | Ear, nose, and throat conditions. |
| 16 | Pediatrics | `pediatrics` | Health care for infants, children, and adolescents. |
| 17 | Psychiatry | `psychiatry` | Mental health conditions. |
| 18 | Pulmonology | `pulmonology` | Lung and breathing conditions. |
| 19 | Rheumatology | `rheumatology` | Joint, muscle, and autoimmune conditions. |
| 20 | Urology | `urology` | Urinary tract and male reproductive conditions. |

Every slug matches `chk_specialties_slug_format`; every name is 2–100 characters; every description is under 2 000
characters and contains no `?` or `'` (bindings are used anyway). All rows `is_active = true`.

---

## 3. API contract and file-level design

### 3.1 Endpoints (mirror `contracts/openapi.yaml`; the contract wins on disagreement)
| | `GET /api/specialties` (`listSpecialties`) | `POST /api/specialties` (`createSpecialty`) | `PATCH /api/specialties/{id}` (`updateSpecialty`) |
|---|---|---|---|
| Guard | `userGuard()` (bearerUser) | `userGuard()` | `userGuard()` |
| **Roles** (`x-roles`) | patient, doctor, admin | admin | admin |
| **Ownership** (`x-ownership`) | **none** — public catalog; role check is sufficient | **none** | **none** |
| Account state | patient `active`; doctor `pending`, `active`, or `rejected` (S4); admin `active` | admin `active` | admin `active` |
| Audit (`x-audit`) | — | `admin-action`: `specialty.created` | `admin-action`: `specialty.updated` (only when something changed, S1) |
| `Idempotency-Key` | n/a (GET) | **optional** (`IdempotencyKeyOptional`) | not declared by the contract → no idempotency middleware; a sent header is ignored |
| Rate limit | 60/min per IP **and** 120/min per user (S2) | none (S2) | none (S2) |
| Request | query `cursor?`, `limit?`, `includeInactive?` | body `SpecialtyCreate` | path `id`, body `SpecialtyUpdate` |
| Success | `200` `{ success, data: Specialty[], meta: PaginationMeta }` | `201` `{ success, data: Specialty }` | `200` `{ success, data: Specialty }` |
| Errors | 400, 401, 403, 429, 500 | 400, 401, 403, 409, 422, 429, 500 | 400, 401, 403, 404, 409, 429, 500 |
| `Cache-Control: no-store` | not required (not clinical, not consultation) | not required | not required |

Every status above is declared by the contract for that operation. `429` on `POST`/`PATCH` stays declared (generic
limiter response) even though no limiter is mounted on them (S2) — no contract change.

**Response shape `Specialty`** (identical for every viewer — no field is clinical, so the DTO is not viewer-aware):
`{ id: number, name: string, slug: string, description: string | null, isActive: boolean, createdAt: ISO-8601 UTC,
updatedAt: ISO-8601 UTC }` — exactly the contract's `required` list, no other member.

### 3.2 Route composition (`src/app/specialties/routes.ts`)
```ts
export function buildSpecialtiesRouter(): Router {
    const router = Router();
    const controller = container.resolve<SpecialtiesController>(TOKENS.SpecialtiesController);
    const p = SPECIALTIES_POLICIES;

    router.get(
        "/specialties",
        rateLimit({ name: "specialties-list-ip", limit: SPECIALTIES_LIST_IP_LIMIT, windowMs: SPECIALTIES_LIST_WINDOW_MS, subject: byIp }),
        userGuard(),
        authorize(p.list),
        rateLimit({ name: "specialties-list-user", limit: SPECIALTIES_LIST_USER_LIMIT, windowMs: SPECIALTIES_LIST_WINDOW_MS, subject: byUser }),
        controller.list,
    );
    router.post("/specialties", userGuard(), authorize(p.create), idempotency({ required: false }), controller.create);
    router.patch("/specialties/:id", userGuard(), authorize(p.update), controller.update);

    return sealRouter(router);
}
```
- Order is access spec §3.2: IP limiter (pre-auth, sheds floods before signature verification) → guard → `authorize` →
  user limiter → idempotency → handler. The boot assertion (`assertRoutesAuthorized`) accepts it: `rateLimit` carries
  `PRE_AUTH_MARKER`.
- Paths are **full** (`/specialties`, `/specialties/:id`) and the router is mounted **without a path** in
  `src/routes.ts`, so route labels are `/api/specialties` and `/api/specialties/:id` (never a trailing `/`):
  ```ts
  export function buildPublicRoutes(): Router {
      const router = Router();
      router.use(buildSpecialtiesRouter());
      return router;
  }
  ```
- **No `router.param`** (it would fail boot: `param_callback_without_policy`); `:id` is parsed in the controller after
  `authorize`.
- The two `rateLimit(...)` handlers are built once per router build (each owns its fallback `MemoryLimiter`).

### 3.3 File list
```
src/app/specialties/
  constants.ts                          SLUG_PATTERN, SPECIALTY_NAME_MIN/MAX_LENGTH (2/100), SPECIALTY_SLUG_MAX_LENGTH (100),
                                        SPECIALTY_DESCRIPTION_MAX_LENGTH (2000), SPECIALTIES_LIST_IP_LIMIT (60),
                                        SPECIALTIES_LIST_USER_LIMIT (120), SPECIALTIES_LIST_WINDOW_MS (60_000),
                                        SPECIALTY_ENTITY_TYPE ("specialty"), SPECIALTY_CONSTRAINTS ({ name: "uq_specialties_name", slug: "uq_specialties_slug" })
  enums.ts                              SpecialtyAuditAction { Created = "specialty.created", Updated = "specialty.updated" }
                                        SpecialtyField { Name = "name", Slug = "slug", Description = "description", IsActive = "isActive" }
  errors.ts                             SpecialtyNameTaken, SpecialtySlugTaken, EmptySpecialtyUpdate (§6)
  types.ts                              SpecialtyRow, ListSpecialtiesParams, SpecialtyCreateInput, SpecialtyChanges,
                                        SpecialtyColumnChanges, SpecialtyDiff, SpecialtiesRoute, SpecialtiesPolicies
  entity/specialties.entity.ts          class Specialty
  dto/specialties.request.dto.ts        ListSpecialtiesQueryDto, CreateSpecialtyDto, UpdateSpecialtyDto
  dto/specialties.response.dto.ts       SpecialtyResponseDto
  repository/specialties.repo.ts        SPECIALTY_COLUMNS, listSpecialtiesQuery, listSpecialties, findSpecialtyByIdForUpdate,
                                        insertSpecialty, updateSpecialty (functions, private toEntity)
  service/specialties.service.ts        SpecialtiesService (@injectable)
  policies.ts                           SPECIALTIES_POLICIES
  controller/specialties.controller.ts  SpecialtiesController (@injectable, arrow-function methods)
  routes.ts                             buildSpecialtiesRouter()
src/routes.ts                           mounts buildSpecialtiesRouter()
src/bootstrap.ts                        registers SpecialtiesService, SpecialtiesController
src/lib/di/tokens.ts                    SpecialtiesService, SpecialtiesController tokens
src/lib/auth/require-auth.ts            requireAuth(req) (new, §3.9)
src/lib/knex/pg-errors.ts               PG_UNIQUE_VIOLATION, uniqueViolationConstraint(error) (new, §3.9)
src/lib/knex/types.ts                   PgErrorLike (new type)
src/lib/http/pagination/cursor.ts       decodeTextCursor, decodeTimestampCursor (#7, §12.1)
src/lib/http/pagination/timestamp-cursor.ts  TIMESTAMP_CURSOR_PG_FORMAT, timestampCursorSelect (#7, new)
src/lib/http/pagination/types.ts        StringCursorPosition (#7)
src/lib/http/pagination/pagination.request.dto.ts  limit uses ToInt() (#8)
src/lib/validation/validate.ts          enableImplicitConversion: false for every source (#8)
src/lib/validation/transforms.ts        ToInt(), ToBoolean() (#8, new)
src/lib/rate-limit/rate-limit.ts        member = `${now}-${randomUUID()}` (#9)
src/migrations/<ts>_create_specialties.ts
src/migrations/<ts>_seed_specialties_starter_catalog.ts
eslint.config.mjs                       two no-restricted-syntax selectors (#8, §12.2)
tests/…                                 §9
```
Constants live in the module's `constants.ts` (precedent: `lib/audit/constants.ts`, `lib/auth/constants.ts`). Every
type alias and interface lives in `types.ts` (ESLint enforces it).

### 3.4 Entity (`entity/specialties.entity.ts`)
```ts
export class Specialty {
    id!: number; name!: string; slug!: string; description!: string | null;
    isActive!: boolean; createdAt!: Date; updatedAt!: Date;
    constructor(data: Partial<Specialty>) { Object.assign(this, data); }
}
```
Plain class, no decorators, no DB knowledge.

### 3.5 Request DTOs (`dto/specialties.request.dto.ts`)
Validated with `lib/validation` (`whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues`; after #8 no implicit
conversion anywhere). Messages are class-validator defaults; rejected values are never echoed.

```ts
export class ListSpecialtiesQueryDto extends PaginationQueryDto {   // cursor?: IsOptional IsString MaxLength(512); limit?: ToInt IsInt Min(1) Max(100) = 20
    @IsOptional()
    @ToBoolean()            // "true" → true, "false" → false; anything else left as is → IsBoolean fails → 400
    @IsBoolean()
    includeInactive?: boolean = false;
}

export class CreateSpecialtyDto {
    @IsString() @Length(SPECIALTY_NAME_MIN_LENGTH, SPECIALTY_NAME_MAX_LENGTH)
    name!: string;

    @IsString() @MaxLength(SPECIALTY_SLUG_MAX_LENGTH) @Matches(SLUG_PATTERN)
    slug!: string;

    @ValidateIf((_object, value) => value !== undefined)   // absent → skipped; null → IsString fails (contract: type string)
    @IsString() @MaxLength(SPECIALTY_DESCRIPTION_MAX_LENGTH)
    description?: string;

    toInput(): SpecialtyCreateInput;   // { name, slug, description: description ?? null }
}

export class UpdateSpecialtyDto {
    @ValidateIf((_object, value) => value !== undefined)   // absent → skipped; null → fails
    @IsString() @Length(SPECIALTY_NAME_MIN_LENGTH, SPECIALTY_NAME_MAX_LENGTH)
    name?: string;

    @ValidateIf((_object, value) => value !== undefined)
    @IsString() @MaxLength(SPECIALTY_SLUG_MAX_LENGTH) @Matches(SLUG_PATTERN)
    slug?: string;

    @IsOptional()                                          // contract: [string, null]; null clears the description
    @IsString() @MaxLength(SPECIALTY_DESCRIPTION_MAX_LENGTH)
    description?: string | null;

    @ValidateIf((_object, value) => value !== undefined)
    @IsBoolean()                                           // JSON boolean only; "false" (string) → 400
    isActive?: boolean;

    /** minProperties: 1 — true when every field is `undefined` (never Object.keys: class fields are defined as undefined). */
    isEmpty(): boolean;
    /** Only the members that are `!== undefined` (description may be null). */
    toChanges(): SpecialtyChanges;
}
```
- `SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/` — identical to the contract and `chk_specialties_slug_format`.
- `SpecialtyCreate` has no `isActive` and no `id`: either member in a create body → `400` `"is not allowed"`. A new
  specialty is always active.
- `@Length`/`@MaxLength` count UTF-16 code units, the database counts characters; a value accepted by the DTO is never
  rejected by the database (≤ 100 units ⇒ ≤ 100 characters). No trimming: `"  x"` is a valid 3-character name
  (contract-exact; accepted trade-off like D3's case sensitivity).
- An empty `PATCH` body `{}` passes class-validator; the controller rejects it with `EmptySpecialtyUpdate` (§3.8).

### 3.6 Response DTO (`dto/specialties.response.dto.ts`)
```ts
export class SpecialtyResponseDto {
    id!: number; name!: string; slug!: string; description!: string | null;
    isActive!: boolean; createdAt!: string; updatedAt!: string;
    static from(entity: Specialty): SpecialtyResponseDto;   // explicit copy; dates via toISOString()
}
```
No `viewer` parameter: the shape is the same for every role (no clinical field). Timestamps on the wire are
millisecond ISO strings with `Z` (contract `date-time`); µs precision matters only for cursors, which this route builds
from `name`.

### 3.7 Repository (`repository/specialties.repo.ts`)
```ts
export const SPECIALTY_COLUMNS = ["id", "name", "slug", "description", "is_active", "created_at", "updated_at"] as const;

/** The keyset page query, exported so the EXPLAIN test inspects exactly what runs. */
export function listSpecialtiesQuery(params: ListSpecialtiesParams, conn: Knex = db): Knex.QueryBuilder;
export async function listSpecialties(params: ListSpecialtiesParams, conn: Knex = db): Promise<Specialty[]>;
export async function findSpecialtyByIdForUpdate(id: number, conn: Knex.Transaction): Promise<Specialty | undefined>;
export async function insertSpecialty(input: SpecialtyCreateInput, conn: Knex.Transaction): Promise<Specialty>;
export async function updateSpecialty(id: number, changes: SpecialtyColumnChanges, conn: Knex.Transaction): Promise<Specialty>;
// private: function toEntity(row: SpecialtyRow): Specialty
```
`ListSpecialtiesParams = { includeInactive: boolean; after: StringCursorPosition | null; fetch: number }` (`fetch` =
`limit + 1`). Write functions take a `Knex.Transaction` (a `FOR UPDATE` outside a transaction is meaningless).

| Function | SQL (explicit columns, never `SELECT *`) |
|---|---|
| `listSpecialtiesQuery` | `SELECT id, name, slug, description, is_active, created_at, updated_at FROM specialties` + `WHERE is_active = true` when `!includeInactive` + `AND (name, id) > (?, ?)` (`whereRaw`, bindings `[after.sortValue, after.id]`) when `after` + `ORDER BY name ASC, id ASC LIMIT ?` (`fetch`) |
| `findSpecialtyByIdForUpdate` | `SELECT <columns> FROM specialties WHERE id = ? FOR UPDATE` (`.forUpdate().first()`) |
| `insertSpecialty` | `INSERT INTO specialties (name, slug, description, is_active) VALUES (?, ?, ?, true) RETURNING <columns>` |
| `updateSpecialty` | `UPDATE specialties SET <changed columns>, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING <columns>` (`conn.fn.now()`) |

- The row comparison `(name, id) > (?, ?)` and `ORDER BY name, id` use the column's (database default) collation, so
  the cursor and the order always agree (D3). Default collations are deterministic, so `(name, id)` is a total order.
- `updated_at` is set by the statement (no trigger); `NOW()`/`CURRENT_TIMESTAMP` is the transaction start time.
- The header comment states that the table has no `deleted_at` (never deleted, D4), so reads carry no `whereNull`.

### 3.8 Controller (`controller/specialties.controller.ts`)
```ts
@injectable()
export class SpecialtiesController {
    constructor(@inject(TOKENS.SpecialtiesService) private readonly service: SpecialtiesService) {}

    list = async (req: Request, res: Response): Promise<void> => {
        const query = await validateQuery(ListSpecialtiesQueryDto, req.query);
        const page = await this.service.list(requireAuth(req), query);
        sendSuccess(res, page.items.map((item) => SpecialtyResponseDto.from(item)), { meta: { ...page.meta } });
    };

    create = async (req: Request, res: Response): Promise<void> => {
        const dto = await validateBody(CreateSpecialtyDto, req.body);
        const created = await this.service.create(requireAuth(req), dto.toInput());
        sendSuccess(res, SpecialtyResponseDto.from(created), { status: 201 });
    };

    update = async (req: Request, res: Response): Promise<void> => {
        const id = parsePositiveId(req.params.id);
        if (id === undefined) throw NotFound;               // contract IdPath: non-numeric ids never match
        const dto = await validateBody(UpdateSpecialtyDto, req.body);
        if (dto.isEmpty()) throw EmptySpecialtyUpdate;      // contract minProperties: 1
        const updated = await this.service.update(requireAuth(req), id, dto.toChanges());
        sendSuccess(res, SpecialtyResponseDto.from(updated));
    };
}
```
- Order on `PATCH`: guard → `authorize` (a patient gets `403` for any id) → id (`404` for `abc`, `0`, `007`, 17 digits,
  unsafe integers — `parsePositiveId`) → body (`400`) → service (`404` for an unknown numeric id, `409`).
- No business logic: parsing and validation only.

### 3.9 Service (`service/specialties.service.ts`) and the new generic helpers
```ts
@injectable()
export class SpecialtiesService {
    constructor(
        @inject(TOKENS.Db) private readonly db: Knex,
        @inject(TOKENS.AuditRecorder) private readonly audit: AuditRecorder,
    ) {}

    list(viewer: AuthContext, query: ListSpecialtiesQueryDto): Promise<Page<Specialty>>;
    create(actor: AuthContext, input: SpecialtyCreateInput): Promise<Specialty>;
    update(actor: AuthContext, id: number, changes: SpecialtyChanges): Promise<Specialty>;
    // private diff(current: Specialty, changes: SpecialtyChanges): SpecialtyDiff   (a Care rule: S1)
    // private toConflict(error: unknown): unknown                                 (constraint name → module error)
}
```

**`list`** (no transaction; one query):
1. `limit = resolveLimit(query.limit)`; `after = query.cursor === undefined ? null : decodeTextCursor(query.cursor, SPECIALTY_NAME_MAX_LENGTH)` (`400` `cursor: is invalid` otherwise).
2. `includeInactive = viewer.role === "admin" && query.includeInactive === true` — honoured **only for admins**,
   silently ignored for other roles (contract text). Junk values were already rejected by the DTO for every role.
3. `rows = await listSpecialties({ includeInactive, after, fetch: limit + 1 }, this.db)`.
4. `return buildPage(rows, limit, (row) => [row.name, row.id])`.

**`create`** — one transaction, Knex handler form (CLAUDE.md → Database rules → Transactions):
```ts
try {
    return await this.db.transaction(async (trx) => {
        const created = await insertSpecialty(input, trx);
        await this.audit.record(trx, {
            actor: actorFromAuth(actor),
            action: SpecialtyAuditAction.Created,
            entityType: SPECIALTY_ENTITY_TYPE,
            entityId: created.id,
            metadata: {},
        });
        return created;
    });
} catch (error) {
    throw this.toConflict(error);
}
```

**`update`** — one transaction:
```ts
try {
    return await this.db.transaction(async (trx) => {
        const current = await findSpecialtyByIdForUpdate(id, trx);
        if (current === undefined) throw NotFound;
        const diff = this.diff(current, changes);
        if (diff.fields.length === 0) return current;            // S1: no UPDATE, no audit row, 200 with the current row
        const updated = await updateSpecialty(id, diff.columns, trx);
        await this.audit.record(trx, {
            actor: actorFromAuth(actor),
            action: SpecialtyAuditAction.Updated,
            entityType: SPECIALTY_ENTITY_TYPE,
            entityId: id,
            metadata: { changedFields: diff.fields.join(",") },
        });
        return updated;
    });
} catch (error) {
    throw this.toConflict(error);
}
```
- **`diff`**: a field counts as changed only when it was provided (`!== undefined`) **and** differs from the stored
  value: `name`/`slug` by exact string equality, `description` by `===` on `string | null` (`null` vs `null` is no
  change), `isActive` by boolean equality. `fields` = the API names (`SpecialtyField`) sorted alphabetically; `columns`
  = the same changes in snake_case (`is_active`).
- Setting a field to its own current value (e.g. `slug` unchanged) is therefore never a `409` against itself.
- **Audit metadata** holds field **names** only (`"description,isActive,name"`), never values (brainstorm → Privacy).
  `changedFields` is not a redacted key and stays far below the 500-character string limit.
- **`toConflict(error)`**: `uniqueViolationConstraint(error)` → `"uq_specialties_name"` → `SpecialtyNameTaken`;
  `"uq_specialties_slug"` → `SpecialtySlugTaken`; anything else (other constraint, no SQLSTATE, `AppError`) is returned
  unchanged and rethrown. The `catch` sits **outside** `db.transaction(...)`, so the rollback has already happened.
- No call to Identity, storage, or video; nothing happens after the transaction.

**`lib/knex/pg-errors.ts`** (new; generic error mapping belongs in `lib/` — CLAUDE.md → Folder structure; the
consultations module will add `23P01` here):
```ts
export const PG_UNIQUE_VIOLATION = "23505";
/** The violated constraint name when `error` is a pg unique violation (SQLSTATE 23505), else undefined. */
export function uniqueViolationConstraint(error: unknown): string | undefined;
```
Reads only `error.code` and `error.constraint` (pg `DatabaseError` fields, preserved by Knex with
`compileSqlOnError: false`); `PgErrorLike` lives in `lib/knex/types.ts`.

**`lib/auth/require-auth.ts`** (new):
```ts
/** The verified principal set by userGuard. `authorize` already guarantees it; absent → throws Unauthorized (fail closed). */
export function requireAuth(req: Request): AuthContext;
```

### 3.10 Policies (`policies.ts`)
```ts
export const SPECIALTIES_POLICIES: SpecialtiesPolicies = {
    list: {
        kind: "user",
        roles: ["patient", "doctor", "admin"],
        owner: { kind: "none" },
        accountState: { statuses: { doctor: ["pending", "active", "rejected"] } },   // S4; patient and admin: default ["active"]
    },
    create: { kind: "user", roles: ["admin"], owner: { kind: "none" }, audit: "admin-action" },
    update: { kind: "user", roles: ["admin"], owner: { kind: "none" }, audit: "admin-action" },
};
// types.ts: SpecialtiesRoute = "list" | "create" | "update"; SpecialtiesPolicies = Readonly<Record<SpecialtiesRoute, UserPolicy>>
```
- Matches `x-roles` and `x-ownership` of the three operations. No `checks`: the doctors module's
  `doctor_not_suspended` check guards **practising** actions; reading the public catalog is not one (a locally
  suspended doctor whose token is still `active` may read the catalog until the token expires — harmless).
- `suspended` is never admitted (`authorize` rejects such a policy at boot and a suspended token at request time).
- Rate-limit constants: `SPECIALTIES_LIST_IP_LIMIT = 60`, `SPECIALTIES_LIST_USER_LIMIT = 120`,
  `SPECIALTIES_LIST_WINDOW_MS = 60_000` (CLAUDE.md → Security rules, public-read class). Constants, not env vars.

### 3.11 DI
| Token (`lib/di/tokens.ts`) | Registration (`src/bootstrap.ts`) |
|---|---|
| `SpecialtiesService: Symbol.for("SpecialtiesService")` | `container.registerSingleton(TOKENS.SpecialtiesService, SpecialtiesService)` |
| `SpecialtiesController: Symbol.for("SpecialtiesController")` | `container.registerSingleton(TOKENS.SpecialtiesController, SpecialtiesController)` |

Every constructor parameter uses `@inject(TOKENS.X)` (ADR 0016).

---

## 4. Business rules

| # | Rule (testable) | Enforced by |
|---|---|---|
| S-R1 | `name` and `slug` are each unique (case-sensitive, D3); a duplicate on create or update → `409 Conflict` with `details[0].field` = `name` or `slug`; nothing is written | `uq_specialties_name`, `uq_specialties_slug` + `toConflict` (23505 by constraint name) |
| S-R2 | `slug` matches `^[a-z0-9]+(-[a-z0-9]+)*$` and is ≤ 100; `name` is 2–100; `description` is `null` or ≤ 2 000 | DTO (400) + `chk_specialties_*` |
| S-R3 | A specialty is never deleted: there is no `DELETE` route and `vcare_app` has no `DELETE`/`TRUNCATE` (42501) | routes + grants (migration 1) |
| S-R4 | A new specialty is always active; `isActive` cannot be sent on create | `insertSpecialty` (`is_active = true`) + `SpecialtyCreate` without `isActive` |
| S-R5 | `is_active` moves freely true ↔ false via `PATCH`; there is no other state | service |
| S-R6 | Patients and doctors see only active specialties; `includeInactive=true` is honoured only for admins and ignored for other roles | `SpecialtiesService.list` |
| S-R7 | `includeInactive` accepts exactly `true`/`false`; any other value (`yes`, `1`, `TRUE`, empty, repeated) → `400` for every role, in every build | `ToBoolean` + `IsBoolean` (#8) |
| S-R8 | The list is sorted by `name ASC, id ASC`; the cursor encodes `(name, id)`; paging through returns every visible row exactly once | repository keyset + `buildPage` |
| S-R9 | Every create and every effective update writes exactly one audit row (`specialty.created` / `specialty.updated`, entity `specialty`, the admin as actor, the request id) in the same transaction; `metadata` holds no names, slugs, or descriptions | service + `AuditRecorder` |
| S-R10 | A rolled-back write (409, audit failure, any error) leaves neither the row change nor an audit row | one transaction (Knex handler form) |
| S-R11 | A `PATCH` whose provided values all equal the stored ones answers `200` with the current row, does not change `updated_at`, and writes no audit row (S1); a partly-equal `PATCH` audits only the changed field names | `SpecialtiesService.diff` |
| S-R12 | `PATCH` with `{}` → `400` (`body: must contain at least one property`); a `null` `name`, `slug`, or `isActive` → `400`; `description: null` clears it | DTO + controller |
| S-R13 | An unknown, non-numeric, or non-canonical `:id` → `404 NotFound` (after the role check) | controller (`parsePositiveId`) + service |
| S-R14 | `POST` with an `Idempotency-Key`: same key + same body → the original `201` replayed (one row, one audit row); same key + different body → `422 IdempotencyConflict`; same key in flight → `409` + `Retry-After: 1` | `idempotency({ required: false })` |
| S-R15 | `GET` is limited to 60/min per client IP and 120/min per user; excess → `429 RateLimited` + `Retry-After`; Redis down → per-instance fallback | `rateLimit` (S2) |
| S-R16 | Seeding is idempotent and synthetic: running the seed migration twice leaves exactly the 20 starter rows; its `down` removes only unreferenced starter slugs | migration 2 |
| S-R17 | Concurrent creates of the same slug: exactly one `201`, the other `409` | `uq_specialties_slug` |

---

## 5. Cross-service behavior

None. No call to identity-service (Cases 1–4 do not apply), no worker loop, no storage, no video, no email. The only
Identity-related step is the existing local token verification of `userGuard` (access spec §3.3). Hub
`data-ownership.md` already lists "Specialties | care-service | `GET /api/specialties` | admin-managed" — no platform
change.

---

## 6. Error codes

No new code; all are in the contract `ErrorCode` enum.

| Code | HTTP | When (this module) | Emitted by |
|---|---|---|---|
| `ValidationFailed` | 400 | invalid query (`cursor` malformed or > 512 or an invalid position, `limit` not a canonical integer 1–100, `includeInactive` not `true`/`false`, unknown query member); invalid body (S-R2, unknown members, `null` where not allowed, non-object body); empty `PATCH` body; `Idempotency-Key` not a UUID; malformed percent-encoded path | `lib/validation`, controller, `idempotency`, `errorHandler` |
| `Unauthorized` / `TokenExpired` | 401 | missing/invalid/expired bearer token | `userGuard` |
| `Forbidden` | 403 | role not in policy (patient/doctor on `POST`/`PATCH`); account status not allowed (pending patient, pending admin, any suspended token) | `authorize` |
| `NotFound` | 404 | `PATCH` on an unknown or non-canonical id | controller, service |
| `Conflict` | 409 | duplicate `name` (`details: [{ field: "name", issue: "is already in use" }]`) or `slug` (`field: "slug"`); `POST` with an `Idempotency-Key` whose first request is in flight (`Retry-After: 1`) | service, `idempotency` |
| `IdempotencyConflict` | 422 | same `Idempotency-Key`, different body (`POST` only) | `idempotency` |
| `RateLimited` | 429 | a `GET` limiter tripped (`Retry-After` ≥ 1) | `rateLimit` |
| `InternalError` | 500 | unhandled error, including a failed audit insert (the write rolls back) | `errorHandler` |

Module error constants (`errors.ts`):
```ts
export const SpecialtyNameTaken = new AppError("Conflict", 409, "A specialty with this name already exists",
    [{ field: "name", issue: "is already in use" }]);
export const SpecialtySlugTaken = new AppError("Conflict", 409, "A specialty with this slug already exists",
    [{ field: "slug", issue: "is already in use" }]);
export const EmptySpecialtyUpdate = ValidationFailed.withDetails([{ field: "body", issue: "must contain at least one property" }]);
```
Details never echo the rejected value.

---

## 7. Security & privacy

- **RBAC summary:** reads for patient (`active`), doctor (`pending`/`active`/`rejected`, S4), admin (`active`);
  writes admin-only; ownership `none` on all three routes; deny by default via `authorize`; the boot assertion proves
  every route is `guard → authorize`. Identity headers (`X-User-Id`, `X-Role`) are ignored; no body member influences
  authorization.
- **Audit events:** `specialty.created` (metadata `{}`), `specialty.updated` (metadata `{ changedFields }`), entity type
  `specialty`, entity id = the specialty id, actor the admin (`actorFromAuth`), `request_id` = the request's id.
  Seeded rows and no-op `PATCH`es write none. Class `admin-action` (CLAUDE.md → Privacy and logging: "admin action").
- **Never logged:** `Authorization`, tokens, request bodies (the request logger never logs bodies), audit metadata,
  rate-limit subjects (IPs, user ids). Specialty names and descriptions are not PII or clinical, but they still stay out
  of logs and audit metadata by rule.
- **Database privileges:** `vcare_app` holds `SELECT, INSERT, UPDATE` + sequence `USAGE` on `specialties`; no `DELETE`,
  no `TRUNCATE` (S-R3).
- **Rate limits:** `GET` 60/min per IP (before signature verification) + 120/min per user (S2). Writes are admin-only
  and audited; no limiter (S2). Per-IP limiting depends on `TRUST_PROXY_HOPS` being right behind the edge
  ([#16](https://github.com/OmarRedaX/vcare-care-api/issues/16), §13.3).
- **Files:** none.
- **Caching headers:** not clinical or consultation data, so no `no-store` requirement.

---

## 8. Performance

CLAUDE.md → Performance rules sets no budget for the catalog; the module targets below are ceilings for review, not new
platform numbers.

| Path | Queries / round trips | Index | Target (p95, server) |
|---|---|---|---|
| `GET /specialties` | 1 `SELECT … LIMIT n+1`; 2 Redis `EVAL` (IP + user limiter); 0 Identity, 0 audit | `idx_specialties_name_id` (keyset seek; seq scan on a tiny table is equally fine) | < 50 ms |
| `POST /specialties` | `BEGIN`, `INSERT … RETURNING`, audit `INSERT`, `COMMIT`; + Redis `SET NX`/`SET` when a key is sent | PK + the two unique indexes | < 200 ms (booking-write ceiling) |
| `PATCH /specialties/{id}` | `BEGIN`, `SELECT … FOR UPDATE`, `UPDATE … RETURNING`, audit `INSERT`, `COMMIT` (no-op: `BEGIN`, `SELECT`, `COMMIT`) | PK | < 200 ms |

- No N+1, no `SELECT *`, `limit + 1` fetch (no `COUNT`).
- No Redis cache of the catalog (D4); revisit only if the search budget needs it.
- `EXPLAIN` of the list query is part of the integration suite (§9.4).

---

## 9. Test plan outline

Names follow `should <do something> when <condition>`. Unit tests mock collaborators (repository functions, Knex
transaction, `AuditRecorder`, Redis, clock). Integration tests use the real wiring, real Postgres as `care_app` (owner
`ownerDb` only for setup and assertions), real Redis, and the fake JWKS (`startFakeJwks` + `withFakeJwksCache`, as in
`tests/integration/audit.test.ts`). Every specialties suite runs `truncateAll()` in `beforeEach` (the global setup
seeds the 20 starter rows) and `flushByPrefix(["idem:", "rl:"])` in `beforeEach` (the per-IP limiter would otherwise
trip across tests). Test names use synthetic values such as `Synthetic Specialty 001`…`045` (identical prefix, so the
order is the same under any collation).

### 9.1 Unit (`tests/unit/`)
- `app/specialties/specialties.request.dto.test.ts`: should default includeInactive to false and limit to 20 when absent ·
  should map includeInactive "true"/"false" to booleans and **assert `Reflect.getMetadata("design:type",
  ListSpecialtiesQueryDto.prototype, "includeInactive") === Boolean` first** (the test runs with the metadata `tsc`
  emits, i.e. the compiled-build condition of #8) (S-R7) · should reject includeInactive "yes", "1", "TRUE", "", and
  ["true","false"] (S-R7) · should reject limit "0", "101", "1.5", "1e1", "05", " 5", "abc" · create: should accept a
  valid body and default description to null in toInput · should reject name of 1 and 101 chars, slug "Bad_Slug",
  "-a", "a--b", "a-", 101 chars, description 2 001 chars, description null, members isActive and id (S-R2, S-R4) ·
  update: should report isEmpty for {} and for a body of undefined members (S-R12) · should reject null name, slug,
  isActive and a string "false" isActive · should accept description null and keep it in toChanges · should omit
  absent members from toChanges.
- `app/specialties/specialties.response.dto.test.ts`: should copy every field and render dates with toISOString ·
  should produce exactly the contract `Specialty.required` keys (`schemaBlock("Specialty")`).
- `app/specialties/specialties.service.test.ts`: list — should honour includeInactive for an admin and ignore it for a
  patient and a doctor (S-R6) · should fetch limit + 1 and build the cursor from (name, id) (S-R8) · should throw
  ValidationFailed for a cursor whose sortValue is a number or longer than 100 chars. create — should insert then
  audit inside one transaction with action specialty.created, entity specialty, the actor from auth, and metadata {}
  (S-R9) · should map 23505 on uq_specialties_name/uq_specialties_slug to SpecialtyNameTaken/SpecialtySlugTaken (S-R1)
  · should rethrow a 23505 on another constraint and a non-pg error unchanged · should reject (so Knex rolls back) when
  the audit throws (S-R10). update — should throw NotFound when the row is absent · should return the current row with
  no update and no audit when nothing changed (S-R11) · should audit only the changed names, sorted, when some values
  are equal (S-R11) · should treat description null vs null as unchanged and null vs text as changed · should map
  23505 like create.
- `app/specialties/specialties.policies.test.ts`: should declare roles and owner none per contract x-roles/x-ownership
  for each route · should admit doctor pending/active/rejected only on list (S4) · should build without throwing via
  authorize() (valid at boot).
- `app/specialties/specialties.routes.test.ts`: should compose GET as [pre-auth rateLimit, guard, authorize, rateLimit,
  handler], POST as [guard, authorize, idempotency, handler], PATCH as [guard, authorize, handler] (markers) · should
  pass assertRoutesAuthorized · should register no router.param.
- `lib/knex/pg-errors.test.ts`: should return the constraint for code 23505 · should return undefined for other codes,
  a missing constraint, non-objects.
- `lib/auth/require-auth.test.ts`: should return req.auth · should throw Unauthorized when absent.
- Foundation-fix units: §12 (#7 cursor, #8 transforms/validate/lint, #9 member).

### 9.2 Integration — `tests/integration/specialties.test.ts` (routes mounted by the real `src/routes.ts`)
**RBAC per route** (CLAUDE.md → Testing policy; tokens: patient 101, doctor 202, admin 303):

| Route | none | patient active | doctor active | doctor pending / rejected | admin active | patient pending · admin pending · any suspended |
|---|---|---|---|---|---|---|
| `GET /api/specialties` | 401 `Unauthorized` | 200 | 200 | 200 (S4) | 200 | 403 `Forbidden` |
| `POST /api/specialties` | 401 | 403 | 403 | 403 | 201 | 403 |
| `PATCH /api/specialties/{id}` | 401 | 403 | 403 | 403 | 200 | 403 |

Plus: expired token → 401 `TokenExpired` · patient token with `X-Role: admin` / `X-User-Id: 303` → still 403 on POST ·
patient `PATCH /api/specialties/abc` → 403 (role before id) · admin `PATCH /api/specialties/abc`, `/0`, `/007`,
`/9007199254740993`, `/999999` → 404 (S-R13). There is no non-owner case (ownership `none`) and no clinical route
(the "admin denied on clinical routes" scenario does not apply).

**List:** should return only active rows for patient and doctor even with includeInactive=true (S-R6) · should return
inactive rows to an admin only with includeInactive=true, and not with includeInactive=false or absent (S-R6, #8 at
HTTP level) · should return 400 field includeInactive for "yes", "1", "TRUE", "" and a repeated parameter for a patient
and an admin (S-R7) · **should reach page 2 and the last page on the default sort** (45 rows, default limit 20: 20 + 20
+ 5, exact `name` order, no duplicates) (S-R8; CLAUDE.md mandatory) · should skip inactive rows inside pages for a
patient while the cursor stays valid · should continue correctly when the cursor row is deactivated between pages
(position, not grant) · should return 400 cursor for a tampered cursor, a numeric sortValue (`encodeCursor(5, 1)`), and
a 101-char name position · should return an empty page with `{ nextCursor: null, hasMore: false, count: 0 }` · should
match `PaginationMeta` and `Specialty` on every page (contract conformance).

**Create:** should return 201 with the contract `Specialty` (isActive true, description null when omitted) and write
one row and one audit row (actor_user_id 303, actor_role admin, action specialty.created, entity_type specialty,
entity_id = id, request_id = the sent X-Request-Id, metadata {}) (S-R4, S-R9) · should return 409 Conflict with
details field slug / name for a duplicate slug / name and leave the audit row count unchanged (S-R1, S-R10) · should
treat "Cardiology" and "cardiology" as different names (D3) · should return 400 for every invalid body of §9.1 ·
idempotency: same key + same body twice → 201 twice, same id, one row, one audit row (S-R14) · same key + different
body → 422 IdempotencyConflict · key not a UUID → 400 · no key, same body twice → 201 then 409 (S-R14) · **concurrency:**
two parallel POSTs with the same slug and different keys → exactly one 201 and one 409, one row (S-R17) · **audit
failure rolls back:** the owner adds `ALTER TABLE audit_logs ADD CONSTRAINT chk_test_block_specialty CHECK (action <>
'specialty.created')`, POST → 500 InternalError and no `specialties` row; the constraint is dropped in `finally`
(S-R10).

**Update:** should rename and return 200 with the new name; the DB `updated_at` (owner query) is greater than
`created_at`, and the response `updatedAt` ≥ `createdAt` (millisecond rendering) · should write one audit row with
changedFields "name" (S-R9) · should audit "description,isActive,slug" for a three-field change (sorted) · should clear
the description with null · should hide a deactivated row from patients and show it to admins with includeInactive, and
reactivate it (S-R5, S-R6) · **no-op:** same values → 200, identical body, `updated_at` unchanged, no audit row (S-R11) ·
partly equal → only the changed names audited · own current slug → 200, not 409 · duplicate slug of another row → 409
field slug, row unchanged, no audit row (S-R1, S-R10) · {} → 400 body; `{ "name": null }`, `{ "isActive": "false" }`,
`{ "createdAt": "…" }` → 400 (S-R12).

**Rate limit:** should store hits under `rl:specialties-list-ip:<ip>` and `rl:specialties-list-user:101` after one
patient GET · should return 429 RateLimited with Retry-After ≥ 1 on the 61st GET within a minute from one IP (S-R15).

**Grants and schema (as `care_app`):** `DELETE FROM specialties` and `TRUNCATE specialties` → 42501 (S-R3) · `SELECT`,
`INSERT`, `UPDATE` succeed · `has_table_privilege('vcare_app', 'specialties', 'DELETE')` is false and sequence `USAGE`
is true (owner query) · an `INSERT` with slug `Bad_Slug` or a 1-char name violates `chk_specialties_slug_format` /
`chk_specialties_name_length` (23514, owner) · **EXPLAIN:** inside a transaction as `care_app`, `SET LOCAL
enable_seqscan = off`, `EXPLAIN (FORMAT JSON)` of `listSpecialtiesQuery({ includeInactive: false, after: { sortValue:
"M", id: 1 }, fetch: 21 }).toSQL()` → the plan scans `idx_specialties_name_id` and has no `Sort` node.

**Logs:** captured logs across the suite contain no token string, no `Authorization` value, and no body fixture
(`SYNTHETIC-DESCRIPTION-4410` used as a description); every `request_completed.route` is `/api/specialties` or
`/api/specialties/:id`.

**Contract conformance:** every status returned per route is in `contractResponseCodes(<path>, <method>)`; every error
body passes `expectErrorEnvelope`; every success body passes `expectSuccessEnvelope` and the `Specialty` key check;
`idempotentOperations()` still lists `POST /api/specialties` with `Conflict`.

### 9.3 Integration — other suites touched
- `migrations.test.ts`: should seed exactly the 20 starter rows when the seed `up` runs twice on an empty table (owner;
  import the migration module) (S-R16) · should skip a starter row whose name already exists under another slug ·
  should delete only starter slugs on `down` and keep an API-created row (S-R16) · the existing rollback/latest round
  trip covers both new migrations.
- `boot.test.ts`: the header comment "no business module exists yet" is replaced; add should boot with the real
  `buildPublicRoutes()` and answer `GET /api/specialties` without a token with 401 (route mounted and guarded).
- `pagination.test.ts`, `rate-limit.test.ts`: §12.

### 9.4 Mandatory scenarios (CLAUDE.md → Testing policy) that apply
Each business rule S-R1–S-R17 (above) · RBAC per route (wrong role 403, allowed role 2xx; ownership `none`, so no
non-owner case) · pagination page 2 on the default sort · idempotent replay and conflicting body (`POST`) · logs free of
fixtures and tokens · every audited write writes its row in the transaction. Not applicable: concurrent booking, Cases
1–3, record lock, slot budget, uploads, download URLs, admin-on-clinical (no clinical route).

### 9.5 Manual QA (`/manual-qa specialties`)
Against a local Identity (real patient, doctor — including a `pending` doctor before approval — and admin tokens):
the RBAC table, list paging, create/duplicate/idempotent replay, rename/no-op/deactivate, 429 on the 61st GET.
**#8 on the compiled build:** `npm run build && node dist/server.js`, then admin `GET
/api/specialties?includeInactive=false` must omit an inactive row and `?includeInactive=yes` must answer 400. Record
no tokens in `manual-qa.md`; script `scripts/curl-test-specialties.sh`.

---

## 10. Out of scope
- Doctor ↔ specialty links, the search filter `?specialty=<slug>`, `SpecialtyRef`, and what an inactive specialty means
  for existing links and search — `doctors` module.
- `GET /specialties/{id}` (not in the contract), translations, hierarchy, icons, a catalog cache (D4).
- Hard delete or a `deleted_at` column (D4).
- Write rate limits (S2).
- Foundation gaps #12–#17 (at their own triggers; #16 noted in §13.3).
- Audit reads (`GET /audit-logs`, the `audit` module).

---

## 11. Open questions

None. The brainstorm's three open items are decided in §13.1 (S1–S3); S4 and the description-only contract edit C1 are
decided in §13.1–§13.2 and applied in `/develop` step 0.

---

## 12. Foundation fixes #7 #8 #9

Foundation [spec §13.3](../foundation/spec.md#133-known-latent-gaps-deferred-not-fixed) is quoted for each. The PR
closes the three issues; `/update-docs specialties` marks them fixed in foundation §13.3.

### 12.1 [#7](https://github.com/OmarRedaX/vcare-care-api/issues/7) — cursor precision (D1: full-precision cursor)
> "keyset cursors encode `TIMESTAMPTZ` as `Date.toISOString()` (milliseconds) while Postgres stores microseconds, so
> rows in the same millisecond are skipped (DESC) or repeated (ASC) at page boundaries" — fix before "the first
> paginated list".

**Fix (`lib/http/pagination`):** timestamp sort values never travel through a JS `Date`. The query selects the stored
value as a 6-digit ISO string, the cursor carries that string, and the comparison casts it back.
```ts
// timestamp-cursor.ts (new)
export const TIMESTAMP_CURSOR_PG_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
/** `to_char(<column> AT TIME ZONE 'UTC', '<format>') AS <alias>` — identifiers quoted by Knex (`??`), format bound (`?`). */
export function timestampCursorSelect(conn: Knex, column: string, alias: string): Knex.Raw;

// cursor.ts (added; encodeCursor/decodeCursor unchanged)
/** A position whose sort value is a string of at most `maxLength` characters (e.g. a name). */
export function decodeTextCursor(cursor: string, maxLength: number): StringCursorPosition;
/** A position whose sort value is a µs ISO timestamp `YYYY-MM-DDTHH:MM:SS.ffffffZ` that denotes a real instant. */
export function decodeTimestampCursor(cursor: string): StringCursorPosition;
// types.ts: export interface StringCursorPosition { sortValue: string; id: number }
```
- Keyset predicate on a timestamp sort: `(created_at, id) < (?::timestamptz, ?)` (DESC) or `>` (ASC) with
  `[position.sortValue, position.id]`; `positionOf(row) = [row.<alias>, row.id]`.
- Both decoders throw the existing `ValidationFailed` `[{ field: "cursor", issue: "is invalid" }]` for anything else:
  wrong type, longer than `maxLength`, a millisecond-only or offset (`+00:00`) timestamp, 5 or 7 fractional digits,
  or a non-existent date (`2026-02-30…`, checked by round-tripping the millisecond prefix through `Date`). A bad
  timestamp therefore never reaches a `::timestamptz` cast (which would be a 500).
- Specialties sorts on `name` and uses `decodeTextCursor`; the timestamp path is proven on the canonical test router.

**Changed helpers and tests:**
- `tests/helpers/test-routers.ts` → `buildPaginationRouter(total, options?: { order?: "asc" | "desc"; step?: "minute" |
  "microsecond" })`. Defaults keep today's rows (`(g / 3) * INTERVAL '1 minute'`, DESC), so every existing pagination
  test passes unchanged. `step: "microsecond"` generates `TIMESTAMPTZ '2026-01-01T00:00:00Z' + (g / 2) * INTERVAL '1
  microsecond'` (pairs share a µs; all rows inside one millisecond for `total` < 1 998). The router selects `id` and
  `timestampCursorSelect(db, "created_at", "created_at_cursor")`, decodes with `decodeTimestampCursor`, compares with
  `?::timestamptz`, and builds positions from `created_at_cursor`. (The type of the rows becomes `{ id: number;
  created_at_cursor: string }`.)
- `tests/integration/pagination.test.ts` adds: should page through 30 rows inside one millisecond with limit 7 in DESC
  order with no row skipped or repeated · the same in ASC · should carry 6 fractional digits in the decoded nextCursor
  equal to the stored value of the page's last row (owner `to_char` query) · the tampered-cursor case adds a
  well-formed cursor with a millisecond-only timestamp → 400.
- `tests/unit/lib/http/pagination.test.ts` adds `decodeTextCursor` / `decodeTimestampCursor` accept/reject tables.
- `.claude/skills/write-migration/SKILL.md` → Indexing rules gains: "Keyset cursors on a `TIMESTAMPTZ` sort select the
  value with `timestampCursorSelect` (6-digit µs ISO) and compare with `?::timestamptz`; never encode a JS `Date`."
  (docs step, §14.)

### 12.2 [#8](https://github.com/OmarRedaX/vcare-care-api/issues/8) — implicit conversion of query/params
> "`enableImplicitConversion: true` for query/params turns `"false"` into `true` for a boolean field under `tsc` (not
> under `tsx`, so dev and prod differ)" — fix before "the first non-string query/param DTO field".

Cause: `tsc` (and ts-jest) emit `design:type = Boolean` for a `boolean` property; class-transformer's implicit
conversion then calls `Boolean("false") === true`. `tsx` (esbuild) emits no metadata, so dev saw a string and a 400.

**Fix:**
- `lib/validation/validate.ts`: `plainToInstance(dto, input ?? {}, { enableImplicitConversion: false,
  exposeDefaultValues: true })` for **every** source. Nothing is converted unless a field declares a transform.
- `lib/validation/transforms.ts` (new; class-transformer `Transform(..., { toClassOnly: true })`):
  ```ts
  /** "true" → true, "false" → false; booleans pass through; anything else is returned unchanged (IsBoolean then fails). */
  export function ToBoolean(): PropertyDecorator;
  /** A string matching ^-?(0|[1-9][0-9]*)$ that is a safe integer → number; numbers pass through; anything else unchanged (IsInt then fails). */
  export function ToInt(): PropertyDecorator;
  ```
- `PaginationQueryDto.limit`: `@Type(() => Number)` → `@ToInt()`. Behaviour change: `limit=1e1`, `05`, ` 5`, `0x10`
  now answer 400 (they were accepted). No production route existed before this module.
- **Rule for every later module:** every non-string query or path field carries `ToInt()` or `ToBoolean()`; enforced by
  ESLint — the existing `no-restricted-syntax` block for `src/**/*.ts` (the one that ignores `types.ts`) gains:
  - `Property[key.name='enableImplicitConversion'][value.value=true]` — "implicit conversion is off (#8); use ToInt()/ToBoolean()";
  - `Decorator CallExpression[callee.name='Type'] > ArrowFunctionExpression[body.name=/^(Number|Boolean|String|Date)$/]`
    — "use ToInt()/ToBoolean() for query/param fields (#8)". (`@Type(() => JwkDto)` stays allowed.)

**Changed tests:** `tests/unit/lib/validation/validate.test.ts` fixtures `QueryDto.page` and `ParamsDto.id` switch to
`@ToInt()`, plus: should not convert a query string when a field has Boolean design metadata and no transform
(asserts the metadata is present, then `{ flag: "false" }` → 400 — before the fix it became `true`) · should give the
same result when the metadata is removed (`Reflect.deleteMetadata`, the `tsx` condition), so dev and prod agree.
New `tests/unit/lib/validation/transforms.test.ts` (accept/reject tables of §9.1). `tests/unit/lib/http/pagination.test.ts`
adds `limit` "1e1", "05", " 5" rejected. `tests/unit/lint/restricted-imports.test.ts` adds two snippets that must
report the new selectors and one clean snippet (`@ToInt()`). The compiled-build check is the DTO metadata assertion in
§9.1 plus the manual QA step in §9.5.

### 12.3 [#9](https://github.com/OmarRedaX/vcare-care-api/issues/9) — rate-limit member
> "the sliding-window member is `"<now>-<requestId>"` and the request id can be caller-supplied, so a same-millisecond
> burst with one `X-Request-Id` under-counts" — fix before "the first rate-limited route".

**Fix (`lib/rate-limit/rate-limit.ts`):** the `ZADD` member becomes `` `${now}-${randomUUID()}` `` (`node:crypto`) —
server-generated, unique per hit, never derived from any request input. The Lua script, key, score, and fallback
limiter are unchanged (the memory limiter stores timestamps, not members).

**Changed tests:**
- `tests/unit/lib/rate-limit/rate-limit.test.ts` ("should call the Lua script … and a unique member"): the member
  matches `^42000-<uuid>$`, differs between the two calls, and does not contain the response's `X-Request-Id`.
- `tests/helpers/test-routers.ts` → `buildRateLimitRouter(name, limit = 3, windowMs = 1_000, now?: () => number)`
  (passes `now` to `rateLimit`).
- `tests/integration/rate-limit.test.ts` adds: should admit exactly `limit` of 10 concurrent requests that share one
  `X-Request-Id` and one fixed `now` (limit 3, window 60 s → three 200, seven 429, `ZCARD` 3). Before the fix all ten
  were admitted (one member, `ZCARD` 1).

---

## 13. Decisions and contract changes

### 13.1 Decisions (2026-10-03)
| # | Decision | Rationale |
|---|---|---|
| S1 | **No-op `PATCH`** → `200` with the current row; no `UPDATE`, no `updated_at` change, no audit row. A partly-equal `PATCH` updates and audits only the changed fields | brainstorm recommendation; an audit row should mean a change happened; idempotent retries stay quiet |
| S2 | **Rate limits:** `GET /specialties` uses the public-read class — 60/min per IP (before the guard) + 120/min per user (after `authorize`); `POST`/`PATCH` get no limiter | CLAUDE.md → Security rules (search/slots class); writes are admin-only and audited; the contract keeps its generic `429` |
| S3 | **Starter catalog:** the 20 rows of §2.4; `ON CONFLICT DO NOTHING` (no target, covers name and slug) | synthetic, common telehealth specialties; a name collision must not fail a release |
| S4 | **Doctor account states on `GET /specialties`:** doctor `pending`, `active`, or `rejected`; patient and admin `active` | a doctor picks `specialtyIds` in `POST /doctors/apply` **before** approval and again when fixing a rejected application; with the default (`active` only) onboarding could not load the catalog. Reading the public catalog is not a "practising" action (CLAUDE.md → Authentication and service-to-service auth) |

### 13.2 Contract change C1 (description only; applied in `/develop` step 0, then hub sync)
No operation, schema, parameter, or status code changes. In `paths./api/specialties.get`, replace the `description`
line with:
```yaml
      description: >-
        Non-admins see active specialties only; admins may pass `includeInactive=true` (ignored for other roles).
        Accepts a doctor token with status `pending`, `active`, or `rejected` (a doctor picks specialties while
        applying, before approval); patients and admins must be `active`.
```
Then run `../vcare-hub/scripts/sync-from-spoke.sh` (the hub copy is never hand-edited). Everything else the module
needs is already in the contract: `400` covers `includeInactive` junk ("DTO validation failed"), `429` is declared on
all three operations, `IdempotencyKeyOptional` on `POST` only.

### 13.3 Risks accepted or carried
- **#16 `TRUST_PROXY_HOPS`** defaults to `0`: behind the edge every caller resolves to the proxy address, so the per-IP
  60/min of S2 would become platform-wide. Its trigger ("the first production deploy with per-IP limits") is unchanged
  and must be met before production; local and test runs are unaffected.
- **Collation (D3):** order and uniqueness follow the database default collation; production and test should share it.
- **#8 tightening:** `limit` now rejects non-canonical integers (`1e1`, `05`); intended.

---

## 14. Required follow-ups (docs; not open)
- **`/develop` step 0:** C1 + hub sync.
- **`/develop`:** `.claude/skills/write-migration/SKILL.md` timestamp-cursor rule (§12.1).
- **`/update-docs specialties`:** `architecture/data-model.md` (built-so-far line; `specialties` with the two added
  checks, `idx_specialties_name_id`, grants, the seed migration) · `architecture/rbac.md` (the `GET /specialties` row
  gains "doctor: pending, active, or rejected") · `architecture/api.md` (specialties rows: statuses 401/429, rate
  limits, idempotency) · `foundation/spec.md` §13.3 (#7 #8 #9 fixed by `specialties`) · `access/spec.md` §10 note (the
  three gaps it routed here are fixed) · **`docs/service-card.md`** (status line: first business module; endpoint
  family `/api/specialties` live) then the hub sync · this spec's as-built notes.
- **CLAUDE.md (user approval needed, recommended, not blocking):** under "Authentication and service-to-service auth",
  mention that `GET /specialties` also accepts doctor `pending`/`rejected` (S4); under "Module file conventions" item 2,
  "non-string query/path fields carry `ToInt()`/`ToBoolean()`; implicit conversion is off" (#8).

---

## 15. Task ordering (CLAUDE.md → Build order for a new module)

`[code]` = implementation by Codex (src, migrations, tests); `[docs]` = Opus / orchestrator.

| Step | Work | Who |
|---|---|---|
| 0 | Contract C1 (§13.2) + hub sync | [docs] |
| 0a (lib) | #8: `transforms.ts`, `validate.ts`, `PaginationQueryDto`, ESLint selectors + their tests (§12.2) | [code] |
| 0b (lib) | #7: `timestamp-cursor.ts`, `decodeTextCursor`/`decodeTimestampCursor`, test router + pagination tests (§12.1) | [code] |
| 0c (lib) | #9: rate-limit member + unit/integration tests (§12.3) | [code] |
| 0d (lib) | `lib/knex/pg-errors.ts`, `lib/auth/require-auth.ts` + unit tests (§3.9) | [code] |
| 1 | Migrations 1 and 2 (§2) | [code] |
| 2 | `constants.ts`, `enums.ts`, `errors.ts`, `types.ts` | [code] |
| 3 | Entity | [code] |
| 4 | Request DTOs | [code] |
| 5 | Response DTO | [code] |
| 6 | Repository | [code] |
| 7 | Service + DI token/registration | [code] |
| 8 | `policies.ts` | [code] |
| 9 | Controller + DI registration | [code] |
| 10 | `routes.ts` | [code] |
| 11 | Mount in `src/routes.ts` | [code] |
| 12 | Tests of §9 (unit, integration, RBAC, contract, concurrency, EXPLAIN, grants) | [code] |
| 13 | Manual QA incl. the compiled-build #8 check (§9.5) | [docs] (Opus runs it) |
| 14 | Docs of §14, write-migration skill rule, INDEX | [docs] |

Steps 0a–0d come first because the module's DTOs, repository, and routes use them; each lib step lands with its
regression tests and leaves typecheck, lint, unit, and integration green on the Docker test stack (5434/6381).
