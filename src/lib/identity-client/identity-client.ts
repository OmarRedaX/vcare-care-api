import { Pool } from "undici";
import { backoffMs, sleep } from "../async/backoff";
import { getEnv } from "../config/env";
import { logger } from "../logger/logger";
import { isRedisUsable, resolveRedis, withRedis } from "../redis/redis";
import { validateBody } from "../validation/validate";
import { CONTACT_SERVICE_SCOPES } from "./constants";
import { CachedUserDto, ContactsEnvelopeDto, StatusEnvelopeDto, UserContactDto, UsersEnvelopeDto } from "./identity.dto";
import { ServiceTokenCache } from "./service-token-cache";
import type { BatchResult, Contact, ContactsChunkOutcome, ContactsResult, HydratedUser, IdentityClientOptions, IdentityStatus, StatusResult } from "./types";

/** `setUserStatus` answers that are terminal. 404, 401 (after the one token refresh), 429, 5xx, network errors and malformed 200s stay transient. */
const PERMANENT_STATUS_CODES: ReadonlySet<string> = new Set(["HTTP_400", "HTTP_403", "HTTP_422"]);
/** Contacts failures that retrying cannot fix without an operator (credentials or the `users:contact:read` grant): alertable on their own. */
const CONTACTS_FORBIDDEN_CODES: ReadonlySet<string> = new Set(["HTTP_401", "HTTP_403", "InsufficientScope"]);

export class IdentityClient {
    private readonly options: Required<Pick<IdentityClientOptions, "now" | "sleep" | "random">> & IdentityClientOptions;
    private readonly pool: Pool;
    private readonly tokens: ServiceTokenCache;
    /** Separate token for `users:contact:read` (care-worker only); fetches nothing until `getContacts` runs. */
    private readonly contactTokens: ServiceTokenCache;

    constructor(options: IdentityClientOptions = {}) {
        const env = options.env ?? getEnv();
        this.options = { ...options, env, now: options.now ?? Date.now, sleep: options.sleep ?? sleep, random: options.random ?? Math.random };
        this.pool = options.pool ?? new Pool(env.IDENTITY_INTERNAL_URL, { connections: 10 });
        this.tokens = new ServiceTokenCache({ pool: this.pool, env, now: this.options.now });
        this.contactTokens = new ServiceTokenCache({ pool: this.pool, env, now: this.options.now, scopes: CONTACT_SERVICE_SCOPES });
    }

    /** Closes the keep-alive pool (graceful shutdown of care-api / care-worker, and test teardown). */
    close(): Promise<void> { return this.pool.close(); }

    async setUserStatus(userId: number, status: IdentityStatus, reason: string, actorUserId: number, requestId: string, attempts = 3): Promise<StatusResult> {
        let last = "NetworkError";
        let attemptsMade = 0;
        for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
            attemptsMade = attempt + 1;
            if (attempt > 0) await this.options.sleep(backoffMs(attempt - 1, this.options.random));
            try {
                const response = await this.authorizedRequest("PATCH", `/internal/users/${userId}/status`, requestId,
                    JSON.stringify({ status, reason, actorUserId }));
                if (response.statusCode === 200) {
                    try {
                        const envelope = await validateBody(StatusEnvelopeDto, response.body, { unknownMembers: "strip" });
                        if (envelope.data.id !== userId || envelope.data.status !== status || !Number.isFinite(Date.parse(envelope.data.updatedAt))) {
                            last = "MalformedResponse";
                        } else return { outcome: "applied", attemptsMade };
                    } catch { last = "MalformedResponse"; }
                } else if (response.statusCode === 409) {
                    // The provider owns this transition; malformed error bodies are not a safe rejection signal.
                    const payload = response.body;
                    if (typeof payload === "object" && payload !== null && "error" in payload &&
                        typeof payload.error === "object" && payload.error !== null && "code" in payload.error &&
                        payload.error.code === "InvalidStatusTransition") return { outcome: "rejected-transition", attemptsMade };
                    last = "MalformedResponse";
                } else last = `HTTP_${response.statusCode}`;
            } catch (error) { last = this.errorCode(error); }
            if (last.startsWith("HTTP_") && ![404, 429, 500, 502, 503, 504].includes(Number(last.slice(5)))) break;
        }
        // Identity answered "this request can never succeed" (validation, forbidden, unprocessable): retrying cannot fix it.
        if (PERMANENT_STATUS_CODES.has(last)) return { outcome: "permanent", errorCode: last, attemptsMade };
        return { outcome: "transient", errorCode: last, attemptsMade };
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
                    for (const user of envelope.data) users.set(user.id, { displayName: user.fullName, avatarUrl: user.avatarUrl, status: user.status });
                    if (envelope.data.length > 0 && isRedisUsable(redis)) {
                        try {
                            // One round trip for the whole chunk, not one per user.
                            await withRedis(redis, () => {
                                const pipeline = redis.pipeline();
                                for (const user of envelope.data) {
                                    pipeline.setex(`identity:user:${user.id}`, 300, JSON.stringify({ fullName: user.fullName, avatarUrl: user.avatarUrl, status: user.status }));
                                }
                                return pipeline.exec();
                            });
                        } catch { /* Redis is Tier 2. */ }
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

    /**
     * Case 5 (notification contacts, care-worker only): chunks of at most 100, one attempt per chunk, 2 s timeouts. Any failure of a
     * chunk (network, timeout, 4xx/5xx, missing scope, malformed envelope) puts its ids in `unavailable` (the caller delays the rows). A
     * malformed single entry makes only that id `unavailable`. A 401/403/scope failure also emits `notification_contacts_forbidden`.
     * Nothing is cached or stored, and no address or name is ever logged.
     */
    async getContacts(ids: readonly number[], requestId: string): Promise<ContactsResult> {
        const unique = [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && id > 0);
        const result: ContactsResult = { contacts: new Map(), unavailable: new Set() };
        const log = this.options.logger ?? logger;
        for (let offset = 0; offset < unique.length; offset += 100) {
            const chunk = unique.slice(offset, offset + 100);
            const outcome = await this.fetchContactsChunk(chunk, requestId, result);
            if (outcome.failure !== null) {
                for (const id of chunk) result.unavailable.add(id);
                log.warn("notification_contacts_unavailable", { errorCode: outcome.failure, ids: chunk.length });
                log.metric("identity_call_failed", 1, { case: "contacts" });
                if (CONTACTS_FORBIDDEN_CODES.has(outcome.failure)) {
                    log.error("notification_contacts_forbidden", { errorCode: outcome.failure });
                    log.metric("notification_contacts_forbidden", 1, {});
                }
            } else if (outcome.badEntries > 0) {
                log.warn("notification_contacts_unavailable", { errorCode: "MalformedEntry", ids: outcome.badEntries });
                log.metric("identity_call_failed", 1, { case: "contacts" });
            }
        }
        return result;
    }

    /** Adds the chunk's valid contacts to `result` (bad entries go to `unavailable` one by one); a non-null `failure` means the whole chunk failed. */
    private async fetchContactsChunk(chunk: readonly number[], requestId: string, result: ContactsResult): Promise<ContactsChunkOutcome> {
        try {
            const response = await this.authorizedRequest("GET", `/internal/users/contacts?ids=${chunk.join(",")}`, requestId, undefined, this.contactTokens);
            if (response.statusCode !== 200) return { failure: `HTTP_${response.statusCode}`, badEntries: 0 };
            const envelope = await validateBody(ContactsEnvelopeDto, response.body, { unknownMembers: "strip" });
            if (envelope.data.length > 100) return { failure: "MalformedResponse", badEntries: 0 };
            const accepted = new Map<number, Contact>();
            const seen = new Set<number>();
            const bad = new Set<number>();
            for (const raw of envelope.data) {
                const id = this.entryId(raw, chunk);
                // An entry that cannot be attributed to a requested id cannot be isolated: the chunk is malformed.
                if (id === null) return { failure: "MalformedResponse", badEntries: 0 };
                if (seen.has(id)) { bad.add(id); continue; }
                seen.add(id);
                try {
                    const entry = await validateBody(UserContactDto, raw, { unknownMembers: "strip" });
                    accepted.set(id, { email: entry.email, fullName: entry.fullName, locale: entry.locale, status: entry.status });
                } catch { bad.add(id); }
            }
            for (const [id, contact] of accepted) if (!bad.has(id)) result.contacts.set(id, contact);
            for (const id of bad) result.unavailable.add(id);
            return { failure: null, badEntries: bad.size };
        } catch (error) { return { failure: this.errorCode(error), badEntries: 0 }; }
    }

    /** The entry's `id` when it is a requested one, else `null`. */
    private entryId(raw: unknown, chunk: readonly number[]): number | null {
        if (typeof raw !== "object" || raw === null || !("id" in raw)) return null;
        const id = raw.id;
        return typeof id === "number" && chunk.includes(id) ? id : null;
    }

    private async authorizedRequest(method: "GET" | "PATCH", path: string, requestId: string, body?: string, tokens: ServiceTokenCache = this.tokens): Promise<{ statusCode: number; body: unknown }> {
        for (let refresh = 0; refresh < 2; refresh++) {
            const token = await tokens.get(requestId);
            const response = await this.pool.request({ path, method,
                headers: { authorization: `Bearer ${token}`, accept: "application/json", "x-request-id": requestId,
                    ...(body === undefined ? {} : { "content-type": "application/json" }) },
                ...(body === undefined ? {} : { body }), headersTimeout: 2_000, bodyTimeout: 2_000, signal: AbortSignal.timeout(2_000),
            });
            if (response.statusCode === 401 && refresh === 0) {
                await response.body.dump();
                tokens.invalidate(token);
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
        if (error instanceof Error && error.message === "InsufficientScope") return "InsufficientScope";
        if (error instanceof SyntaxError || (error instanceof Error && error.name === "AppError")) return "MalformedResponse";
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "TimeoutError";
        if (error instanceof Error && "code" in error && typeof error.code === "string" &&
            error.code.startsWith("UND_ERR_") && error.code.includes("TIMEOUT")) return "TimeoutError";
        return "NetworkError";
    }
}

export function createIdentityClient(options: IdentityClientOptions = {}): IdentityClient { return new IdentityClient(options); }
