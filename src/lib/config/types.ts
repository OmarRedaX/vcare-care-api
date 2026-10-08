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
    IDENTITY_INTERNAL_URL: string;
    SERVICE_CLIENT_ID: string;
    SERVICE_CLIENT_SECRET: string;
    STORAGE_BUCKET: string;
    STORAGE_REGION: string;
    STORAGE_ENDPOINT?: string;
    STORAGE_ACCESS_KEY_ID?: string;
    STORAGE_SECRET_ACCESS_KEY?: string;
    STORAGE_FORCE_PATH_STYLE: boolean;
    UPLOAD_POLICY_TTL_SECONDS: number;
    UPLOAD_INTENT_TTL_SECONDS: number;
    DOWNLOAD_URL_TTL_SECONDS: number;
    IDENTITY_SYNC_POLL_SECONDS: number;
    IDENTITY_SYNC_RETRY_CAP_SECONDS: number;
    IDENTITY_SYNC_ALERT_AFTER_SECONDS: number;
    UPLOAD_INTENT_PURGE_SECONDS: number;
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
