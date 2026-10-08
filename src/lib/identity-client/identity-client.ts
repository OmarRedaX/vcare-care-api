import { Pool } from "undici";
import { backoffMs, sleep } from "../async/backoff";
import { getEnv } from "../config/env";
import { logger } from "../logger/logger";
import { isRedisUsable, resolveRedis, withRedis } from "../redis/redis";
import { validateBody } from "../validation/validate";
import { CachedUserDto, StatusEnvelopeDto, UsersEnvelopeDto } from "./identity.dto";
import { ServiceTokenCache } from "./service-token-cache";
import type { BatchResult, HydratedUser, IdentityClientOptions, IdentityStatus, StatusResult } from "./types";

export class IdentityClient {
    private readonly options: Required<Pick<IdentityClientOptions, "now" | "sleep" | "random">> & IdentityClientOptions;
    private readonly pool: Pool;
    private readonly tokens: ServiceTokenCache;

    constructor(options: IdentityClientOptions = {}) {
        const env = options.env ?? getEnv();
        this.options = { ...options, env, now: options.now ?? Date.now, sleep: options.sleep ?? sleep, random: options.random ?? Math.random };
        this.pool = options.pool ?? new Pool(env.IDENTITY_INTERNAL_URL, { connections: 10 });
        this.tokens = new ServiceTokenCache({ pool: this.pool, env, now: this.options.now });
    }

    /** Closes the keep-alive pool (graceful shutdown of care-api / care-worker, and test teardown). */
    close(): Promise<void> { return this.pool.close(); }

    async setUserStatus(userId: number, status: IdentityStatus, reason: string, actorUserId: number, requestId: string, attempts = 3): Promise<StatusResult> {
        let last = "NetworkError";
        for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
            if (attempt > 0) await this.options.sleep(backoffMs(attempt - 1, this.options.random));
            try {
                const response = await this.authorizedRequest("PATCH", `/internal/users/${userId}/status`, requestId,
                    JSON.stringify({ status, reason, actorUserId }));
                if (response.statusCode === 200) {
                    try {
                        const envelope = await validateBody(StatusEnvelopeDto, response.body, { unknownMembers: "strip" });
                        if (envelope.data.id !== userId || envelope.data.status !== status || !Number.isFinite(Date.parse(envelope.data.updatedAt))) {
                            last = "MalformedResponse";
                        } else return { outcome: "applied" };
                    } catch { last = "MalformedResponse"; }
                } else if (response.statusCode === 409) {
                    // The provider owns this transition; malformed error bodies are not a safe rejection signal.
                    const payload = response.body;
                    if (typeof payload === "object" && payload !== null && "error" in payload &&
                        typeof payload.error === "object" && payload.error !== null && "code" in payload.error &&
                        payload.error.code === "InvalidStatusTransition") return { outcome: "rejected-transition" };
                    last = "MalformedResponse";
                } else last = `HTTP_${response.statusCode}`;
            } catch (error) { last = this.errorCode(error); }
            if (last.startsWith("HTTP_") && ![404, 429, 500, 502, 503, 504].includes(Number(last.slice(5)))) break;
        }
        return { outcome: "transient", errorCode: last };
    }

    async getUsersBatch(ids: number[], requestId: string): Promise<BatchResult> {
        const unique = [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && id > 0);
        const users = new Map<number, HydratedUser>();
        if (unique.length === 0) return { users, degraded: false };
        const redis = resolveRedis(this.options.redis);
        let misses = unique;
        if (isRedisUsable(redis)) {
            try {
                const values = await withRedis(redis, () => redis.mget(...unique.map((id) => `identity:user:${id}`)));
                misses = [];
                for (let index = 0; index < unique.length; index++) {
                    const id = unique[index];
                    const value = values[index];
                    if (id === undefined) continue;
                    if (value === null || value === undefined) { misses.push(id); continue; }
                    try {
                        const cached = await validateBody(CachedUserDto, JSON.parse(value) as unknown, { unknownMembers: "reject" });
                        users.set(id, { displayName: cached.fullName, avatarUrl: cached.avatarUrl, status: cached.status });
                    } catch { misses.push(id); }
                }
            } catch { misses = unique; }
        }
        let degraded = false;
        for (let offset = 0; offset < misses.length; offset += 100) {
            const chunk = misses.slice(offset, offset + 100);
            let done = false;
            for (let attempt = 0; attempt < 2 && !done; attempt++) {
                if (attempt > 0) await this.options.sleep(backoffMs(0, this.options.random));
                try {
                    const response = await this.authorizedRequest("GET", `/internal/users?ids=${chunk.join(",")}`, requestId);
                    if (response.statusCode !== 200) continue;
                    const envelope = await validateBody(UsersEnvelopeDto, response.body, { unknownMembers: "strip" });
                    if (envelope.data.length > 100 || envelope.data.some((user) => !chunk.includes(user.id))) continue;
                    for (const user of envelope.data) {
                        users.set(user.id, { displayName: user.fullName, avatarUrl: user.avatarUrl, status: user.status });
                        if (isRedisUsable(redis)) {
                            try {
                                await withRedis(redis, () => redis.setex(`identity:user:${user.id}`, 300,
                                    JSON.stringify({ fullName: user.fullName, avatarUrl: user.avatarUrl, status: user.status })));
                            } catch { /* Redis is Tier 2. */ }
                        }
                    }
                    done = true;
                } catch { /* Retry once, then degrade. */ }
            }
            if (!done) degraded = true;
        }
        if (degraded) {
            (this.options.logger ?? logger).warn("identity_hydration_degraded", { requestId });
            (this.options.logger ?? logger).metric("identity_hydration_degraded", 1);
        }
        return { users, degraded };
    }

    private async authorizedRequest(method: "GET" | "PATCH", path: string, requestId: string, body?: string): Promise<{ statusCode: number; body: unknown }> {
        for (let refresh = 0; refresh < 2; refresh++) {
            const token = await this.tokens.get(requestId);
            const response = await this.pool.request({ path, method,
                headers: { authorization: `Bearer ${token}`, accept: "application/json", "x-request-id": requestId,
                    ...(body === undefined ? {} : { "content-type": "application/json" }) },
                ...(body === undefined ? {} : { body }), headersTimeout: 2_000, bodyTimeout: 2_000, signal: AbortSignal.timeout(2_000),
            });
            if (response.statusCode === 401 && refresh === 0) {
                await response.body.dump();
                this.tokens.invalidate(token);
                continue;
            }
            let parsed: unknown;
            try { parsed = await response.body.json(); }
            catch { parsed = null; }
            return { statusCode: response.statusCode, body: parsed };
        }
        throw new Error("HTTP_401");
    }

    private errorCode(error: unknown): string {
        if (error instanceof Error && /^HTTP_\d{3}$/.test(error.message)) return error.message;
        if (error instanceof SyntaxError || (error instanceof Error && error.name === "AppError")) return "MalformedResponse";
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "TimeoutError";
        if (error instanceof Error && "code" in error && typeof error.code === "string" &&
            error.code.startsWith("UND_ERR_") && error.code.includes("TIMEOUT")) return "TimeoutError";
        return "NetworkError";
    }
}

export function createIdentityClient(options: IdentityClientOptions = {}): IdentityClient { return new IdentityClient(options); }
