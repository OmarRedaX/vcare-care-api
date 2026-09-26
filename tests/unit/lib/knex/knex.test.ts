import type { Knex } from "knex";
import { types as pgTypes } from "pg";
import { createKnex, parseInt8 } from "../../../../src/lib/knex/knex";
import { migrationConfig } from "../../../../src/lib/knex/knexfile";
import { probeDatabase } from "../../../../src/lib/knex/probe";
import type { KnexOptions } from "../../../../src/lib/knex/types";

type AfterCreate = (connection: unknown, done: (error: Error | null, connection: unknown) => void) => void;

/** Reads the pool/acquire settings Knex was configured with — no connection is ever opened (pool min 0). */
function configOf(knex: Knex): { pool: { min: number; max: number; afterCreate: AfterCreate }; acquireConnectionTimeout: number; connection: Record<string, unknown> } {
    return (knex.client as { config: never }).config;
}

/** A fake pg connection that records the SQL it receives and can fail a statement. */
function fakeConnection(failOn?: string) {
    const statements: string[] = [];
    const connection = {
        query(sql: string, callback: (error: Error | null) => void) {
            statements.push(sql);
            callback(failOn !== undefined && sql.startsWith(failOn) ? new Error("synthetic failure") : null);
        },
    };
    return { connection, statements };
}

function build(overrides: Partial<KnexOptions> = {}): Knex {
    return createKnex({
        url: "postgres://care:care@127.0.0.1:1/care_unit",
        poolMax: 3,
        statementTimeoutMs: 2000,
        applicationName: "care-api",
        ...overrides,
    });
}

function runAfterCreate(knex: Knex, connection: unknown): Promise<{ error: Error | null; connection: unknown }> {
    return new Promise((resolve) => {
        configOf(knex).pool.afterCreate(connection, (error, conn) => resolve({ error, connection: conn }));
    });
}

describe("lib/knex/createKnex", () => {
    const created: Knex[] = [];
    afterAll(async () => {
        await Promise.all(created.map((knex) => knex.destroy()));
    });

    it("should run SET TIME ZONE 'UTC' and the statement timeout when a connection is created (F8)", async () => {
        const knex = build();
        created.push(knex);
        const { connection, statements } = fakeConnection();

        const result = await runAfterCreate(knex, connection);

        expect(result).toEqual({ error: null, connection });
        expect(statements).toEqual(["SET TIME ZONE 'UTC'", "SET statement_timeout = 2000"]);
    });

    it("should skip the statement timeout when statementTimeoutMs is null", async () => {
        const knex = build({ statementTimeoutMs: null, applicationName: "care-migrate" });
        created.push(knex);
        const { connection, statements } = fakeConnection();

        await runAfterCreate(knex, connection);

        expect(statements).toEqual(["SET TIME ZONE 'UTC'"]);
    });

    it("should hand the error to the pool and stop when SET TIME ZONE fails", async () => {
        const knex = build();
        created.push(knex);
        const { connection, statements } = fakeConnection("SET TIME ZONE");

        const result = await runAfterCreate(knex, connection);

        expect(result.error).toBeInstanceOf(Error);
        expect(statements).toEqual(["SET TIME ZONE 'UTC'"]);
    });

    it("should configure a lazy pool, the application name, and a 1 s acquire timeout for care-api", () => {
        const knex = build({ poolMax: 7 });
        created.push(knex);
        const config = configOf(knex);
        expect(config.pool.min).toBe(0);
        expect(config.pool.max).toBe(7);
        expect(config.acquireConnectionTimeout).toBe(1_000);
        expect(config.connection).toMatchObject({ application_name: "care-api" });
    });

    it("should allow a 60 s acquire timeout when the application is care-migrate", () => {
        const knex = build({ applicationName: "care-migrate", statementTimeoutMs: null });
        created.push(knex);
        expect(configOf(knex).acquireConnectionTimeout).toBe(60_000);
    });
});

describe("lib/knex/parseInt8", () => {
    it("should parse int8 to a number when it is a safe integer (F8)", () => {
        expect(parseInt8("42")).toBe(42);
        expect(parseInt8("-7")).toBe(-7);
        expect(parseInt8(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    });

    it("should throw when int8 exceeds MAX_SAFE_INTEGER", () => {
        expect(() => parseInt8("9007199254740993")).toThrow("MAX_SAFE_INTEGER");
    });

    it("should register the int8 and date parsers with pg when the module loads", () => {
        expect(pgTypes.getTypeParser(20, "text")("12")).toBe(12);
        expect(pgTypes.getTypeParser(1082, "text")("2026-03-29")).toBe("2026-03-29");
    });
});

describe("lib/knex/probeDatabase", () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it("should resolve true when SELECT 1 succeeds", async () => {
        const raw = jest.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] });
        await expect(probeDatabase({ raw } as unknown as Knex, 500)).resolves.toBe(true);
        expect(raw).toHaveBeenCalledWith("SELECT 1");
    });

    it("should resolve false when the query rejects", async () => {
        const raw = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
        await expect(probeDatabase({ raw } as unknown as Knex, 500)).resolves.toBe(false);
    });

    it("should resolve false when the query exceeds the timeout", async () => {
        jest.useFakeTimers();
        const raw = jest.fn().mockReturnValue(new Promise(() => undefined));
        const probe = probeDatabase({ raw } as unknown as Knex, 500);
        await jest.advanceTimersByTimeAsync(500);
        await expect(probe).resolves.toBe(false);
    });
});

describe("lib/knex/migrationConfig", () => {
    it("should point at src/migrations with .ts extensions when running from source", () => {
        expect(migrationConfig.tableName).toBe("knex_migrations");
        expect(migrationConfig.loadExtensions).toEqual([".ts"]);
        expect(String(migrationConfig.directory).replace(/\\/g, "/")).toMatch(/\/src\/migrations$/);
    });
});
