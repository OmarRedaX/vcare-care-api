---
title: ADR 0018 — Database owner/app role split, explicit grants, and the SECURITY DEFINER partition function
owner: care-team
service: care-service
status: accepted
last_verified: 2026-10-03
tags: [adr, database, postgres, roles, grants, least-privilege, audit-logs, partitions, worker]
related: [access-spec, adr-0008-care-worker-component, adr-0009-audit-logs-monthly-partitions, adr-0001-no-orm-knex-raw-sql, data-model, infrastructure, runbook]
---

# ADR 0018 — Database owner/app role split, explicit grants, and the SECURITY DEFINER partition function

- **Status:** accepted
- **Date:** 2026-10-02
- **Context owner:** care-team
- **Supersedes / superseded by:** —

## Context

The foundation connected every component — `care-api`, `care-worker`, `care-migrate` — with one PostgreSQL
credential: the owner (`care`) that runs the migrations. CLAUDE.md → Database rules requires `audit_logs` to be
append-only "for the app role" and medical-record amendments to have no `UPDATE`/`DELETE` grant. A rule enforced only
by code is not append-only: the owner can do anything, so any bug or injected statement in the API could rewrite
history.

The `access` unit (`docs/access/spec.md`) creates `audit_logs`, monthly range-partitioned (ADR 0009), and the first
`care-worker` loop that keeps partitions ahead of time. PostgreSQL requires the **owner of the parent** to create a
partition, and the app role must not be that owner.

Options considered (brainstorm 2026-10-02):

| Option | Least privilege | Partition creation by the worker |
|---|---|---|
| One owner credential everywhere (status quo) | none: the app can `UPDATE`/`DELETE`/`DROP` | trivial |
| App role with `ALTER DEFAULT PRIVILEGES` | partial: every future table gets the same default grants, append-only needs per-table `REVOKE` | still needs the owner |
| **App role with explicit per-table grants** + a narrow `SECURITY DEFINER` function | full: each table grants exactly what the code needs | through the function, without the owner secret |
| Give the worker the owner credential | defeats the split for the component that runs unattended | trivial |

## Decision

1. **Two database roles plus one login.**
   - `care` — the owner (`LOGIN`; production: the owner credential of hub `deployment.md` → Release pipeline step 3,
     holding `CREATEROLE`). Owns every table, sequence, and function; runs migrations. Only `care-migrate` (and the
     integration-test setup) hold it, via `MIGRATION_DATABASE_URL`.
   - `vcare_app` — a `NOLOGIN` group role created by migration `create_app_role` (idempotent: roles are cluster-wide).
     It holds `CONNECT`, `USAGE ON SCHEMA public`, and the per-table grants; never `CREATE` on `public`.
   - `care_app` — the login `care-api` and `care-worker` use (`DATABASE_URL`), `INHERIT`, member of `vcare_app`,
     `NOSUPERUSER NOCREATEDB NOCREATEROLE`. Provisioned by `node dist/migrate.js ensure-app-login` (run by
     `care-migrate` after `latest`), never by a migration, so no password is ever committed. The DDL is built
     server-side with `format(%I, %L)`; the log line carries only `{ created }`.
2. **Explicit grants per table, in the migration that creates the table.** No `ALTER DEFAULT PRIVILEGES`. Append-only
   tables get `INSERT, SELECT` only, plus `USAGE` on their own sequence (which belongs to the `INSERT` grant, not a
   table privilege). Partitioned tables grant the parent and the `DEFAULT` partition; monthly partitions are granted
   when they are created.
3. **Partition creation goes through one owner-defined `SECURITY DEFINER` function**,
   `audit_logs_ensure_partitions(p_months_ahead integer)`: argument bounded 0–12, `search_path = pg_catalog, pg_temp`,
   every identifier schema-qualified and `%I`-quoted, `lock_timeout 2s`, `EXECUTE` revoked from `PUBLIC` and granted to
   `vcare_app` only. It is the only `SECURITY DEFINER` object. The app can call it (idempotent and bounded); it cannot
   create anything else.
4. **The worker serializes on a transaction-scoped advisory lock** (`pg_try_advisory_xact_lock(7311420001)`), not the
   session lock `pg_try_advisory_lock`: it releases on commit or rollback, so a pooled connection can never leak a held
   lock to the next borrower.
5. **The two URLs must name different roles** — `MIGRATION_DATABASE_URL` is optional in the shared env schema (the API
   and worker never need it) and rejected when its user equals `DATABASE_URL`'s.

## Consequences

- `audit_logs` is append-only by grant: `UPDATE`, `DELETE`, and `TRUNCATE` fail with `42501` for `care_app` on the
  parent, the default partition, and every monthly partition.
- Every future table migration must add its grants (the `write-migration` skill and the `migrate:make` template say
  so). A forgotten grant fails loudly (`42501` in integration tests), never silently over-grants.
- The owner needs `CREATEROLE` for `create_app_role` and `ensure-app-login` (decided 2026-10-02, hub
  `deployment.md` → Release pipeline step 3).
- Test helpers use an owner pool (`ownerDb`) for setup, `TRUNCATE`, and grant assertions; the code under test always
  runs as `care_app`. Rolling back `create_app_role` drops `vcare_app` and with it `care_app`'s membership, so a
  full rollback is followed by `latest` and `ensure-app-login`.
- `ensure-app-login` sends the password once per run inside a `CREATE/ALTER ROLE` statement: a server-side
  `log_statement = 'ddl'` or `'all'` would log it. Keep it off for the provisioning run (runbook).
- Creating a month while `audit_logs_default` holds a row inside its range fails; the worker reports
  `audit_partition_missing` and the runbook moves the rows.

## Addendum 2026-10-03 — access fix-review (decision unchanged; details tightened)

Appended, not rewritten (ADRs are append-only). Source: `docs/access/reviews/review-20261003-1600.md` (L1, L2, L3, M1).

- **Column-level `INSERT` on `audit_logs`** (migration `20261003120000_audit_logs_column_insert_grants`). The
  table-level `INSERT` of Decision 2 let the app role set `id` and `created_at` (back-dated or future-dated history, a
  row parked in the default partition, a duplicate id). `vcare_app` now holds `SELECT` and
  `INSERT (actor_user_id, actor_role, action, entity_type, entity_id, request_id, metadata)` on the parent, the default
  partition, and every monthly partition; the function grants the same per new partition. "Append-only tables get
  `INSERT, SELECT` only" still holds — the `INSERT` is narrower.
- **The function creates a month with `LIKE` + `ATTACH PARTITION`** (migration
  `20261003120100_audit_logs_partitions_attach`). `CREATE TABLE … PARTITION OF` took `ACCESS EXCLUSIVE` on the parent,
  so every audit insert queued behind it while any open transaction had written an audit row (measured: a concurrent
  insert waited 2 058 ms). `ATTACH` takes `SHARE UPDATE EXCLUSIVE` on the parent (compatible with `INSERT`); the
  function's `lock_timeout` is now 200 ms (the daily tick retries). The `SECURITY DEFINER` boundary, the bounded
  integer argument, the pinned `search_path`, and the `EXECUTE` grants are unchanged.
- **`ensure-app-login` refuses a privileged existing role** (`app_login_role_privileged`: `SUPERUSER`, `CREATEROLE`,
  `CREATEDB`, `REPLICATION`, `BYPASSRLS`, or owned objects) rather than taking it over or demoting it, and rethrows any
  DDL failure as the fixed `app_login_ddl_failed` (SQLSTATE `code` only), so the password inside the DDL can never
  reach the `migration_failed` log line on a dropped connection.
- **`worker --once audit-partitions` exits 1** unless that tick ensured the partitions (`worker_once_incomplete`).
- **Re-review 2026-10-03 (round 2): `ensure-app-login` also refuses role membership.** An existing login that is a
  direct member of any role other than `vcare_app` (the owner role, `pg_write_all_data`, …) gets
  `app_login_role_privileged`, since `INHERIT` would pass those rights on; the role check is now wrapped like the DDL,
  so any failure there is also rethrown as `app_login_ddl_failed`. The app login's rights therefore come only from
  `vcare_app`, as Decision 1 states.
