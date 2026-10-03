---
name: write-migration
description: Use when writing, adding, or altering a Knex + PostgreSQL migration in a vcare service — creating a table, adding a column/index/constraint/foreign key, choosing a datatype (bigint vs int, money, TIMESTAMPTZ, enum-like columns), adding soft delete, or guaranteeing non-overlapping time ranges with a btree_gist exclusion constraint. Covers raw-SQL migration structure, naming, indexing, soft-delete uniqueness, append-only tables, and exclusion constraints.
---

# Writing a Migration (vcare)

## Overview

Migrations are **raw SQL** inside Knex `up`/`down`, one change per file, named `YYYYMMDDHHMMSS_<description>.ts`. `knex.schema.*` builders are **forbidden** — always `knex.raw`.

**Core principles**
1. A migration is **append-only history**: once it has run anywhere, never edit it — write a new one. Every `up` has a real `down`.
2. **The database guarantees invariants the application cannot** (uniqueness among live rows, non-overlap, append-only). Application checks are a courtesy; constraints are the guarantee.
3. **Time is `TIMESTAMPTZ`**, stored in UTC. `TIMESTAMP` without time zone is never used.
4. **Nothing is hard-deleted** from business tables: `deleted_at TIMESTAMPTZ`.

## When to use
- Creating or altering a table, column, index, constraint, FK, trigger, or extension
- Choosing a datatype (the table below is the reference)
- Enforcing uniqueness with soft delete, non-overlapping ranges, or append-only records
- Reviewing a migration for compliance with CLAUDE.md → "Database rules"

## Workflow
```
- [ ] 1. Contract/spec first: the table serves operations already in contracts/openapi.yaml + docs/<module>/spec.md
- [ ] 2. Generate: npm run migrate:make <description>
- [ ] 3. up(): extensions → table → constraints → indexes (each index commented with its query) → triggers → explicit grants to the app group role
- [ ] 4. down(): reverse every step in reverse order (IF EXISTS everywhere)
- [ ] 5. Apply: npm run migrate   → verify: npm run migrate:status
- [ ] 6. Prove down(): npm run migrate:rollback && npm run migrate
- [ ] 7. EXPLAIN each query the new indexes are meant to serve
```

| Action | Command |
|---|---|
| Generate file | `npm run migrate:make <description>` |
| Apply pending | `npm run migrate` |
| Roll back last batch | `npm run migrate:rollback` |
| Status | `npm run migrate:status` |

## Canonical table (soft delete, TIMESTAMPTZ, named constraints)

```ts
import type {Knex} from "knex";

/**
 * consultation_types: the bookable offerings a doctor defines (duration + price).
 * Invariant: at most one live type per (doctor, name). Soft-deleted rows keep history for old consultations.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE consultation_types (
            id               BIGSERIAL PRIMARY KEY,
            doctor_profile_id BIGINT NOT NULL,
            name             VARCHAR(100) NOT NULL,
            duration_minutes INT NOT NULL,
            price            INT NOT NULL,
            currency         CHAR(3) NOT NULL,
            created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            deleted_at       TIMESTAMPTZ,

            CONSTRAINT fk_consultation_types_doctor_profile_id
                FOREIGN KEY (doctor_profile_id) REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
            CONSTRAINT chk_consultation_types_duration CHECK (duration_minutes BETWEEN 5 AND 240),
            CONSTRAINT chk_consultation_types_price CHECK (price >= 0)
        );
    `);

    // uniqueness among LIVE rows only: a soft-deleted "Follow-up" must not block creating a new one.
    // Leading column also covers the doctor_profile_id FK.
    await knex.raw(`
        CREATE UNIQUE INDEX uq_consultation_types_doctor_profile_id_name
            ON consultation_types (doctor_profile_id, name) WHERE deleted_at IS NULL;
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS consultation_types;`);
}
```

Note: no `CASCADE` in `down()` of a table other tables reference — drop dependents in their own migrations' `down()` first, so a rollback never silently destroys data.

## Datatype selection

| Need | Use | Notes |
|---|---|---|
| Primary key | `BIGSERIAL` | Exposed as the numeric API id (hub ADR 0004). No `public_id` column. |
| Foreign key (same DB) | `BIGINT` + named FK | Matches the referenced PK width. |
| Reference to **another service's** entity | `BIGINT NOT NULL`, **no FK** | Name it for the role (`patient_user_id`, `doctor_user_id`) and comment `-- Identity user id`. Never join across databases. |
| Money | `INT` minor units + `currency CHAR(3)` | Never `DECIMAL`/`FLOAT`. `BIGINT` if a sum can exceed ~21M major units. No default. |
| Percentage / rate | `INT` basis points | 10000 = 100 %. |
| Count / duration in minutes | `INT` | Add a `CHECK` range. |
| Enum-like status | `VARCHAR(n) NOT NULL CHECK (col IN (...))` | Values match the TS enum exactly. Never native `ENUM`. No default on critical statuses. |
| Boolean | `BOOLEAN NOT NULL` | `is_` prefix; default only if genuinely safe. |
| Short string | `VARCHAR(n)` | names 100–255, currency `CHAR(3)`, IANA timezone `VARCHAR(64)`, locale `VARCHAR(35)`. |
| Email | `CITEXT` | `CREATE EXTENSION IF NOT EXISTS citext;` Unique among live rows. |
| Long text | `TEXT` | Notes, reasons, clinical free text. |
| Instant in time | `TIMESTAMPTZ` | `created_at/updated_at NOT NULL DEFAULT NOW()`; event times (`verified_at`, `cancelled_at`) nullable, no default. |
| Wall-clock time of day | `TIME` + the owner's `timezone` column | Working hours: `start_time TIME`, `end_time TIME`, interpreted in `doctor_profiles.timezone`. Never `TIMETZ`. |
| Calendar date | `DATE` | Schedule exceptions (`date DATE`) in the doctor's timezone. |
| Time range | two `TIMESTAMPTZ` columns + `tstzrange(...)` in constraints/indexes | Keep `starts_at`/`ends_at` as columns; build the range in the constraint. |
| Secret / token | `VARCHAR(128)` hash | sha256 hex for random tokens; argon2id encoded string for passwords/client secrets. Never plaintext. |
| File reference | `VARCHAR(512)` object key | Never a URL — URLs are signed per request. |
| Semi-structured blob (rare) | `JSONB` | Only if the shape is genuinely dynamic and never filtered on. Never clinical text in audit `metadata`. |

## Soft delete — the rules
- Every business table has `deleted_at TIMESTAMPTZ` (nullable, no default).
- **Every unique constraint that users can "recreate" becomes a partial unique index `WHERE deleted_at IS NULL`.** A plain `UNIQUE` on a soft-deleted table is a bug.
- Hot-path indexes on live data are partial too (`WHERE deleted_at IS NULL`) so deleted rows don't bloat them.
- FKs from children use `ON DELETE RESTRICT` — hard deletes should fail loudly because they should never happen. **Clinical tables never use `ON DELETE CASCADE`.**

## Non-overlapping time ranges — `btree_gist` exclusion constraint

When "two rows for the same owner must never overlap in time" (a doctor's consultations), a `UNIQUE` index cannot express it and an application check races. Use an **exclusion constraint**:

```ts
export async function up(knex: Knex): Promise<void> {
    // btree_gist lets a GiST index combine scalar equality (doctor_user_id =) with range overlap (&&).
    await knex.raw(`CREATE EXTENSION IF NOT EXISTS btree_gist;`);

    await knex.raw(`
        ALTER TABLE consultations
            ADD CONSTRAINT chk_consultations_time_order CHECK (ends_at > starts_at);
    `);

    // Guarantees business rule "a doctor can never have two overlapping consultations".
    // Half-open '[)' so back-to-back consultations (10:00–10:30, 10:30–11:00) are allowed.
    // Cancelled / no-show / soft-deleted rows release their interval.
    await knex.raw(`
        ALTER TABLE consultations
            ADD CONSTRAINT excl_consultations_doctor_no_overlap
            EXCLUDE USING gist (
                doctor_user_id WITH =,
                tstzrange(starts_at, ends_at, '[)') WITH &&
            )
            WHERE (status NOT IN ('cancelled', 'no_show') AND deleted_at IS NULL);
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`ALTER TABLE consultations DROP CONSTRAINT IF EXISTS excl_consultations_doctor_no_overlap;`);
    await knex.raw(`ALTER TABLE consultations DROP CONSTRAINT IF EXISTS chk_consultations_time_order;`);
    // The extension is left installed: other objects may depend on it.
}
```

**Rules for exclusion constraints**
- Always use half-open ranges `'[)'`.
- The `WHERE` predicate must match exactly the statuses that **free** the interval; it must mirror the TS enum of terminal-releasing states. Changing that set is a new migration.
- The service maps SQLSTATE **`23P01` (`exclusion_violation`)** to `409 SlotUnavailable`; never surface the raw error.
- Reschedule = update `starts_at/ends_at` in the same row inside a transaction — the constraint re-checks against other rows, and the row's old interval is released atomically.
- The GiST index created by the constraint also serves "consultations of doctor X overlapping window W" queries (`doctor_user_id = $1 AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2, $3, '[)')`) — don't add a duplicate btree for that query.
- Existing data must already satisfy the constraint, or the `ALTER` fails — check with the overlap query first.

## Grants — the app role (Care ADR 0018)
Migrations run as the **owner** (`MIGRATION_DATABASE_URL`); the API and worker log in as an app login that is a member
of the `NOLOGIN` group role **`vcare_app`** (`DATABASE_URL`). The app role owns nothing and holds only what each
migration grants it:
- **Every table migration grants `vcare_app` explicitly**, in the migration that creates the table. Never
  `ALTER DEFAULT PRIVILEGES` — a forgotten grant must fail loudly (`42501`), never silently over-grant.
- Grant exactly what the code needs: `SELECT, INSERT, UPDATE` for a normal soft-delete table (no `DELETE` — hard
  delete is never exposed), plus `USAGE` on the table's own `BIGSERIAL` sequence (`<table>_id_seq`; it belongs to the
  `INSERT` grant, not a table privilege). Never `TRUNCATE`, never `CREATE` on `public`.
- **Partitioned tables** grant the parent **and** the `DEFAULT` partition; monthly partitions are granted when they are
  created (Care: inside `audit_logs_ensure_partitions`).
- `down()` needs no `REVOKE`: dropping the table drops its grants.

```sql
GRANT SELECT, INSERT, UPDATE ON specialties TO vcare_app;
GRANT USAGE ON SEQUENCE specialties_id_seq TO vcare_app;
```

## Append-only tables (audit logs, record amendments)
Append-only is a **grant**, not a habit: the app role gets `INSERT, SELECT` only (plus `USAGE` on the sequence) —
no `UPDATE`, `DELETE`, or `TRUNCATE`, so history is tamper-evident even against an API bug. The `INSERT` is
**column-level**: the app never writes `id` or `created_at` (their defaults do), so it must not be able to — otherwise
it can back-date or future-date history or duplicate an id (Care review 2026-10-03; migration
`20261003120000_audit_logs_column_insert_grants`).
```sql
GRANT SELECT, INSERT (actor_user_id, actor_role, action, entity_type, entity_id, request_id, metadata) ON audit_logs TO vcare_app;
GRANT SELECT, INSERT (actor_user_id, actor_role, action, entity_type, entity_id, request_id, metadata) ON audit_logs_default TO vcare_app;
GRANT USAGE ON SEQUENCE audit_logs_id_seq TO vcare_app;
```
To narrow an existing table-level `INSERT`, `REVOKE INSERT ON t FROM vcare_app` first (it also revokes column grants),
then grant the column list — on the parent **and every partition**.

**Creating a partition on a live table:** never `CREATE TABLE … PARTITION OF parent` (ACCESS EXCLUSIVE on the parent:
every insert queues behind it while any open transaction has written a row). Create a standalone table
`(LIKE parent INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`, then `ALTER TABLE parent ATTACH PARTITION … FOR VALUES …`
(SHARE UPDATE EXCLUSIVE — compatible with INSERT), with a short `lock_timeout` (Care: 200 ms;
`20261003120100_audit_logs_partitions_attach`).
For "editable for 24 h, then locked" rows (medical records), add `locked_at TIMESTAMPTZ NOT NULL` and a trigger that raises when `NEW` differs from `OLD` after `locked_at`:
```sql
CREATE OR REPLACE FUNCTION forbid_update_after_lock() RETURNS trigger AS $$
BEGIN
    IF OLD.locked_at <= NOW() THEN
        RAISE EXCEPTION 'record % is locked', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_medical_records_forbid_update_after_lock
    BEFORE UPDATE ON medical_records FOR EACH ROW EXECUTE FUNCTION forbid_update_after_lock();
```

## Naming conventions

| Object | Pattern | Example |
|---|---|---|
| Table | plural `snake_case` | `schedule_exceptions` |
| Column | `snake_case`, booleans `is_` | `is_accepting_patients` |
| Timestamp | `created_at`, `updated_at`, `deleted_at`, `<verb>_at` | `verified_at`, `locked_at` |
| Primary key | `id BIGSERIAL` | — |
| Foreign key | `fk_<table>_<col>` | `fk_working_hours_doctor_profile_id` |
| Unique | `uq_<table>_<cols>` | `uq_users_email` (partial) |
| Check | `chk_<table>_<what>` | `chk_consultations_status` |
| Exclusion | `excl_<table>_<what>` | `excl_consultations_doctor_no_overlap` |
| Index | `idx_<table>_<cols>` | `idx_consultations_patient_user_id_starts_at` |
| Trigger | `trg_<table>_<what>` | `trg_medical_records_forbid_update_after_lock` |

## Indexing rules
- **Only for a query that exists in code**, with a comment above naming that query path.
- **Every FK column is covered** by an index whose **leading** column is that FK (a composite or unique index counts).
- **Composite order:** equality columns first, then the range/sort column (`(patient_user_id, starts_at DESC)`).
- **Partial indexes** for live data (`WHERE deleted_at IS NULL`) and hot subsets (`WHERE status IN ('booked','waiting')`).
- Keyset pagination needs an index on `(filter cols…, sort col, id)`.
- Batch lookups use `WHERE id = ANY($1)` — the PK index serves them.

## ALTER migrations
- New `NOT NULL` column: add nullable → backfill in batches → `SET NOT NULL` in a later migration (or add with a safe default).
- Large tables: `CREATE INDEX CONCURRENTLY` in its own migration with `export const config = { transaction: false };`.
- `down()` reverses in reverse order with `IF EXISTS`; note any precondition (e.g. restoring `NOT NULL` requires no NULL rows).

## Common mistakes

| Mistake | Fix |
|---|---|
| `knex.schema.createTable(...)` | `knex.raw` SQL |
| `TIMESTAMP` without time zone | `TIMESTAMPTZ` |
| Plain `UNIQUE` on a soft-deleted table | Partial unique index `WHERE deleted_at IS NULL` |
| App-level "is the slot free?" check only | `btree_gist` exclusion constraint + map `23P01` |
| Closed range `'[]'` | Half-open `'[)'` |
| FK to another service's table / database | `BIGINT` reference, no FK, commented |
| `ON DELETE CASCADE` on clinical data | `ON DELETE RESTRICT`; soft delete |
| Storing slots or availability | Store inputs only; compute slots |
| Storing a public file URL | Store the object key; sign per request |
| Plaintext token/secret column | Store a hash |
| `DECIMAL`/`FLOAT` money, default on price | `INT` minor units, no default |
| Native `ENUM` | `VARCHAR … CHECK` |
| FK column without a leading index | Add `idx_<table>_<col>` |
| Unnamed constraint | Name it |
| Editing a migration that ran | New migration |
| Table without a grant, or `ALTER DEFAULT PRIVILEGES` | Explicit `GRANT … TO vcare_app` in the creating migration |
| `UPDATE`/`DELETE` granted on an append-only table | `INSERT, SELECT` only (+ sequence `USAGE`) |
| Table-level `INSERT` on an append-only table (app can set `id`/`created_at`) | Column-level `INSERT (<writable columns>)` |
| `CREATE TABLE … PARTITION OF` a live parent | `CREATE TABLE … (LIKE parent …)` + `ATTACH PARTITION`, short `lock_timeout` |
| Partition created by the app or worker as owner | Owner-defined, bounded `SECURITY DEFINER` function; the worker never holds the owner secret |
| Empty or throwing `down()` | Real reversal |
