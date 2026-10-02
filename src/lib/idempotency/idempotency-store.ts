import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import { withRedis } from "../redis/redis";
import type { IdempotencyDoneRecord, IdempotencyInProgressRecord, IdempotencyReadResult } from "./types";

/** Compare-and-delete: removes the key only while it still holds exactly this value. */
const DELETE_IF_EQUALS = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0`;

const BODY_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * This attempt's in-progress record, serialized once. The random `owner` makes every attempt's value unique, so a
 * compare-and-delete can never remove a lock that another attempt holds.
 */
export function inProgressRecord(bodyHash: string): string {
    const record: IdempotencyInProgressRecord = { state: "in_progress", bodyHash, owner: randomUUID() };
    return JSON.stringify(record);
}

/**
 * Shape guard for a stored value (fix #11): `done` needs a 64-hex `bodyHash`, an integer `status` 100–599, and a
 * `body` member; `in_progress` needs a 64-hex `bodyHash` and a string `owner`. Anything else — including unparsable
 * JSON — is `invalid`, never "absent" (which would answer 409 to every retry until the TTL).
 */
export function parseRecord(raw: string): IdempotencyReadResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { kind: "invalid", raw };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { kind: "invalid", raw };
    }
    const candidate = parsed as Record<string, unknown>;
    const bodyHash = candidate.bodyHash;
    if (typeof bodyHash !== "string" || !BODY_HASH_PATTERN.test(bodyHash)) {
        return { kind: "invalid", raw };
    }
    if (candidate.state === "done") {
        const status = candidate.status;
        if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 && "body" in candidate) {
            const record: IdempotencyDoneRecord = { state: "done", bodyHash, status, body: candidate.body };
            return { kind: "valid", record };
        }
        return { kind: "invalid", raw };
    }
    if (candidate.state === "in_progress" && typeof candidate.owner === "string") {
        return { kind: "valid", record: { state: "in_progress", bodyHash, owner: candidate.owner } };
    }
    return { kind: "invalid", raw };
}

/** Claims the key for this request. `false` means another request already holds it. */
export async function acquireLock(client: Redis, key: string, lockValue: string, lockTtlMs: number): Promise<boolean> {
    const reply = await withRedis(client, () => client.set(key, lockValue, "PX", lockTtlMs, "NX"));
    return reply === "OK";
}

export async function readRecord(client: Redis, key: string): Promise<IdempotencyReadResult> {
    const raw = await withRedis(client, () => client.get(key));
    return raw === null ? { kind: "absent" } : parseRecord(raw);
}

export async function storeResult(
    client: Redis,
    key: string,
    bodyHash: string,
    status: number,
    body: unknown,
    ttlMs: number,
): Promise<void> {
    const record: IdempotencyDoneRecord = { state: "done", bodyHash, status, body };
    await withRedis(client, () => client.set(key, JSON.stringify(record), "PX", ttlMs));
}

/** Deletes `key` only while it still holds exactly `value` (an invalid record that nobody replaced meanwhile). */
export async function deleteIfEquals(client: Redis, key: string, value: string): Promise<void> {
    await withRedis(client, () => client.eval(DELETE_IF_EQUALS, 1, key, value));
}

/**
 * Releases this attempt's lock so the client may retry (5xx / 429 responses are not replayable results), and
 * compensates a `SET NX` that timed out client-side but still landed. Never deletes another attempt's lock.
 */
export async function releaseOwnLock(client: Redis, key: string, lockValue: string): Promise<void> {
    await deleteIfEquals(client, key, lockValue);
}
