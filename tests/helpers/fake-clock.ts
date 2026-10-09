import type { SyncTiming } from "../../src/app/identity-sync/types";

/**
 * Deterministic `SyncTiming` for the identity-sync engine: tests move time with `advance` / `set` instead of sleeping,
 * and `random` is fixed (0.5 = no backoff jitter). It starts at the real current time so it stays comparable with
 * database-stamped columns (`created_at`).
 */
export class FakeClock implements SyncTiming {
    private current: number;

    constructor(start: number = Date.now(), private readonly randomValue = 0.5) { this.current = start; }

    now = (): number => this.current;
    random = (): number => this.randomValue;
    advance(milliseconds: number): number { this.current += milliseconds; return this.current; }
    set(timestamp: number): void { this.current = timestamp; }
}
