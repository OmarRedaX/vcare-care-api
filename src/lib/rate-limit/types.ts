import type { Request } from "express";
import type Redis from "ioredis";

export interface RateLimitOptions {
    name: string;
    limit: number;
    windowMs: number;
    /** `null` skips counting entirely (e.g. an unauthenticated request on a per-user limiter). */
    subject: (req: Request) => string | null;
    onRedisDown?: "fallback" | "fail-open";
    redis?: Redis;
    now?: () => number;
}

export interface LimitResult {
    allowed: boolean;
    /** Score of the oldest hit in the window, used for `Retry-After`. */
    oldestMs: number | null;
}

/** ioredis client with the sliding-window script registered via `defineCommand`. */
export interface SlidingWindowRedis {
    slidingWindowHit(
        key: string,
        now: string,
        windowMs: string,
        limit: string,
        member: string,
    ): Promise<[number, number]>;
}
