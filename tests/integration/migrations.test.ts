import type { Knex } from "knex";
import { InvalidEnvError, parseEnv } from "../../src/lib/config/env";
import { createKnex, db, probeDb } from "../../src/lib/knex/knex";
import { migrationConfig } from "../../src/lib/knex/knexfile";
import { closeDb } from "../helpers/db";

async function hasBtreeGist(conn: Knex): Promise<boolean> {
    const result = await conn.raw<{ rows: Array<{ count: number }> }>(
        "SELECT COUNT(*) AS count FROM pg_extension WHERE extname = 'btree_gist'",
    );
    return result.rows[0]?.count === 1;
}

describe("migrations + pool session settings (integration: real Postgres)", () => {
    let migrator: Knex;

    beforeAll(() => {
        migrator = createKnex({
            url: process.env.DATABASE_URL ?? "",
            poolMax: 1,
            statementTimeoutMs: null,
            applicationName: "care-migrate",
        });
    });

    afterAll(async () => {
        await migrator.destroy();
        await closeDb();
    });

    it("should have btree_gist installed after migrate latest (F21)", async () => {
        expect(await hasBtreeGist(db)).toBe(true);
        const [completed, pending] = (await migrator.migrate.list(migrationConfig)) as [unknown[], unknown[]];
        expect(pending).toHaveLength(0);
        expect(completed.length).toBeGreaterThanOrEqual(1);
    });

    it("should record migration names without the file extension (parity d)", async () => {
        const rows = await db("knex_migrations").select("name").orderBy("id");
        const names = rows.map((row: { name: string }) => row.name);
        expect(names).toContain("20260915000000_create_extension_btree_gist");
        expect(names.every((name) => !/\.(ts|js)$/.test(name))).toBe(true);
    });

    it("should support a btree_gist exclusion constraint over (bigint =, tstzrange &&) when installed", async () => {
        // The guarantee later modules rely on (CLAUDE.md → Database rules): proven on a temp table, never persisted.
        await db.transaction(async (trx) => {
            await trx.raw(`CREATE TEMP TABLE excl_probe (doctor_user_id BIGINT, starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ,
                EXCLUDE USING gist (doctor_user_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)) ON COMMIT DROP`);
            await trx.raw(`INSERT INTO excl_probe VALUES (1, '2026-01-01T10:00Z', '2026-01-01T10:30Z')`);
            await trx.raw(`INSERT INTO excl_probe VALUES (1, '2026-01-01T10:30Z', '2026-01-01T11:00Z')`); // adjacent: ok
            await trx.raw(`INSERT INTO excl_probe VALUES (2, '2026-01-01T10:00Z', '2026-01-01T10:30Z')`); // other doctor: ok
            await trx.raw("SAVEPOINT overlap");
            await expect(
                trx.raw(`INSERT INTO excl_probe VALUES (1, '2026-01-01T10:15Z', '2026-01-01T10:45Z')`),
            ).rejects.toMatchObject({ code: "23P01" });
            await trx.raw("ROLLBACK TO SAVEPOINT overlap");
        });
    });

    it("should remove and re-create btree_gist when rolled back and migrated again (F21)", async () => {
        try {
            await migrator.migrate.rollback(migrationConfig, true);
            expect(await hasBtreeGist(migrator)).toBe(false);
            const [, pending] = (await migrator.migrate.list(migrationConfig)) as [unknown[], unknown[]];
            expect(pending.length).toBeGreaterThanOrEqual(1);
        } finally {
            await migrator.migrate.latest(migrationConfig);
        }
        expect(await hasBtreeGist(migrator)).toBe(true);
    });

    it("should report UTC when SHOW TIME ZONE runs on a pooled connection (F8)", async () => {
        const results = await Promise.all(
            Array.from({ length: 3 }, () => db.raw<{ rows: Array<{ TimeZone: string }> }>("SHOW TIME ZONE")),
        );
        for (const result of results) {
            expect(result.rows[0]?.TimeZone).toBe("UTC");
        }
    });

    it("should report UTC on the readiness pool and the migrator too (F8)", async () => {
        for (const pool of [probeDb, migrator]) {
            const result = await pool.raw<{ rows: Array<{ TimeZone: string }> }>("SHOW TIME ZONE");
            expect(result.rows[0]?.TimeZone).toBe("UTC");
        }
    });

    // Review 2026-09-28 (Low): pg merges the connection string OVER createKnex's `options: "-c TimeZone=UTC"`, so a
    // DATABASE_URL carrying `options` must never reach a pool — env validation rejects it (spec §3.4.1).
    it("should reject at env validation a DATABASE_URL whose options pg would apply over TimeZone=UTC", async () => {
        const url = new URL(process.env.DATABASE_URL ?? "");
        url.searchParams.set("options", "-c TimeZone=America/New_York");

        expect(() => parseEnv({ DATABASE_URL: url.toString(), REDIS_URL: process.env.REDIS_URL })).toThrow(
            InvalidEnvError,
        );

        // Why the guard exists: bypassing env validation, pg really does let the URL win.
        const unguarded = createKnex({
            url: url.toString(),
            poolMax: 1,
            statementTimeoutMs: 2_000,
            applicationName: "care-test",
        });
        try {
            const result = await unguarded.raw<{ rows: Array<{ TimeZone: string }> }>("SHOW TIME ZONE");
            expect(result.rows[0]?.TimeZone).toBe("America/New_York");
        } finally {
            await unguarded.destroy();
        }
    });

    it("should apply the 2 s statement timeout on the care-api pool and none on the migrator", async () => {
        const api = await db.raw<{ rows: Array<{ statement_timeout: string }> }>("SHOW statement_timeout");
        expect(api.rows[0]?.statement_timeout).toBe("2s");
        const migrate = await migrator.raw<{ rows: Array<{ statement_timeout: string }> }>("SHOW statement_timeout");
        expect(migrate.rows[0]?.statement_timeout).toBe("0");
    });

    it("should return int8 as a number and date as a plain string when reading from Postgres (F8)", async () => {
        const result = await db.raw<{ rows: Array<{ big: unknown; count: unknown; day: unknown; at: unknown }> }>(
            `SELECT 9007199254740991::int8 AS big, COUNT(*) AS count, DATE '2026-03-29' AS day,
                    TIMESTAMPTZ '2026-03-29T01:30:00+02:00' AS at FROM generate_series(1, 3)`,
        );
        const row = result.rows[0];
        expect(row?.big).toBe(Number.MAX_SAFE_INTEGER);
        expect(row?.count).toBe(3);
        expect(row?.day).toBe("2026-03-29");
        expect(row?.at).toBeInstanceOf(Date);
        expect((row?.at as Date).toISOString()).toBe("2026-03-28T23:30:00.000Z");
    });

    it("should fail loudly when an int8 value exceeds Number.MAX_SAFE_INTEGER", async () => {
        await expect(db.raw("SELECT 9007199254740993::int8 AS big")).rejects.toThrow("MAX_SAFE_INTEGER");
    });
});
