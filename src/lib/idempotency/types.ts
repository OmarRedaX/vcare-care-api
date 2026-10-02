import type Redis from "ioredis";

export interface IdempotencyOptions {
    required: boolean;
    /** Defaults to the container's `TOKENS.Redis`. */
    redis?: Redis;
    /** In-flight marker TTL (default 60 s). */
    lockTtlMs?: number;
    /** Stored-result TTL (default 24 h). */
    ttlMs?: number;
}

export interface IdempotencyInProgressRecord {
    state: "in_progress";
    bodyHash: string;
    /** Random per attempt: lets compare-and-delete release only this attempt's lock. */
    owner: string;
}

export interface IdempotencyDoneRecord {
    state: "done";
    bodyHash: string;
    status: number;
    body: unknown;
}

export type IdempotencyRecord = IdempotencyInProgressRecord | IdempotencyDoneRecord;

/** What a stored idempotency value turned out to be (fix #11): never trusted without the shape guard. */
export type IdempotencyReadResult =
    | { kind: "absent" }
    | { kind: "valid"; record: IdempotencyRecord }
    | { kind: "invalid"; raw: string };
