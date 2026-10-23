import type Redis from "ioredis";
import { inject, injectable } from "tsyringe";
import type { Env } from "../../../lib/config/types";
import { TOKENS } from "../../../lib/di/tokens";
import type { Logger } from "../../../lib/logger/logger";
import { tryRedis } from "../../../lib/redis/try-redis";
import type { SlotRange } from "../../../pkg/slots/types";
import { SLOT_VERSION_TTL_SECONDS } from "../constants";
import type { SlotCacheVersion } from "../types";

@injectable()
export class NextAvailableIndex {
    private lastWarnAt = 0;
    constructor(@inject(TOKENS.Redis) private readonly redis: Redis,
        @inject(TOKENS.Logger) private readonly logger: Logger,
        @inject(TOKENS.Env) private readonly env: Env) {}

    private warn(message: string): void {
        const now = Date.now();
        if (now - this.lastWarnAt >= 60_000) { this.lastWarnAt = now; this.logger.warn(message); }
    }

    async version(doctorUserId: number): Promise<SlotCacheVersion> {
        const result = await tryRedis(this.redis, () => this.redis.get(`slots-ver:${doctorUserId}`));
        if (!result.ok) { this.warn("availability_cache_unavailable"); return { version: "0", usable: false }; }
        return { version: result.value ?? "0", usable: true };
    }

    private key(doctorUserId: number, version: string, typeId: number, fromDate: string, toDate: string): string {
        return `slots:${doctorUserId}:${version}:${typeId}:${fromDate}:${toDate}`;
    }

    async readSlots(doctorUserId: number, version: string, typeId: number, fromDate: string, toDate: string): Promise<SlotRange[] | undefined> {
        const result = await tryRedis(this.redis, () => this.redis.get(this.key(doctorUserId, version, typeId, fromDate, toDate)));
        if (!result.ok) { this.warn("availability_cache_unavailable"); return undefined; }
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
        if (!result.ok) this.warn("availability_cache_unavailable");
    }

    async invalidate(doctorUserId: number): Promise<void> {
        const member = String(doctorUserId);
        const result = await tryRedis(this.redis, async () => this.redis.multi()
            .incr(`slots-ver:${member}`).expire(`slots-ver:${member}`, SLOT_VERSION_TTL_SECONDS)
            .zrem("next-available:index", member).del(`free-map:${member}`).sadd("next-available:refresh", member).exec());
        if (!result.ok || result.value === null || result.value.some((entry) => entry[0] !== null)) this.warn("availability_listener_skipped");
    }
}
