import Redis from "ioredis";
import { redis } from "../../src/lib/redis/redis";

/** Connects the app's lazy client (the server does this at boot) and waits until it reports `ready`. */
export async function ensureRedisReady(client: Redis = redis): Promise<void> {
    if (client.status === "wait") {
        await client.connect();
    }
    if (client.status !== "ready") {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`redis not ready (status ${client.status})`)), 5_000);
            client.once("ready", () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
}

/** Deletes only this suite's keys — never `KEYS` and never `FLUSHALL`. */
export async function flushByPrefix(prefixes: string[] = ["idem:", "rl:"], client: Redis = redis): Promise<void> {
    if (client.status !== "ready") {
        await client.connect();
    }

    for (const prefix of prefixes) {
        let cursor = "0";
        do {
            const [next, keys] = await client.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 500);
            cursor = next;
            if (keys.length > 0) {
                await client.unlink(...keys);
            }
        } while (cursor !== "0");
    }
}

/** A client that can never connect — used for the Tier 2 "Redis is down" scenarios. */
export function createUnreachableRedis(): Redis {
    return new Redis("redis://127.0.0.1:1", {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 200,
        commandTimeout: 200,
        retryStrategy: () => null,
    });
}

export { closeRedis } from "../../src/lib/redis/redis";
