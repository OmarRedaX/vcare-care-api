import type { SingleFlight } from "./types";

/**
 * Collapses concurrent work for one key into a single promise within this process. The entry is removed when the promise
 * settles (success or failure), so a later call starts fresh work. There is no result cache: it is de-duplication, not memoization.
 */
export function createSingleFlight<K, V>(): SingleFlight<K, V> {
    const inFlight = new Map<K, Promise<V>>();
    const adopt = (key: K, work: Promise<V>): Promise<V> => {
        const existing = inFlight.get(key);
        if (existing !== undefined) return existing;
        const tracked = work.finally(() => { if (inFlight.get(key) === tracked) inFlight.delete(key); });
        inFlight.set(key, tracked);
        return tracked;
    };
    return {
        run: (key, start) => inFlight.get(key) ?? adopt(key, start()),
        adopt,
        size: () => inFlight.size,
    };
}
