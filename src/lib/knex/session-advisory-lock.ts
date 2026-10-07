import type { Knex } from "knex";

const PINNED = new WeakMap<Knex, number>();

/** Reserves a session while leaving at least one pool connection for short transactions. */
export async function withSessionAdvisoryLock<T>(db: Knex, namespace: number, id: number, work: () => Promise<T>): Promise<T | undefined> {
    const client = db.client as { acquireConnection(): Promise<unknown>; releaseConnection(connection: unknown): Promise<void>; config?: { pool?: { max?: number } } };
    const maxPinned = Math.max(0, (client.config?.pool?.max ?? 2) - 1);
    const active = PINNED.get(db) ?? 0;
    if (active >= maxPinned) return undefined;
    PINNED.set(db, active + 1);
    let connection: unknown;
    try {
        try { connection = await client.acquireConnection(); }
        catch (error) { if (error instanceof Error && error.name === "KnexTimeoutError") return undefined; throw error; }
        let held = false;
        try {
            const result = await db.raw("SELECT pg_try_advisory_lock(hashtextextended(?::text, ?::bigint)) AS acquired", [String(id), namespace]).connection(connection) as { rows: { acquired: boolean }[] };
            held = result.rows[0]?.acquired === true;
            if (!held) return undefined;
            return await work();
        } finally {
            try { if (held) await db.raw("SELECT pg_advisory_unlock(hashtextextended(?::text, ?::bigint))", [String(id), namespace]).connection(connection); }
            finally { await client.releaseConnection(connection); }
        }
    } finally {
        const remaining = (PINNED.get(db) ?? 1) - 1;
        if (remaining <= 0) PINNED.delete(db); else PINNED.set(db, remaining);
    }
}
