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
    OUTBOX_POLL_SECONDS: number;
    OUTBOX_BATCH_SIZE: number;
    OUTBOX_MAX_ATTEMPTS: number;
    OUTBOX_RETENTION_DAYS: number;
    OUTBOX_PURGE_SECONDS: number;
    REMINDER_SCAN_SECONDS: number;
    BOOKING_HORIZON_DAYS: number;
    SLOT_CACHE_TTL_SECONDS: number;
    AVAILABILITY_SWEEP_INTERVAL_SECONDS: number;
    AVAILABILITY_NAME_REFRESH_SECONDS: number;
    AVAILABILITY_INLINE_MISS_CAP: number;
    CANCELLATION_POLICY_MINUTES: number;
    NO_SHOW_GRACE_MINUTES: number;
    WAITING_ROOM_OPEN_MINUTES: number;
    SESSION_OVERRUN_MINUTES: number;
    VIDEO_PROVIDER: "fake";
    /** SECRET: signs the fake provider join tokens; never logged. */
    VIDEO_PROVIDER_KEY: string;
    VIDEO_JOIN_TOKEN_TTL_SECONDS: number;
    /** Notification email adapter (ADR 0030): `log` records a send and sends nothing (refused in production); `resend` calls Resend. */
    EMAIL_PROVIDER: "log" | "resend";
    /** SECRET (Resend API key): required for `resend`, never logged, no default. */
    EMAIL_PROVIDER_API_KEY?: string;
    /** Sender address for `resend`; must be on a domain verified in Resend (or `onboarding@resend.dev` for a first local test). */
    EMAIL_PROVIDER_FROM?: string;
    EMAIL_PROVIDER_BASE_URL: string;
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
