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
    now?: () => number;
}
export interface RawIdentityResponse { statusCode: number; body: unknown }
