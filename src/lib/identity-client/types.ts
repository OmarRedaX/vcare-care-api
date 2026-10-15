import type Redis from "ioredis";
import type { Pool } from "undici";
import type { Env } from "../config/types";
import type { Logger } from "../logger/logger";

export type IdentityStatus = "active" | "rejected" | "pending" | "suspended";
/**
 * `permanent` = Identity refused the request itself (HTTP 400/403/422): not retryable, treated like `rejected-transition` with the status as error code.
 * `attemptsMade` = HTTP calls actually made (the engine records it, not the requested count).
 */
export type StatusResult =
    | { outcome: "applied"; attemptsMade: number }
    | { outcome: "transient"; errorCode: string; attemptsMade: number }
    | { outcome: "rejected-transition"; attemptsMade: number }
    | { outcome: "permanent"; errorCode: string; attemptsMade: number };
export interface HydratedUser { displayName: string; avatarUrl: string | null; status: IdentityStatus }
/** Notification contact (Case 5): held in worker memory for one batch, never cached, stored or logged. */
export interface Contact { email: string; fullName: string; locale: string; status: IdentityStatus }
/** `unavailable` = the chunk containing the id could not be read (transient: delay the row); an id in neither set is unknown to Identity. */
export interface ContactsResult { contacts: Map<number, Contact>; unavailable: Set<number> }
export interface BatchResult { users: Map<number, HydratedUser>; degraded: boolean }
export interface IdentityClientOptions {
    env?: Env;
    redis?: Redis;
    logger?: Logger;
    pool?: Pool;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
}
export interface ServiceTokenCacheOptions {
    pool: Pool;
    env: Env;
    /** Scopes requested and required in the answer; defaults to the status scopes. */
    scopes?: readonly string[];
    now?: () => number;
}
export interface RawIdentityResponse { statusCode: number; body: unknown }
