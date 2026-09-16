import { z } from "zod";
import type { Env, EnvSource } from "./types";

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

const ipv4Or6 = z.string().refine((value) => /^[0-9.]+$/.test(value) || /^[0-9a-fA-F:]+$/.test(value), {
    message: "must be an IP address",
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
        DATABASE_URL: urlWithScheme(["postgres:", "postgresql:"], "postgres"),
        DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(20),
        REDIS_URL: urlWithScheme(["redis:", "rediss:"], "redis"),
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

let cached: Env | undefined;

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
            process.stderr.write(
                `${JSON.stringify({
                    level: "error",
                    message: "invalid_environment",
                    timestamp: new Date().toISOString(),
                    service: "care-service",
                    keys: error.keys,
                })}\n`,
            );
            process.exit(1);
        }
        throw error;
    }
}
