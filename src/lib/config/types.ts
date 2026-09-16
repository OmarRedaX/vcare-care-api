export type NodeEnv = "development" | "test" | "production";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Env {
    NODE_ENV: NodeEnv;
    PORT: number;
    INTERNAL_PORT: number;
    INTERNAL_HOST: string;
    TRUST_PROXY_HOPS: number;
    DATABASE_URL: string;
    DATABASE_POOL_MAX: number;
    REDIS_URL: string;
    CORS_ORIGINS: string[];
    LOG_LEVEL: LogLevel;
    RATE_LIMIT_FALLBACK_DIVISOR: number;
    SHUTDOWN_TIMEOUT_MS: number;
    WORKER_POLL_INTERVAL_MS: number;
}

export type EnvSource = Record<string, string | undefined>;
