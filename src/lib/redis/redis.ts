import Redis from "ioredis";
import { settleWithin } from "../async/settle-within";
import { getEnv } from "../config/env";
import { container } from "../di/container";
import { TOKENS } from "../di/tokens";
import { logger } from "../logger/logger";
import { breakerFor } from "./breaker";
import type { CreateRedisOptions } from "./types";

/**
 * Redis is Tier 2 (ADR 0006): its loss degrades idempotency and rate limiting but never fails a request
 * or readiness. `enableOfflineQueue: false` makes commands fail fast while down so the fallback paths
 * engage immediately instead of queueing.
 */
export function createRedis(url: string, options?: CreateRedisOptions): Redis {
    const client = new Redis(url, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 2_000,
        commandTimeout: 500,
        retryStrategy: (attempt: number) => Math.min(attempt * 200, 2_000),
        // Never replay a command that was on the wire when the connection dropped: its request has long given up
        // (an idempotency SET NX would strand a lock; a rate-limit hit would be counted twice).
        autoResendUnfulfilledCommands: false,
        ...(options?.name !== undefined ? { connectionName: options.name } : {}),
    });

    // One line per transition — never one per failed command.
    let healthy = false;
    client.on("ready", () => {
        if (!healthy) {
            healthy = true;
            logger.info("redis_recovered");
        }
    });
    client.on("error", (error: Error) => {
        if (healthy) {
            healthy = false;
            logger.warn("redis_unavailable", { error });
        }
    });

    return client;
}

export const redis: Redis = createRedis(getEnv().REDIS_URL, { name: "care-api" });

/** Client for Redis-backed middleware: an explicit override (tests), else the container's, else the root client. */
export function resolveRedis(override?: Redis): Redis {
    if (override !== undefined) {
        return override;
    }
    return container.isRegistered(TOKENS.Redis) ? container.resolve<Redis>(TOKENS.Redis) : redis;
}

export function isRedisReady(client: Redis): boolean {
    return client.status === "ready";
}

/**
 * Ready AND its breaker admits a command (fix #10). Request-path middleware (idempotency, rate limit) checks this
 * instead of `isRedisReady`, so a Redis that stalls while connected stops costing a command timeout per request.
 */
export function isRedisUsable(client: Redis): boolean {
    return isRedisReady(client) && breakerFor(client).canAttempt();
}

/** Runs one Redis command and reports its outcome to the client's breaker. Every request-path command goes through it. */
export async function withRedis<T>(client: Redis, command: () => Promise<T>): Promise<T> {
    const breaker = breakerFor(client);
    try {
        const result = await command();
        breaker.recordSuccess();
        return result;
    } catch (error) {
        breaker.recordFailure();
        throw error;
    }
}

/** Graceful `QUIT`, falling back to a hard disconnect when the connection is already gone. */
export async function closeRedis(client: Redis = redis): Promise<void> {
    try {
        await client.quit();
    } catch {
        client.disconnect();
    }
}

/** `PING` bounded by `timeoutMs`; skipped without a round trip when the client is not ready. */
export async function probeRedis(client: Redis, timeoutMs: number): Promise<boolean> {
    if (!isRedisReady(client)) {
        return false;
    }
    return settleWithin(
        client
            .ping()
            .then((reply) => reply === "PONG")
            .catch(() => false),
        timeoutMs,
        false,
    );
}
