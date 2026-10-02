/**
 * Resolves with `work`'s value, or with `fallback` once `timeoutMs` elapses — whichever comes first. The timer
 * is unref'd (it never holds the process open) and cleared as soon as `work` settles. `work` itself is not
 * cancelled, and a rejection of `work` propagates: catch it first when the caller needs "never throws".
 */
export async function settleWithin<T>(work: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
        timer.unref();
    });

    try {
        return await Promise.race([work, timeout]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}
