import type { LimitResult } from "./types";

/**
 * Per-instance fallback used only while Redis is down. Bounded by `maxKeys` so an attacker cannot grow it
 * without limit; eviction is oldest-inserted first.
 */
export class MemoryLimiter {
    private readonly hits = new Map<string, number[]>();

    constructor(private readonly maxKeys = 10_000) {}

    hit(key: string, limit: number, windowMs: number, nowMs: number): LimitResult {
        const existing = this.hits.get(key) ?? [];
        const window = existing.filter((timestamp) => timestamp > nowMs - windowMs);

        if (window.length >= limit) {
            this.hits.set(key, window);
            return { allowed: false, oldestMs: window[0] ?? nowMs };
        }

        window.push(nowMs);
        this.hits.delete(key);
        this.hits.set(key, window);

        while (this.hits.size > this.maxKeys) {
            const oldestKey = this.hits.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }
            this.hits.delete(oldestKey);
        }

        return { allowed: true, oldestMs: window[0] ?? nowMs };
    }
}
