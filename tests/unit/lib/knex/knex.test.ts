import type { Knex } from "knex";
import { types as pgTypes } from "pg";
import { buildKnexLog } from "../../../../src/lib/knex/knex-log";
import { buildConnectionConfig, createKnex, parseInt8 } from "../../../../src/lib/knex/knex";
import { MigrationFiles, migrationConfig } from "../../../../src/lib/knex/knexfile";
import { probeDatabase } from "../../../../src/lib/knex/probe";
import type { KnexOptions } from "../../../../src/lib/knex/types";
import { Logger } from "../../../../src/lib/logger/logger";

/** Reads the settings Knex was configured with — no connection is ever opened (pool min 0). */
function configOf(knex: Knex): {
    pool: { min: number; max: number; createTimeoutMillis: number; afterCreate?: unknown };
    acquireConnectionTimeout: number;
    connection: Record<string, unknown>;
    compileSqlOnError: boolean;
    log: Knex.Logger;
} {
    return (knex.client as { config: never }).config;
}

const OPTIONS: KnexOptions = {
    url: "postgres://care:care@127.0.0.1:1/care_unit",
    poolMax: 3,
    statementTimeoutMs: 2000,
    applicationName: "care-api",
};

function build(overrides: Partial<KnexOptions> = {}): Knex {
    return createKnex({ ...OPTIONS, ...overrides });
}

describe("lib/knex/createKnex", () => {
    const created: Knex[] = [];
    afterAll(async () => {
        await Promise.all(created.map((knex) => knex.destroy()));
    });

    it("should pass TimeZone=UTC and the statement timeout as startup parameters when a pool is created (F8)", () => {
        const knex = build();
        created.push(knex);
        const config = configOf(knex);
        expect(config.connection).toMatchObject({ options: "-c TimeZone=UTC", statement_timeout: 2000 });
        // No per-connection SETs inside the 1 s acquire window any more.
        expect(config.pool.afterCreate).toBeUndefined();
    });

    it("should set connect and query timeouts and TCP keepalive when the statement timeout is set", () => {
        expect(buildConnectionConfig(OPTIONS)).toEqual({
            connectionString: OPTIONS.url,
            application_name: "care-api",
            options: "-c TimeZone=UTC",
            connectionTimeoutMillis: 2000,
            keepAlive: true,
            keepAliveInitialDelayMillis: 10_000,
            statement_timeout: 2000,
            query_timeout: 3000,
        });
    });

    it("should omit the statement and query timeouts when statementTimeoutMs is null", () => {
        const config = buildConnectionConfig({ ...OPTIONS, statementTimeoutMs: null, applicationName: "care-migrate" });
        expect(config).not.toHaveProperty("statement_timeout");
        expect(config).not.toHaveProperty("query_timeout");
        expect(config).toMatchObject({ options: "-c TimeZone=UTC", connectionTimeoutMillis: 2000, keepAlive: true });
    });

    it("should configure a lazy pool, the application name, a 2 s create timeout, and a 1 s acquire timeout for care-api", () => {
        const knex = build({ poolMax: 7 });
        created.push(knex);
        const config = configOf(knex);
        expect(config.pool.min).toBe(0);
        expect(config.pool.max).toBe(7);
        expect(config.pool.createTimeoutMillis).toBe(2_000);
        expect(config.acquireConnectionTimeout).toBe(1_000);
        expect(config.connection).toMatchObject({ application_name: "care-api" });
    });

    it("should allow a 60 s acquire timeout when the application is care-migrate", () => {
        const knex = build({ applicationName: "care-migrate", statementTimeoutMs: null });
        created.push(knex);
        expect(configOf(knex).acquireConnectionTimeout).toBe(60_000);
    });

    it("should never compile bindings into an error message when a query fails (F7)", () => {
        const knex = build();
        created.push(knex);
        expect(configOf(knex).compileSqlOnError).toBe(false);
    });

    it("should route Knex's own log output through the JSON logger when a pool is created (bug 2)", () => {
        const knex = build();
        created.push(knex);
        const log = configOf(knex).log;
        expect(log.enableColors).toBe(false);
        for (const method of [log.warn, log.error, log.debug, log.deprecate]) {
            expect(typeof method).toBe("function");
        }
    });
});

describe("lib/knex/buildKnexLog", () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    function collect() {
        const lines: Array<Record<string, unknown>> = [];
        const logger = new Logger({
            level: "debug",
            service: "care-service",
            write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
        });
        return { log: buildKnexLog(logger), lines };
    }

    it("should log one JSON line with only the first line of Knex's text and never use console when Knex logs", () => {
        const { log, lines } = collect();
        const consoleLog = jest.spyOn(console, "log").mockImplementation(() => undefined);

        log.warn?.("Acquire connection error: Error: connect ECONNREFUSED 127.0.0.1:1\n    at TCPConnectWrap.afterConnect");
        log.error?.("Knex: " + "x".repeat(500));
        log.deprecate?.("json(true)", "jsonb()");
        log.debug?.("select $1::int as n");

        expect(consoleLog).not.toHaveBeenCalled();
        expect(lines.map((line) => [line.level, line.message])).toEqual([
            ["warn", "knex_warn"],
            ["error", "knex_error"],
            ["warn", "knex_deprecated"],
            ["debug", "knex_debug"],
        ]);
        expect(lines[0]?.summary).toBe("Acquire connection error: Error: connect ECONNREFUSED 127.0.0.1:1");
        expect(String(lines[1]?.summary)).toHaveLength(200);
        expect(lines[2]).toMatchObject({ method: "json(true)", alternative: "jsonb()" });
        expect(JSON.stringify(lines[3])).not.toContain("select");
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
    it("should use the extension-free migration source and the knex_migrations table", () => {
        expect(migrationConfig.tableName).toBe("knex_migrations");
        expect(migrationConfig.migrationSource).toBeInstanceOf(MigrationFiles);
        expect(migrationConfig).not.toHaveProperty("directory");
    });

    it("should list the .ts migrations when running from source and name them without the extension (parity d)", async () => {
        const source = new MigrationFiles();
        const files = await source.getMigrations();
        expect(files).toContain("20260915000000_create_extension_btree_gist.ts");
        expect(files).toEqual([...files].sort());
        expect(files.map((file) => source.getMigrationName(file))).toContain("20260915000000_create_extension_btree_gist");
    });

    it("should give the compiled and the source file the same migration name", () => {
        const fromSource = new MigrationFiles("unused", ".ts");
        const fromDist = new MigrationFiles("unused", ".js");
        expect(fromSource.getMigrationName("20260915000000_create_extension_btree_gist.ts")).toBe(
            fromDist.getMigrationName("20260915000000_create_extension_btree_gist.js"),
        );
    });

    it("should load a migration module with up and down when asked for one", async () => {
        const migration = await new MigrationFiles().getMigration("20260915000000_create_extension_btree_gist.ts");
        expect(typeof migration.up).toBe("function");
        expect(typeof migration.down).toBe("function");
    });
});
