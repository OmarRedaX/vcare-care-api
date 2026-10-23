import { baseBucketOf, FREE_MAP_BUCKET_MS, FREE_MAP_BUCKETS, FREE_MAP_BYTES, testFreeMap, toFreeMap } from "../../../../src/pkg/slots/free-map";

describe("availability free map", () => {
    const base = 2_000_000;
    const at = (bucket: number): number => bucket * FREE_MAP_BUCKET_MS;

    it("should encode the version, big-endian base and 168 MSB-first bytes when writing boundary buckets", () => {
        const map = toFreeMap([at(base), at(base + 7), at(base + 8), at(base + 1343), at(base - 1), at(base + 1344)], base);
        expect(map).toHaveLength(FREE_MAP_BYTES);
        expect(map[0]).toBe(1);
        expect([...map.slice(1, 5)]).toEqual([0, 30, 132, 128]);
        expect(map[5]).toBe(0x81);
        expect(map[6]).toBe(0x80);
        expect(map[172]).toBe(0x01);
        expect(baseBucketOf(at(base) + FREE_MAP_BUCKET_MS - 1)).toBe(base);
        expect(testFreeMap(map, at(base), at(base) + 1)).toBe(true);
        expect(testFreeMap(map, at(base) - 1, at(base))).toBe(false);
        expect(testFreeMap(map, at(base + FREE_MAP_BUCKETS), at(base + FREE_MAP_BUCKETS) + 1)).toBe(false);
    });

    it("should match a naive bucket overlap oracle across 500 seeded windows", () => {
        let seed = 0x639fa10d;
        const random = (): number => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0x1_0000_0000; };
        const starts = Array.from({ length: 180 }, () => at(base + Math.floor(random() * 1354) - 5) + Math.floor(random() * FREE_MAP_BUCKET_MS));
        const map = toFreeMap(starts, base);
        const indexed = new Set(starts.map(baseBucketOf).filter((bucket) => bucket >= base && bucket < base + FREE_MAP_BUCKETS));
        for (let i = 0; i < 500; i += 1) {
            const fromMs = at(base + Math.floor(random() * 1360) - 8) + Math.floor(random() * FREE_MAP_BUCKET_MS);
            const toMs = fromMs + 1 + Math.floor(random() * 9 * FREE_MAP_BUCKET_MS);
            const oracle = [...indexed].some((bucket) => at(bucket) < toMs && at(bucket + 1) > fromMs);
            expect(testFreeMap(map, fromMs, toMs)).toBe(oracle);
        }
    });

    it("should reject malformed maps and return false for empty or out-of-range windows", () => {
        const map = toFreeMap([at(base + 2)], base);
        expect(testFreeMap(map.slice(0, -1), at(base), at(base + 3))).toBeUndefined();
        const wrongVersion = map.slice(); wrongVersion[0] = 2;
        expect(testFreeMap(wrongVersion, at(base), at(base + 3))).toBeUndefined();
        expect(testFreeMap(map, at(base), at(base))).toBe(false);
        expect(testFreeMap(map, at(base - 4), at(base))).toBe(false);
        expect(testFreeMap(map, at(base + FREE_MAP_BUCKETS), at(base + FREE_MAP_BUCKETS + 1))).toBe(false);
        expect(testFreeMap(map, at(base + 1), at(base + 2) + 1)).toBe(true);
    });
});
