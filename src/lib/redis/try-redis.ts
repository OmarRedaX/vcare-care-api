import type Redis from "ioredis";
import { isRedisUsable, withRedis } from "./redis";
import type { RedisOutcome } from "./types";

/** Best-effort Redis command with the shared circuit breaker. */
export async function tryRedis<T>(client: Redis, command: () => Promise<T>): Promise<RedisOutcome<T>> {
    if (!isRedisUsable(client)) return { ok: false };
    try {
        return { ok: true, value: await withRedis(client, command) };
    } catch {
        return { ok: false };
    }
}
