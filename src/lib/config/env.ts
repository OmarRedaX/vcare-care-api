import { isIP } from "node:net";
import { z } from "zod";
import type { Env, EnvSource, MigrationEnv } from "./types";

/** Thrown when the environment is invalid. Carries KEYS ONLY — never values (CLAUDE.md → Security rules). */
export class InvalidEnvError extends Error {
    constructor(readonly keys: string[]) {
        super(`Invalid environment configuration: ${keys.join(", ")}`);
        this.name = "InvalidEnvError";
    }
}

const port = z.coerce.number().int().min(1).max(65535);

const urlWithScheme = (schemes: string[], label: string) =>
    z
        .string()
        .min(1)
        .refine(
            (value) => {
                try {
                    return schemes.includes(new URL(value).protocol);
                } catch {
                    return false;
                }
            },
            { message: `must be a ${label} URL` },
        );

/**
 * Session settings Care sets per pool (spec §3.4.1 / §3.4.8). pg merges the connection string OVER the explicit
 * config, so one of these in `DATABASE_URL` would silently replace `TimeZone=UTC`, a timeout, or the pool's name.
 */
const CARE_OWNED_PG_PARAMS = ["options", "statement_timeout", "query_timeout", "application_name"] as const;

const databaseUrl = urlWithScheme(["postgres:", "postgresql:"], "postgres").refine(
    (value) => {
        let params: URLSearchParams;
        try {
            params = new URL(value).searchParams;
        } catch {
            return true; // already reported by the scheme refine
        }
        return CARE_OWNED_PG_PARAMS.every((name) => !params.has(name));
    },
    { message: `must not set ${CARE_OWNED_PG_PARAMS.join(", ")} — Care sets them per pool` },
);

/** The decoded user name of a postgres URL, or `undefined` when the URL cannot be parsed. */
function databaseUser(value: string): string | undefined {
    try {
        return decodeURIComponent(new URL(value).username);
    } catch {
        return undefined;
    }
}

/** An IPv4 or IPv6 literal — never a host name (the internal listener must bind exactly where configured). */
const ipv4Or6 = z.string().refine((value) => isIP(value) !== 0, {
    message: "must be an IPv4 or IPv6 address",
});

const corsOrigins = z
    .string()
    .default("")
    .transform((value, ctx) => {
        const origins: string[] = [];
        for (const entry of value.split(",").map((part) => part.trim())) {
            if (entry.length === 0) {
                continue;
            }
            let origin: string | null = null;
            try {
                origin = new URL(entry).origin;
            } catch {
                origin = null;
            }
            if (origin === null || origin !== entry) {
                ctx.addIssue({
                    code: "custom",
                    message: "must be a comma-separated list of origins (scheme://host[:port], no path)",
                });
                continue;
            }
            origins.push(origin);
        }
        return origins;
    });

export const envSchema = z
    .object({
        NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
        PORT: port.default(3001),
        INTERNAL_PORT: port.default(3101),
        INTERNAL_HOST: ipv4Or6.default("127.0.0.1"),
        TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
        /** The app login (`care_app`, member of `vcare_app`) for `care-api` and `care-worker` (ADR 0018). */
        DATABASE_URL: databaseUrl,
        /** The owner credential: only `care-migrate` and the integration-test setup need it (ADR 0018). */
        MIGRATION_DATABASE_URL: databaseUrl.optional(),
        DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(20),
        REDIS_URL: urlWithScheme(["redis:", "rediss:"], "redis"),
        /** No default: a wrong default would answer 401 to every request silently (access spec §3.10). */
        IDENTITY_JWKS_URL: urlWithScheme(["http:", "https:"], "http(s)"),
        AUDIT_PARTITION_MONTHS_AHEAD: z.coerce.number().int().min(1).max(12).default(2),
        CORS_ORIGINS: corsOrigins,
        LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
        RATE_LIMIT_FALLBACK_DIVISOR: z.coerce.number().int().min(1).default(2),
        SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
        WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
    })
    .superRefine((value, ctx) => {
        if (value.INTERNAL_PORT === value.PORT) {
            ctx.addIssue({
                code: "custom",
                path: ["INTERNAL_PORT"],
                message: "must differ from PORT",
            });
        }
        if (value.MIGRATION_DATABASE_URL !== undefined) {
            const owner = databaseUser(value.MIGRATION_DATABASE_URL);
            if (owner !== undefined && owner === databaseUser(value.DATABASE_URL)) {
                ctx.addIssue({
                    code: "custom",
                    path: ["MIGRATION_DATABASE_URL"],
                    message: "must use a different role than DATABASE_URL",
                });
            }
        }
        if (value.NODE_ENV === "production" && value.LOG_LEVEL === "debug") {
            ctx.addIssue({
                code: "custom",
                path: ["LOG_LEVEL"],
                message: "debug is not allowed when NODE_ENV is production",
            });
        }
    });

/** Empty strings are treated as unset, so `FOO=` falls back to the default (or fails as missing). */
function withoutEmptyValues(source: EnvSource): EnvSource {
    const cleaned: EnvSource = {};
    for (const [key, value] of Object.entries(source)) {
        if (value !== undefined && value !== "") {
            cleaned[key] = value;
        }
    }
    return cleaned;
}

export function parseEnv(source: EnvSource): Env {
    const result = envSchema.safeParse(withoutEmptyValues(source));
    if (!result.success) {
        const keys = [
            ...new Set(result.error.issues.map((issue) => (issue.path.length > 0 ? issue.path.join(".") : "ENV"))),
        ].sort();
        throw new InvalidEnvError(keys);
    }
    const env: Env = result.data;
    return env;
}

/** `env` narrowed to a migration environment, or throws naming `MIGRATION_DATABASE_URL` (never its value). */
export function parseMigrationEnv(env: Env): MigrationEnv {
    const url = env.MIGRATION_DATABASE_URL;
    if (url === undefined) {
        throw new InvalidEnvError(["MIGRATION_DATABASE_URL"]);
    }
    return { ...env, MIGRATION_DATABASE_URL: url };
}

/** ONE JSON line naming the offending keys (never their values), then exit 1. */
function exitInvalid(error: InvalidEnvError): never {
    process.stderr.write(
        `${JSON.stringify({
            level: "error",
            message: "invalid_environment",
            timestamp: new Date().toISOString(),
            service: "care-service",
            keys: error.keys,
        })}
`,
    );
    process.exit(1);
}

let cached: Env | undefined;
let cachedMigration: MigrationEnv | undefined;

/**
 * Memoized process environment. On invalid env it writes ONE JSON line naming the offending keys
 * (never their values) and exits 1 — the process must not start half-configured.
 */
export function getEnv(): Env {
    if (cached !== undefined) {
        return cached;
    }
    try {
        cached = parseEnv(process.env);
        return cached;
    } catch (error) {
        if (error instanceof InvalidEnvError) {
            exitInvalid(error);
        }
        throw error;
    }
}

/**
 * Memoized environment of `care-migrate`: `getEnv()` plus a required `MIGRATION_DATABASE_URL` (the owner
 * credential). `care-api` and `care-worker` never call it, so they never need the owner secret (ADR 0018).
 */
export function getMigrationEnv(): MigrationEnv {
    if (cachedMigration !== undefined) {
        return cachedMigration;
    }
    try {
        cachedMigration = parseMigrationEnv(getEnv());
        return cachedMigration;
    } catch (error) {
        if (error instanceof InvalidEnvError) {
            exitInvalid(error);
        }
        throw error;
    }
}
