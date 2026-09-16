import type Redis from "ioredis";
import type { IdempotencyRecord } from "./types";

/** Claims the key for this request. `false` means another request already holds it. */
export async function acquireLock(
    client: Redis,
    key: string,
    bodyHash: string,
    lockTtlMs: number,
): Promise<boolean> {
    const record: IdempotencyRecord = { state: "in_progress", bodyHash };
    const reply = await client.set(key, JSON.stringify(record), "PX", lockTtlMs, "NX");
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

/** Releases the lock so the client may retry (5xx / 429 responses are not replayable results). */
export async function releaseLock(client: Redis, key: string): Promise<void> {
    await client.del(key);
}
