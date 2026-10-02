import type Redis from "ioredis";
import { logger } from "../logger/logger";
import type { BreakerState, RedisBreakerOptions } from "./types";

/** Consecutive command failures that open the breaker (fix #10; constants, not env). */
export const REDIS_BREAKER_FAILURE_THRESHOLD = 3;
/** How long an open breaker keeps Redis out of the request path before admitting one probe. */
export const REDIS_BREAKER_OPEN_MS = 5_000;

/**
 * Circuit breaker for a Redis that stalls while `status === "ready"` (fix #10). Without it every idempotency and
 * rate-limit command would wait the full 500 ms `commandTimeout`; with it the worst case is `threshold × 500 ms` per
 * `openMs` window per process. The readiness `PING` probe does not feed it.
 *
 * closed → (threshold consecutive failures) → open → (openMs elapsed) → half_open: exactly one caller is admitted;
 * its success closes the breaker, its failure reopens it. A half-open probe that never reports is replaced after
 * another `openMs`, so the breaker can never stay half-open forever.
 */
export class RedisBreaker {
    private current: BreakerState = "closed";
    private consecutiveFailures = 0;
    private openedAt = 0;
    private probeStartedAt = 0;
    private readonly failureThreshold: number;
    private readonly openMs: number;
    private readonly now: () => number;

    constructor(options?: RedisBreakerOptions) {
        this.failureThreshold = options?.failureThreshold ?? REDIS_BREAKER_FAILURE_THRESHOLD;
        this.openMs = options?.openMs ?? REDIS_BREAKER_OPEN_MS;
        this.now = options?.now ?? Date.now;
    }

    get state(): BreakerState {
        return this.current;
    }

    canAttempt(): boolean {
        const now = this.now();
        switch (this.current) {
            case "closed":
                return true;
            case "open":
                if (now - this.openedAt < this.openMs) {
                    return false;
                }
                this.current = "half_open";
                this.probeStartedAt = now;
                return true;
            case "half_open":
                if (now - this.probeStartedAt < this.openMs) {
                    return false;
                }
                this.probeStartedAt = now;
                return true;
        }
    }

    recordSuccess(): void {
        this.consecutiveFailures = 0;
        if (this.current !== "closed") {
            this.current = "closed";
            logger.info("redis_breaker_closed");
        }
    }

    recordFailure(): void {
        this.consecutiveFailures += 1;
        if (this.current === "half_open" || (this.current === "closed" && this.consecutiveFailures >= this.failureThreshold)) {
            this.current = "open";
            this.openedAt = this.now();
            logger.warn("redis_breaker_open", { consecutiveFailures: this.consecutiveFailures });
            logger.metric("redis_breaker_open", 1);
        }
    }
}

const breakers = new WeakMap<Redis, RedisBreaker>();

/** One breaker per client. */
export function breakerFor(client: Redis): RedisBreaker {
    let breaker = breakers.get(client);
    if (breaker === undefined) {
        breaker = new RedisBreaker();
        breakers.set(client, breaker);
    }
    return breaker;
}
