import type { Knex } from "knex";
import { getEnv } from "../../src/lib/config/env";
import { createKnex, db, probeDb } from "../../src/lib/knex/knex";

/**
 * The OWNER pool (`MIGRATION_DATABASE_URL`, user `care`) — setup, teardown, and grant assertions only (ADR 0018). The
 * code under test always uses the app login (`care_app`), which cannot TRUNCATE or read `knex_migrations`. Lazy: no
 * connection until first use.
 */
export const ownerDb: Knex = createKnex({
    url: getEnv().MIGRATION_DATABASE_URL ?? "",
    poolMax: 2,
    statementTimeoutMs: 5_000,
    applicationName: "care-test",
});

/**
 * Truncates every parent table in `public` (plain or partitioned; partitions go with their parent) except Knex's own
 * bookkeeping, restarting identities. Runs as the owner by default. No-op while no tables exist.
 */
export async function truncateAll(conn: Knex = ownerDb): Promise<void> {
    const result = await conn.raw<{ rows: Array<{ relname: string }> }>(
        `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p')
           AND NOT c.relispartition
           AND c.relname NOT LIKE 'knex_migrations%'`,
    );

    const tables = result.rows.map((row) => `"${row.relname}"`);
    if (tables.length === 0) {
        return;
    }

    await conn.raw(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY`);
}

/** Destroys the given pool, or the application pools (request + readiness probe) and the owner pool by default. */
export async function closeDb(conn?: Knex): Promise<void> {
    if (conn !== undefined) {
        await conn.destroy();
        return;
    }
    await Promise.all([db.destroy(), probeDb.destroy(), ownerDb.destroy()]);
}
