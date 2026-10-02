export interface CreateRedisOptions {
    /** Connection name reported by `CLIENT LIST` — helps identify pools in production. */
    name?: string;
}

export type BreakerState = "closed" | "open" | "half_open";

export interface RedisBreakerOptions {
    /** Consecutive failures that open the breaker (default `REDIS_BREAKER_FAILURE_THRESHOLD`). */
    failureThreshold?: number;
    /** Open period before one half-open probe is admitted (default `REDIS_BREAKER_OPEN_MS`). */
    openMs?: number;
    now?: () => number;
}
