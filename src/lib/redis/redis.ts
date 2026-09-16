import Redis from "ioredis";
import { getEnv } from "../config/env";
import { logger } from "../logger/logger";
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

export function isRedisReady(client: Redis): boolean {
    return client.status === "ready";
}

/** `PING` bounded by `timeoutMs`; skipped without a round trip when the client is not ready. */
export async function probeRedis(client: Redis, timeoutMs: number): Promise<boolean> {
    if (!isRedisReady(client)) {
        return false;
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
    });

    try {
        return await Promise.race([
            client
                .ping()
                .then((reply) => reply === "PONG")
                .catch(() => false),
            timeout,
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}
