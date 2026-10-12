/**
 * Exponential backoff with bounded jitter: `baseMs * 2^attempt` capped at `capMs`, scaled by 0.8..1.2 (random 0..1) and clamped
 * to the cap again. `attempt` is zero-based. Generic home for every retry delay (ADR 0017).
 */
export function exponentialBackoffMs(baseMs: number, attempt: number, capMs: number, random: () => number = Math.random): number {
    const base = Math.min(baseMs * 2 ** Math.max(0, attempt), capMs);
    return Math.max(0, Math.min(capMs, Math.round(base * (0.8 + 0.4 * random()))));
}

/** Zero-based retry index: first retry waits 200 ms, with bounded jitter. */
export function backoffMs(attempt: number, random: () => number = Math.random, capMs = 60_000): number {
    return exponentialBackoffMs(200, attempt, capMs, random);
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
