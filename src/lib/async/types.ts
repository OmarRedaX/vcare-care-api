/** In-process de-duplication of concurrent work per key (see `createSingleFlight`). */
export interface SingleFlight<K, V> {
    /** The in-flight promise for `key` if one exists, otherwise the result of `start()` (registered until it settles). */
    run(key: K, start: () => Promise<V>): Promise<V>;
    /** Registers an already started promise for `key` unless one is in flight; returns the one that wins. Removed when it settles. */
    adopt(key: K, work: Promise<V>): Promise<V>;
    /** Keys currently in flight. */
    size(): number;
}
