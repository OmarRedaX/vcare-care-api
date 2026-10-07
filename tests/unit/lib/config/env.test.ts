import { InvalidEnvError, envSchema, parseEnv, parseMigrationEnv } from "../../../../src/lib/config/env";
import type * as EnvModule from "../../../../src/lib/config/env";
import type { EnvSource } from "../../../../src/lib/config/types";

const SECRET_DB = "postgres://synthetic-user:synthetic-pass-9931@localhost:5434/care_test";
const SECRET_REDIS = "redis://:synthetic-redis-pass-4417@localhost:6381/0";
const JWKS_URL = "http://127.0.0.1:1/.well-known/jwks.json";

const secretsOnly = (): EnvSource => ({ DATABASE_URL: SECRET_DB, REDIS_URL: SECRET_REDIS, IDENTITY_JWKS_URL: JWKS_URL });

function captureInvalid(source: EnvSource): InvalidEnvError {
    try {
        parseEnv(source);
    } catch (error) {
        if (error instanceof InvalidEnvError) {
            return error;
        }
        throw error;
    }
    throw new Error("expected parseEnv to throw InvalidEnvError");
}

describe("lib/config/env parseEnv", () => {
    it("should apply defaults when only the secrets are set (F2)", () => {
        expect(parseEnv(secretsOnly())).toEqual({
            NODE_ENV: "development",
            PORT: 3001,
            INTERNAL_PORT: 3101,
            INTERNAL_HOST: "127.0.0.1",
            TRUST_PROXY_HOPS: 0,
            DATABASE_URL: SECRET_DB,
            DATABASE_POOL_MAX: 20,
            REDIS_URL: SECRET_REDIS,
            IDENTITY_JWKS_URL: JWKS_URL,
            AUDIT_PARTITION_MONTHS_AHEAD: 2,
            CORS_ORIGINS: [],
            LOG_LEVEL: "info",
            RATE_LIMIT_FALLBACK_DIVISOR: 2,
            SHUTDOWN_TIMEOUT_MS: 10000,
            WORKER_POLL_INTERVAL_MS: 1000,
            ALLOWED_CURRENCIES: ["EGP"],
        });
    });

    it("should throw InvalidEnvError naming DATABASE_URL when it is missing (F1)", () => {
        const error = captureInvalid({ REDIS_URL: SECRET_REDIS, IDENTITY_JWKS_URL: JWKS_URL });
        expect(error.keys).toEqual(["DATABASE_URL"]);
    });

    it("should throw naming REDIS_URL when it is missing (F2: no default on secrets)", () => {
        expect(captureInvalid({ DATABASE_URL: SECRET_DB, IDENTITY_JWKS_URL: JWKS_URL }).keys).toEqual(["REDIS_URL"]);
    });

    it("should never include a value in the error message when parsing fails (F1)", () => {
        const error = captureInvalid({ ...secretsOnly(), PORT: "not-a-port-synthetic-7781", REDIS_URL: "http://:synthetic-redis-pass-4417@x" });
        const rendered = `${error.message} ${JSON.stringify(error)} ${error.keys.join(",")}`;
        expect(error.keys).toEqual(["PORT", "REDIS_URL"]);
        expect(rendered).not.toContain("not-a-port-synthetic-7781");
        expect(rendered).not.toContain("synthetic-redis-pass-4417");
        expect(rendered).not.toContain("synthetic-pass-9931");
    });

    it("should reject INTERNAL_PORT when it equals PORT", () => {
        expect(captureInvalid({ ...secretsOnly(), PORT: "4000", INTERNAL_PORT: "4000" }).keys).toEqual(["INTERNAL_PORT"]);
    });

    it("should reject LOG_LEVEL debug when NODE_ENV is production", () => {
        expect(captureInvalid({ ...secretsOnly(), NODE_ENV: "production", LOG_LEVEL: "debug" }).keys).toEqual([
            "LOG_LEVEL",
        ]);
        expect(parseEnv({ ...secretsOnly(), NODE_ENV: "development", LOG_LEVEL: "debug" }).LOG_LEVEL).toBe("debug");
    });

    it("should split CORS_ORIGINS when it is comma-separated", () => {
        const env = parseEnv({ ...secretsOnly(), CORS_ORIGINS: "http://localhost:5173, https://app.example.test" });
        expect(env.CORS_ORIGINS).toEqual(["http://localhost:5173", "https://app.example.test"]);
    });

    it.each(["http://localhost:5173/path", "http://localhost:5173/", "not a url"])(
        "should reject a CORS origin when it is %p (path or not an origin)",
        (origin) => {
            expect(captureInvalid({ ...secretsOnly(), CORS_ORIGINS: origin }).keys).toEqual(["CORS_ORIGINS"]);
        },
    );

    it.each(["http://localhost:6379", "localhost:6379", "not a url"])(
        "should reject REDIS_URL when the scheme is not redis or rediss (%p)",
        (url) => {
            expect(captureInvalid({ DATABASE_URL: SECRET_DB, REDIS_URL: url, IDENTITY_JWKS_URL: JWKS_URL }).keys).toEqual(["REDIS_URL"]);
        },
    );

    it("should accept rediss and postgresql schemes when they are used", () => {
        const env = parseEnv({ DATABASE_URL: "postgresql://u:p@db/care", REDIS_URL: "rediss://cache:6380", IDENTITY_JWKS_URL: JWKS_URL });
        expect(env.DATABASE_URL).toBe("postgresql://u:p@db/care");
        expect(env.REDIS_URL).toBe("rediss://cache:6380");
    });

    it("should reject DATABASE_URL when the scheme is not postgres", () => {
        expect(captureInvalid({ DATABASE_URL: "mysql://u:p@db/care", REDIS_URL: SECRET_REDIS, IDENTITY_JWKS_URL: JWKS_URL }).keys).toEqual([
            "DATABASE_URL",
        ]);
    });

    // Review 2026-09-28 (Low): pg merges the URL over the explicit config, so these would replace `TimeZone=UTC`,
    // the timeouts, or the pool name set in lib/knex (spec §3.4.1).
    it.each([
        ["options", "options=-c%20TimeZone%3DAmerica%2FNew_York"],
        ["options (search_path only)", "options=-c%20search_path%3Dcare"],
        ["statement_timeout", "statement_timeout=0"],
        ["query_timeout", "query_timeout=0"],
        ["application_name", "sslmode=require&application_name=psql"],
    ])("should reject DATABASE_URL when its query string sets %s", (_name, query) => {
        const url = `${SECRET_DB}?${query}`;
        const error = captureInvalid({ DATABASE_URL: url, REDIS_URL: SECRET_REDIS, IDENTITY_JWKS_URL: JWKS_URL });
        expect(error.keys).toEqual(["DATABASE_URL"]);
        expect(error.message).not.toContain("synthetic-pass-9931");

        const result = envSchema.safeParse({ DATABASE_URL: url, REDIS_URL: SECRET_REDIS, IDENTITY_JWKS_URL: JWKS_URL });
        expect(result.success).toBe(false);
        expect(result.error?.issues.map((issue) => issue.message)).toEqual([
            "must not set options, statement_timeout, query_timeout, application_name — Care sets them per pool",
        ]);
    });

    it("should accept DATABASE_URL when its query string carries only other parameters", () => {
        const url = `${SECRET_DB}?sslmode=require&sslrootcert=%2Fetc%2Fssl%2Frds.pem`;
        expect(parseEnv({ DATABASE_URL: url, REDIS_URL: SECRET_REDIS, IDENTITY_JWKS_URL: JWKS_URL }).DATABASE_URL).toBe(url);
    });

    it("should treat an empty string as unset when a default exists", () => {
        const env = parseEnv({ ...secretsOnly(), PORT: "", LOG_LEVEL: "", CORS_ORIGINS: "" });
        expect(env.PORT).toBe(3001);
        expect(env.LOG_LEVEL).toBe("info");
        expect(env.CORS_ORIGINS).toEqual([]);
    });

    it("should treat an empty secret as missing when it has no default", () => {
        expect(captureInvalid({ DATABASE_URL: "", REDIS_URL: SECRET_REDIS, IDENTITY_JWKS_URL: JWKS_URL }).keys).toEqual(["DATABASE_URL"]);
    });

    it.each([
        ["PORT", "0"],
        ["PORT", "65536"],
        ["TRUST_PROXY_HOPS", "6"],
        ["DATABASE_POOL_MAX", "101"],
        ["RATE_LIMIT_FALLBACK_DIVISOR", "0"],
        ["SHUTDOWN_TIMEOUT_MS", "999"],
        ["SHUTDOWN_TIMEOUT_MS", "60001"],
        ["WORKER_POLL_INTERVAL_MS", "99"],
        ["NODE_ENV", "staging"],
        ["LOG_LEVEL", "trace"],
        ["INTERNAL_HOST", "not-an-ip"],
    ])("should reject %s when it is %p", (key, value) => {
        expect(captureInvalid({ ...secretsOnly(), [key]: value }).keys).toEqual([key]);
    });

    // Regression (was known bug 3): any run of digits/dots or hex/colons used to pass, so "999.999.999.999" and "cafe"
    // failed only later at listen(). INTERNAL_HOST must now be an IPv4 or IPv6 literal (spec §3.4.1).
    it.each(["999.999.999.999", "cafe", "1.2.3", "localhost", "::g"])(
        "should reject INTERNAL_HOST when it is not a valid IP address (%p)",
        (host) => {
            expect(captureInvalid({ ...secretsOnly(), INTERNAL_HOST: host }).keys).toEqual(["INTERNAL_HOST"]);
        },
    );

    it("should accept IPv4 and IPv6 INTERNAL_HOST values when they are valid", () => {
        expect(parseEnv({ ...secretsOnly(), INTERNAL_HOST: "0.0.0.0" }).INTERNAL_HOST).toBe("0.0.0.0");
        expect(parseEnv({ ...secretsOnly(), INTERNAL_HOST: "::1" }).INTERNAL_HOST).toBe("::1");
    });

    it("should coerce numeric strings when numbers are expected", () => {
        const env = parseEnv({ ...secretsOnly(), PORT: "8080", TRUST_PROXY_HOPS: "2", SHUTDOWN_TIMEOUT_MS: "2000" });
        expect(env.PORT).toBe(8080);
        expect(env.TRUST_PROXY_HOPS).toBe(2);
        expect(env.SHUTDOWN_TIMEOUT_MS).toBe(2000);
    });
});

describe("lib/config/env getEnv", () => {
    it("should write one invalid_environment line naming keys only and exit 1 when the process env is invalid (F1)", () => {
        const saved = { ...process.env };
        const stderr = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
        const exit = jest.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
            throw new Error(`exit:${String(code)}`);
        });
        try {
            process.env.DATABASE_URL = "mysql://synthetic-user:synthetic-pass-9931@db/care";
            jest.isolateModules(() => {
                // A fresh module instance, so the memoized env of the test process is not reused.
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fresh = require("../../../../src/lib/config/env") as typeof EnvModule;
                expect(() => fresh.getEnv()).toThrow("exit:1");
            });
            expect(exit).toHaveBeenCalledWith(1);
            expect(stderr).toHaveBeenCalledTimes(1);
            const line = JSON.parse(String(stderr.mock.calls[0]?.[0])) as Record<string, unknown>;
            expect(line).toMatchObject({
                level: "error",
                message: "invalid_environment",
                service: "care-service",
                keys: ["DATABASE_URL"],
            });
            expect(JSON.stringify(line)).not.toContain("synthetic-pass-9931");
        } finally {
            process.env = saved;
            stderr.mockRestore();
            exit.mockRestore();
        }
    });
});

describe("lib/config/env — access variables (spec §3.10)", () => {
    const OWNER_DB = "postgres://synthetic-owner:synthetic-owner-pass-3302@localhost:5434/care_test";

    it("should require IDENTITY_JWKS_URL (no default)", () => {
        expect(captureInvalid({ DATABASE_URL: SECRET_DB, REDIS_URL: SECRET_REDIS }).keys).toEqual(["IDENTITY_JWKS_URL"]);
        expect(captureInvalid({ ...secretsOnly(), IDENTITY_JWKS_URL: "" }).keys).toEqual(["IDENTITY_JWKS_URL"]);
    });

    it.each(["ftp://identity.example.test/jwks", "file:///etc/jwks.json", "identity.example.test/jwks", "not a url"])(
        "should reject a non-http(s) IDENTITY_JWKS_URL (%p)",
        (url) => {
            expect(captureInvalid({ ...secretsOnly(), IDENTITY_JWKS_URL: url }).keys).toEqual(["IDENTITY_JWKS_URL"]);
        },
    );

    it("should accept http and https IDENTITY_JWKS_URL values", () => {
        for (const url of ["http://localhost:3000/.well-known/jwks.json", "https://identity.example.test/.well-known/jwks.json"]) {
            expect(parseEnv({ ...secretsOnly(), IDENTITY_JWKS_URL: url }).IDENTITY_JWKS_URL).toBe(url);
        }
    });

    it("should accept a missing MIGRATION_DATABASE_URL in envSchema and require it in parseMigrationEnv", () => {
        const env = parseEnv(secretsOnly());
        expect(env.MIGRATION_DATABASE_URL).toBeUndefined();
        let error: unknown;
        try {
            parseMigrationEnv(env);
        } catch (caught) {
            error = caught;
        }
        expect(error).toBeInstanceOf(InvalidEnvError);
        expect((error as InvalidEnvError).keys).toEqual(["MIGRATION_DATABASE_URL"]);

        const migration = parseMigrationEnv(parseEnv({ ...secretsOnly(), MIGRATION_DATABASE_URL: OWNER_DB }));
        expect(migration.MIGRATION_DATABASE_URL).toBe(OWNER_DB);
    });

    it("should reject MIGRATION_DATABASE_URL when it uses the same user as DATABASE_URL (A14)", () => {
        const sameUser = "postgres://synthetic-user:other-pass@db.example.test:5432/care";
        const error = captureInvalid({ ...secretsOnly(), MIGRATION_DATABASE_URL: sameUser });
        expect(error.keys).toEqual(["MIGRATION_DATABASE_URL"]);
        expect(error.message).not.toContain("other-pass");
        const result = envSchema.safeParse({ ...secretsOnly(), MIGRATION_DATABASE_URL: sameUser });
        expect(result.error?.issues.map((issue) => issue.message)).toEqual(["must use a different role than DATABASE_URL"]);

        // URL-encoding does not hide the collision.
        const encoded = "postgres://synthetic%2Duser:x@db/care";
        expect(captureInvalid({ ...secretsOnly(), MIGRATION_DATABASE_URL: encoded }).keys).toEqual(["MIGRATION_DATABASE_URL"]);
    });

    it.each([
        ["a non-postgres scheme", "mysql://synthetic-owner:p@db/care"],
        ["options in the query string", `${OWNER_DB}?options=-c%20TimeZone%3DUTC`],
        ["application_name in the query string", `${OWNER_DB}?application_name=psql`],
    ])("should apply the same refines to MIGRATION_DATABASE_URL (%s)", (_label, url) => {
        expect(captureInvalid({ ...secretsOnly(), MIGRATION_DATABASE_URL: url }).keys).toEqual(["MIGRATION_DATABASE_URL"]);
    });

    it("should bound AUDIT_PARTITION_MONTHS_AHEAD to 1..12 and default it to 2", () => {
        expect(parseEnv(secretsOnly()).AUDIT_PARTITION_MONTHS_AHEAD).toBe(2);
        expect(parseEnv({ ...secretsOnly(), AUDIT_PARTITION_MONTHS_AHEAD: "1" }).AUDIT_PARTITION_MONTHS_AHEAD).toBe(1);
        expect(parseEnv({ ...secretsOnly(), AUDIT_PARTITION_MONTHS_AHEAD: "12" }).AUDIT_PARTITION_MONTHS_AHEAD).toBe(12);
        for (const value of ["0", "13", "1.5", "two"]) {
            expect(captureInvalid({ ...secretsOnly(), AUDIT_PARTITION_MONTHS_AHEAD: value }).keys).toEqual([
                "AUDIT_PARTITION_MONTHS_AHEAD",
            ]);
        }
    });
});
