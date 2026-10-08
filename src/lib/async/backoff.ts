/** Zero-based retry index: first retry waits 200 ms, with bounded jitter. */
export function backoffMs(attempt: number, random: () => number = Math.random, capMs = 60_000): number {
    const base = Math.min(200 * 2 ** Math.max(0, attempt), capMs);
    return Math.max(0, Math.min(capMs, Math.round(base * (0.8 + 0.4 * random()))));
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
