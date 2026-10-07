export type NodeEnv = "development" | "test" | "production";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Env {
    NODE_ENV: NodeEnv;
    PORT: number;
    INTERNAL_PORT: number;
    INTERNAL_HOST: string;
    TRUST_PROXY_HOPS: number;
    /** The app login (`care_app`). */
    DATABASE_URL: string;
    /** The owner credential; optional here, required by `getMigrationEnv()`. */
    MIGRATION_DATABASE_URL?: string;
    DATABASE_POOL_MAX: number;
    REDIS_URL: string;
    IDENTITY_JWKS_URL: string;
    AUDIT_PARTITION_MONTHS_AHEAD: number;
    CORS_ORIGINS: string[];
    LOG_LEVEL: LogLevel;
    RATE_LIMIT_FALLBACK_DIVISOR: number;
    SHUTDOWN_TIMEOUT_MS: number;
    WORKER_POLL_INTERVAL_MS: number;
    ALLOWED_CURRENCIES: readonly string[];
}

/** The environment of `care-migrate`: the owner URL is required. */
export type MigrationEnv = Env & { MIGRATION_DATABASE_URL: string };

export type EnvSource = Record<string, string | undefined>;
