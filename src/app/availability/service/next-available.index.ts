import type Redis from "ioredis";
import { inject, injectable } from "tsyringe";
import type { Env } from "../../../lib/config/types";
import { TOKENS } from "../../../lib/di/tokens";
import type { Logger } from "../../../lib/logger/logger";
import { isRedisUsable } from "../../../lib/redis/redis";
import { tryRedis } from "../../../lib/redis/try-redis";
import { FREE_MAP_BYTES, FREE_MAP_VERSION } from "../../../pkg/slots/free-map";
import type { SlotRange } from "../../../pkg/slots/types";
import {
    FREE_MAP_TTL_SECONDS, LOG_CACHE_UNAVAILABLE, LOG_FREEMAP_INVALID, LOG_LISTENER_SKIPPED, MAP_READ_CHUNK, SLOT_VERSION_TTL_SECONDS,
} from "../constants";
import { freeMapKey, INDEX_KEY, REFRESH_KEY, SWEPT_AT_KEY, versionKey } from "../keys";
import { WRITE_NEXT_AVAILABLE_LUA } from "../lua";
import type { ComputedEntry, GuardedWriteCommands, IndexWriteVerdict, SlotCacheVersion } from "../types";

/**
 * The one place that touches the module's Redis keys (availability spec 12.1.4 and 12.2.3). Every command goes through `tryRedis`
 * (usable check, breaker accounting, swallow); a failed or skipped command yields `undefined` / `{ usable: false }` and the caller degrades.
 */
@injectable()
export class NextAvailableIndex {
    private lastWarnAt = 0;
    private writeCommandDefined = false;
    constructor(@inject(TOKENS.Redis) private readonly redis: Redis,
        @inject(TOKENS.Logger) private readonly logger: Logger,
        @inject(TOKENS.Env) private readonly env: Env) {}

    private warn(message: string): void {
        const now = Date.now();
        if (now - this.lastWarnAt >= 60_000) { this.lastWarnAt = now; this.logger.warn(message); }
    }

    /** Ready and the breaker admits a command: the per-request decision of AV-R20. */
    isUsable(): boolean { return isRedisUsable(this.redis); }

    // ── slots cache (slice 1) ────────────────────────────────────────────────────────────────────────────────────────────────

    async version(doctorUserId: number): Promise<SlotCacheVersion> {
        const result = await tryRedis(this.redis, () => this.redis.get(versionKey(doctorUserId)));
        if (!result.ok) { this.warn(LOG_CACHE_UNAVAILABLE); return { version: "0", usable: false }; }
        return { version: result.value ?? "0", usable: true };
    }

    private key(doctorUserId: number, version: string, typeId: number, fromDate: string, toDate: string): string {
        return `slots:${doctorUserId}:${version}:${typeId}:${fromDate}:${toDate}`;
    }

    async readSlots(doctorUserId: number, version: string, typeId: number, fromDate: string, toDate: string): Promise<SlotRange[] | undefined> {
        const result = await tryRedis(this.redis, () => this.redis.get(this.key(doctorUserId, version, typeId, fromDate, toDate)));
        if (!result.ok) { this.warn(LOG_CACHE_UNAVAILABLE); return undefined; }
        if (result.value === null) return undefined;
        try {
            const parsed: unknown = JSON.parse(result.value);
            if (!Array.isArray(parsed) || !parsed.every((pair) => Array.isArray(pair) && pair.length === 2 &&
                Number.isFinite(pair[0]) && Number.isFinite(pair[1]) && pair[1] > pair[0])) return undefined;
            return parsed.map((pair: [number, number]) => ({ startMs: pair[0], endMs: pair[1] }));
        } catch { return undefined; }
    }

    async writeSlots(doctorUserId: number, version: string, typeId: number, fromDate: string, toDate: string, slots: readonly SlotRange[]): Promise<void> {
        const value = JSON.stringify(slots.map((slot) => [slot.startMs, slot.endMs]));
        const result = await tryRedis(this.redis, () => this.redis.set(this.key(doctorUserId, version, typeId, fromDate, toDate), value, "EX", this.env.SLOT_CACHE_TTL_SECONDS));
        if (!result.ok) this.warn(LOG_CACHE_UNAVAILABLE);
    }

    async invalidate(doctorUserId: number): Promise<void> {
        const member = String(doctorUserId);
        const result = await tryRedis(this.redis, async () => this.redis.multi()
            .incr(versionKey(member)).expire(versionKey(member), SLOT_VERSION_TTL_SECONDS)
            .zrem(INDEX_KEY, member).del(freeMapKey(member)).sadd(REFRESH_KEY, member).exec());
        if (!result.ok || result.value === null || result.value.some((entry) => entry[0] !== null)) this.warn(LOG_LISTENER_SKIPPED);
    }

    // ── rank index and free-map (slice 2) ────────────────────────────────────────────────────────────────────────────────────

    /** Rank-index scores of the given doctors (`null` = absent), one `ZMSCORE`; `undefined` when Redis failed. */
    async scores(userIds: readonly number[]): Promise<Map<number, number | null> | undefined> {
        const scores = new Map<number, number | null>();
        if (userIds.length === 0) return scores;
        const result = await tryRedis(this.redis, () => this.redis.zmscore(INDEX_KEY, userIds.map(String)));
        if (!result.ok) { this.warn(LOG_CACHE_UNAVAILABLE); return undefined; }
        userIds.forEach((id, position) => {
            const raw = result.value[position];
            const score = raw === null || raw === undefined ? Number.NaN : Number(raw);
            scores.set(id, Number.isFinite(score) ? score : null);
        });
        return scores;
    }

    /** Free-maps of the given doctors in chunks of 500 (`null` = absent or invalid layout, which is also logged); `undefined` when Redis failed. */
    async maps(userIds: readonly number[]): Promise<Map<number, Uint8Array | null> | undefined> {
        const maps = new Map<number, Uint8Array | null>();
        for (let offset = 0; offset < userIds.length; offset += MAP_READ_CHUNK) {
            const chunk = userIds.slice(offset, offset + MAP_READ_CHUNK);
            const result = await tryRedis(this.redis, () => this.redis.mgetBuffer(chunk.map(freeMapKey)));
            if (!result.ok) { this.warn(LOG_CACHE_UNAVAILABLE); return undefined; }
            chunk.forEach((id, position) => {
                const value = result.value[position];
                if (value === null || value === undefined) { maps.set(id, null); return; }
                if (value.length !== FREE_MAP_BYTES || value[0] !== FREE_MAP_VERSION) { this.logger.warn(LOG_FREEMAP_INVALID); maps.set(id, null); return; }
                maps.set(id, new Uint8Array(value));
            });
        }
        return maps;
    }

    /** `slots-ver` snapshot of the given doctors (absent = `"0"`); `undefined` when Redis failed. Read before loading inputs. */
    async versions(userIds: readonly number[]): Promise<Map<number, string> | undefined> {
        const versions = new Map<number, string>();
        for (let offset = 0; offset < userIds.length; offset += MAP_READ_CHUNK) {
            const chunk = userIds.slice(offset, offset + MAP_READ_CHUNK);
            const result = await tryRedis(this.redis, () => this.redis.mget(chunk.map(versionKey)));
            if (!result.ok) { this.warn(LOG_CACHE_UNAVAILABLE); return undefined; }
            chunk.forEach((id, position) => versions.set(id, result.value[position] ?? "0"));
        }
        return versions;
    }

    /**
     * Version-guarded writes (one pipeline): a verdict per entry in input order. `stored` = written; `rejected` = a concurrent invalidation won
     * (the entry is discarded and the doctor is already in the refresh set); `failed` = the command errored. `undefined` when the whole pipeline failed.
     */
    async writeEntries(entries: readonly ComputedEntry[]): Promise<IndexWriteVerdict[] | undefined> {
        if (entries.length === 0) return [];
        if (!this.writeCommandDefined) {
            this.redis.defineCommand("writeNextAvailable", { numberOfKeys: 3, lua: WRITE_NEXT_AVAILABLE_LUA });
            this.writeCommandDefined = true;
        }
        const result = await tryRedis(this.redis, async () => {
            const pipeline = this.redis.pipeline();
            const guarded = pipeline as unknown as GuardedWriteCommands;
            for (const entry of entries) {
                guarded.writeNextAvailable(versionKey(entry.userId), INDEX_KEY, freeMapKey(entry.userId), entry.ver ?? "0",
                    String(entry.userId), String(entry.score), Buffer.from(entry.map), FREE_MAP_TTL_SECONDS);
            }
            return pipeline.exec();
        });
        if (!result.ok || result.value === null) { this.warn(LOG_CACHE_UNAVAILABLE); return undefined; }
        return result.value.map(([error, reply]): IndexWriteVerdict => error !== null ? "failed" : reply === 1 ? "stored" : "rejected");
    }

    /** Drops doctors from the index and deletes their free-maps; returns false when Redis failed. */
    async remove(userIds: readonly number[]): Promise<boolean> {
        for (let offset = 0; offset < userIds.length; offset += MAP_READ_CHUNK) {
            const chunk = userIds.slice(offset, offset + MAP_READ_CHUNK);
            const result = await tryRedis(this.redis, async () => this.redis.multi().zrem(INDEX_KEY, ...chunk.map(String)).del(...chunk.map(freeMapKey)).exec());
            if (!result.ok) { this.warn(LOG_CACHE_UNAVAILABLE); return false; }
        }
        return true;
    }

    /** Every member of the rank index (sweep only); `undefined` when Redis failed. */
    async members(): Promise<number[] | undefined> {
        const result = await tryRedis(this.redis, () => this.redis.zrange(INDEX_KEY, 0, -1));
        if (!result.ok) { this.warn(LOG_CACHE_UNAVAILABLE); return undefined; }
        return result.value.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
    }

    /** Pops up to `count` doctors from the refresh set (atomic, so concurrent loops never share one); `undefined` when Redis failed. */
    async popRefresh(count: number): Promise<number[] | undefined> {
        const result = await tryRedis(this.redis, () => this.redis.spop(REFRESH_KEY, count));
        if (!result.ok) { this.warn(LOG_CACHE_UNAVAILABLE); return undefined; }
        return result.value.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
    }

    /** Puts doctors back in the refresh set; returns false when Redis failed (the sweep then covers them). */
    async requeue(userIds: readonly number[]): Promise<boolean> {
        if (userIds.length === 0) return true;
        const result = await tryRedis(this.redis, () => this.redis.sadd(REFRESH_KEY, userIds.map(String)));
        if (!result.ok) this.warn(LOG_CACHE_UNAVAILABLE);
        return result.ok;
    }

    async refreshDepth(): Promise<number | undefined> {
        const result = await tryRedis(this.redis, () => this.redis.scard(REFRESH_KEY));
        return result.ok ? result.value : undefined;
    }

    /** A full sweep finished: the stamp has no TTL (alerting reads its age). Returns false when Redis failed. */
    async markSwept(epochMs: number): Promise<boolean> {
        const result = await tryRedis(this.redis, () => this.redis.set(SWEPT_AT_KEY, String(epochMs)));
        if (!result.ok) this.warn(LOG_CACHE_UNAVAILABLE);
        return result.ok;
    }

    /** Epoch ms of the last full sweep, `null` when never stamped, `undefined` when Redis failed. */
    async readSweptAt(): Promise<number | null | undefined> {
        const result = await tryRedis(this.redis, () => this.redis.get(SWEPT_AT_KEY));
        if (!result.ok) return undefined;
        const value = result.value === null ? Number.NaN : Number(result.value);
        return Number.isFinite(value) ? value : null;
    }
}
