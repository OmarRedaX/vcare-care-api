import type { Knex } from "knex";
import { db, probeDb } from "../../src/lib/knex/knex";

/** Truncates every table in `public` except Knex's own bookkeeping. No-op while no tables exist. */
export async function truncateAll(conn: Knex = db): Promise<void> {
    const result = await conn.raw<{ rows: Array<{ tablename: string }> }>(
        `SELECT tablename FROM pg_tables
         WHERE schemaname = 'public' AND tablename NOT LIKE 'knex_migrations%'`,
    );

    const tables = result.rows.map((row) => `"${row.tablename}"`);
    if (tables.length === 0) {
        return;
    }

    await conn.raw(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
}

/** Destroys the given pool, or both application pools (request + readiness probe) by default. */
export async function closeDb(conn?: Knex): Promise<void> {
    if (conn !== undefined) {
        await conn.destroy();
        return;
    }
    await Promise.all([db.destroy(), probeDb.destroy()]);
}
