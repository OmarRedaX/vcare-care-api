import type { RequestHandler } from "express";
import type Redis from "ioredis";
import { getEnv } from "../config/env";
import { RateLimited } from "../error/errors";
import { captureRoute, routeLabel } from "../http/route-pattern";
import { logger } from "../logger/logger";
import { isRedisUsable, resolveRedis, withRedis } from "../redis/redis";
import { MemoryLimiter } from "./memory-limiter";
import { SLIDING_WINDOW_LUA } from "./sliding-window.lua";
import type { LimitResult, RateLimitOptions, SlidingWindowRedis } from "./types";

const DEGRADED_LOG_INTERVAL_MS = 60_000;
const scriptedClients = new WeakSet<Redis>();
const lastDegradedLog = new Map<string, number>();

export function fallbackLimit(limit: number, divisor: number): number {
    return Math.max(1, Math.floor(limit / divisor));
}

function ensureScript(client: Redis): SlidingWindowRedis {
    if (!scriptedClients.has(client)) {
        client.defineCommand("slidingWindowHit", { numberOfKeys: 1, lua: SLIDING_WINDOW_LUA });
        scriptedClients.add(client);
    }
    return client as unknown as SlidingWindowRedis;
}

function logDegraded(name: string, nowMs: number): void {
    const last = lastDegradedLog.get(name);
    if (last !== undefined && nowMs - last < DEGRADED_LOG_INTERVAL_MS) {
        return;
    }
    lastDegradedLog.set(name, nowMs);
    logger.warn("rate_limiter_degraded", { limiter: name });
    logger.metric("rate_limiter_degraded", 1, { limiter: name });
}

function retryAfterSeconds(result: LimitResult, windowMs: number, nowMs: number): number {
    const oldest = result.oldestMs ?? nowMs;
    return Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1_000));
}

/**
 * Redis sliding-window limiter with a per-instance fallback (Tier 2). The subject is NEVER logged —
 * IPs and user ids stay out of the limiter log line.
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
    const memory = new MemoryLimiter();
    const onRedisDown = options.onRedisDown ?? "fallback";

    return (req, res, next) => {
        captureRoute(req, res);
        const subject = options.subject(req);
        if (subject === null) {
            next();
            return;
        }

        // `next` runs at most once; an unexpected throw in the async path is forwarded exactly once, or logged when
        // the request already moved on (fix #11).
        let forwarded = false;
        const forward = (error?: unknown): void => {
            if (forwarded) {
                return;
            }
            forwarded = true;
            next(error);
        };
        const fail = (error: unknown): void => {
            if (!forwarded && !res.headersSent) {
                forward(error);
                return;
            }
            logger.error("rate_limit_internal_error", { requestId: req.requestId, limiter: options.name, error });
        };

        const now = options.now?.() ?? Date.now();
        const key = `rl:${options.name}:${subject}`;

        const deny = (result: LimitResult): void => {
            res.setHeader("Retry-After", String(retryAfterSeconds(result, options.windowMs, now)));
            logger.warn("rate_limited", {
                requestId: req.requestId,
                limiter: options.name,
                route: routeLabel(req),
            });
            forward(RateLimited);
        };

        const degrade = (): void => {
            logDegraded(options.name, now);
            if (onRedisDown === "fail-open") {
                forward();
                return;
            }
            const result = memory.hit(
                key,
                fallbackLimit(options.limit, getEnv().RATE_LIMIT_FALLBACK_DIVISOR),
                options.windowMs,
                now,
            );
            if (result.allowed) {
                forward();
                return;
            }
            deny(result);
        };

        // A Redis that is down OR stalled behind an open breaker is not touched (fix #10).
        const client = resolveRedis(options.redis);
        if (!isRedisUsable(client)) {
            degrade();
            return;
        }

        void (async () => {
            let reply: [number, number];
            try {
                reply = await withRedis(client, () =>
                    ensureScript(client).slidingWindowHit(
                        key,
                        String(now),
                        String(options.windowMs),
                        String(options.limit),
                        `${now}-${req.requestId}`,
                    ),
                );
            } catch {
                degrade();
                return;
            }
            const [allowed, oldest] = reply;
            if (allowed === 1) {
                forward();
                return;
            }
            deny({ allowed: false, oldestMs: oldest > 0 ? oldest : null });
        })().catch(fail);
    };
}
