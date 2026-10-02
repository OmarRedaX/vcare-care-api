import type { Knex } from "knex";

/**
 * vcare_app: the NOLOGIN group role the application login (`care_app`) inherits from (ADR 0018). It may connect and
 * resolve names in `public`, nothing more; every table migration grants it exactly what the code needs, explicitly
 * (no ALTER DEFAULT PRIVILEGES). It never gets CREATE on `public`, so the app cannot create or alter tables.
 * The `care_app` login itself is provisioned by `node dist/migrate.js ensure-app-login`, never here, so no password is
 * ever committed in a migration. Requires CREATEROLE on the owner (hub deployment.md → Release pipeline step 3).
 */
export async function up(knex: Knex): Promise<void> {
    // Roles are cluster-wide: idempotent so a second database in the same cluster (dev + test) or a re-run never fails.
    await knex.raw(`
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vcare_app') THEN
                CREATE ROLE vcare_app NOLOGIN;
            END IF;
        END
        $$;
    `);
    await knex.raw(`
        DO $$
        BEGIN
            EXECUTE format('GRANT CONNECT ON DATABASE %I TO vcare_app', current_database());
        END
        $$;
    `);
    await knex.raw(`GRANT USAGE ON SCHEMA public TO vcare_app;`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`REVOKE USAGE ON SCHEMA public FROM vcare_app;`);
    await knex.raw(`
        DO $$
        BEGIN
            EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM vcare_app', current_database());
        END
        $$;
    `);
    // Another database of this cluster may still hold grants to the role: keep it there instead of failing.
    await knex.raw(`
        DO $$
        BEGIN
            DROP ROLE IF EXISTS vcare_app;
        EXCEPTION WHEN dependent_objects_still_exist THEN
            RAISE NOTICE 'vcare_app kept: it still holds privileges in another database of this cluster';
        END
        $$;
    `);
}
