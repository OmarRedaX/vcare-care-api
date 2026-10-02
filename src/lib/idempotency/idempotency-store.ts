import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import type { IdempotencyInProgressRecord, IdempotencyRecord } from "./types";

/** Compare-and-delete: removes the key only while it still holds exactly this attempt's in-progress record. */
const RELEASE_IF_OWNED = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0`;

/**
 * This attempt's in-progress record, serialized once. The random `owner` makes every attempt's value unique, so a
 * compare-and-delete can never remove a lock that another attempt holds.
 */
export function inProgressRecord(bodyHash: string): string {
    const record: IdempotencyInProgressRecord = { state: "in_progress", bodyHash, owner: randomUUID() };
    return JSON.stringify(record);
}

/** Claims the key for this request. `false` means another request already holds it. */
export async function acquireLock(client: Redis, key: string, lockValue: string, lockTtlMs: number): Promise<boolean> {
    const reply = await client.set(key, lockValue, "PX", lockTtlMs, "NX");
    return reply === "OK";
}

export async function readRecord(client: Redis, key: string): Promise<IdempotencyRecord | null> {
    const raw = await client.get(key);
    if (raw === null) {
        return null;
    }
    try {
        return JSON.parse(raw) as IdempotencyRecord;
    } catch {
        return null;
    }
}

export async function storeResult(
    client: Redis,
    key: string,
    bodyHash: string,
    status: number,
    body: unknown,
    ttlMs: number,
): Promise<void> {
    const record: IdempotencyRecord = { state: "done", bodyHash, status, body };
    await client.set(key, JSON.stringify(record), "PX", ttlMs);
}

/**
 * Releases this attempt's lock so the client may retry (5xx / 429 responses are not replayable results), and
 * compensates a `SET NX` that timed out client-side but still landed. Never deletes another attempt's lock.
 */
export async function releaseOwnLock(client: Redis, key: string, lockValue: string): Promise<void> {
    await client.eval(RELEASE_IF_OWNED, 1, key, lockValue);
}
