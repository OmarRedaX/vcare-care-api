export const FREE_MAP_VERSION = 1;
export const FREE_MAP_BUCKET_MS = 900_000;
export const FREE_MAP_BUCKETS = 1344;
export const FREE_MAP_BYTES = 173;

export function baseBucketOf(nowMs: number): number { return Math.floor(nowMs / FREE_MAP_BUCKET_MS); }

/** Derived 14-day bitmap of 15-minute buckets containing a free slot start. */
export function toFreeMap(startsMs: readonly number[], baseBucket: number): Uint8Array {
    const map = new Uint8Array(FREE_MAP_BYTES);
    map[0] = FREE_MAP_VERSION;
    new DataView(map.buffer).setUint32(1, baseBucket, false);
    for (const start of startsMs) {
        const offset = baseBucketOf(start) - baseBucket;
        if (offset >= 0 && offset < FREE_MAP_BUCKETS) map[5 + (offset >> 3)]! |= 0x80 >> (offset & 7);
    }
    return map;
}

export function testFreeMap(map: Uint8Array, fromMs: number, toMs: number): boolean | undefined {
    if (map.length !== FREE_MAP_BYTES || map[0] !== FREE_MAP_VERSION) return undefined;
    if (toMs <= fromMs) return false;
    const base = new DataView(map.buffer, map.byteOffset, map.byteLength).getUint32(1, false);
    const first = Math.max(0, baseBucketOf(fromMs) - base);
    const last = Math.min(FREE_MAP_BUCKETS - 1, baseBucketOf(toMs - 1) - base);
    for (let i = first; i <= last; i += 1) if ((map[5 + (i >> 3)]! & (0x80 >> (i & 7))) !== 0) return true;
    return false;
}
