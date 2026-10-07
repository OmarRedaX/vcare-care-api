import type Redis from "ioredis";
import type { Pool } from "undici";
import type { Env } from "../config/types";
import type { Logger } from "../logger/logger";

export type IdentityStatus = "active" | "rejected" | "pending" | "suspended";
export type StatusResult = { outcome: "applied" } | { outcome: "transient"; errorCode: string } | { outcome: "rejected-transition" };
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
