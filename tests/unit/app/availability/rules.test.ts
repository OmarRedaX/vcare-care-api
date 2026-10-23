// Rules covered: AV-R15 (fee range, name), AV-R16 (window), AV-R17 (order, keyset), AV-R18 (window shortcut), AV-R20 (effective kind).
import { NONE_SCORE } from "../../../../src/app/availability/constants";
import { DiscoveryCursorKind, SearchSortKind, WindowMatchVerdict } from "../../../../src/app/availability/enums";
import {
    applyCursor, assertFeeRange, cursorValueOf, effectiveKind, matchBySchedule, orderCandidates, resolveNamePrefix, resolveSearchWindow,
} from "../../../../src/app/availability/rules";
import type { Candidate } from "../../../../src/app/doctors/types";
import { baseBucketOf, FREE_MAP_BUCKET_MS, FREE_MAP_BUCKETS, testFreeMap, toFreeMap } from "../../../../src/pkg/slots/free-map";

const NOW = Date.UTC(2027, 0, 4, 8, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();

function detailsOf(action: () => unknown): Array<{ field: string; issue: string }> {
    try { action(); } catch (error) { return (error as { details: Array<{ field: string; issue: string }> }).details; }
    throw new Error("expected a ValidationFailed");
}

describe("resolveSearchWindow (AV-R16)", () => {
    it("should return no window when neither bound is supplied", () => {
        expect(resolveSearchWindow(undefined, undefined, NOW)).toBeUndefined();
    });

    it("should default a missing availableFrom to now", () => {
        expect(resolveSearchWindow(undefined, iso(NOW + 2 * DAY), NOW)).toEqual({ fromMs: NOW, toMs: NOW + 2 * DAY });
    });

    it("should default a missing availableTo to availableFrom plus 14 days clipped to now plus 14 days (D8)", () => {
        expect(resolveSearchWindow(iso(NOW + DAY), undefined, NOW)).toEqual({ fromMs: NOW + DAY, toMs: NOW + 14 * DAY });
        expect(resolveSearchWindow(iso(NOW), undefined, NOW)).toEqual({ fromMs: NOW, toMs: NOW + 14 * DAY });
    });

    it("should accept both bounds exactly at now and at now plus 14 days", () => {
        expect(resolveSearchWindow(iso(NOW), iso(NOW + 14 * DAY), NOW)).toEqual({ fromMs: NOW, toMs: NOW + 14 * DAY });
    });

    it("should reject a supplied availableFrom in the past or beyond 14 days, naming the field", () => {
        expect(detailsOf(() => resolveSearchWindow(iso(NOW - 1), undefined, NOW))).toEqual([{ field: "availableFrom", issue: "must be between now and 14 days from now" }]);
        expect(detailsOf(() => resolveSearchWindow(iso(NOW + 14 * DAY + 1), undefined, NOW))[0]?.field).toBe("availableFrom");
    });

    it("should reject a supplied availableTo in the past or beyond 14 days, naming the field", () => {
        expect(detailsOf(() => resolveSearchWindow(undefined, iso(NOW - 1), NOW))[0]?.field).toBe("availableTo");
        expect(detailsOf(() => resolveSearchWindow(undefined, iso(NOW + 14 * DAY + 1), NOW))[0]?.field).toBe("availableTo");
    });

    it("should reject availableTo that is not after availableFrom", () => {
        expect(detailsOf(() => resolveSearchWindow(iso(NOW + 2 * HOUR), iso(NOW + 2 * HOUR), NOW))[0]?.field).toBe("availableTo");
        expect(detailsOf(() => resolveSearchWindow(iso(NOW + 2 * HOUR), iso(NOW + HOUR), NOW))[0]?.field).toBe("availableTo");
    });

    it("should reject an empty derived window when availableFrom alone is exactly now plus 14 days", () => {
        expect(detailsOf(() => resolveSearchWindow(iso(NOW + 14 * DAY), undefined, NOW))[0]?.field).toBe("availableFrom");
    });

    it("should reject a value that is not an ISO datetime with offset", () => {
        expect(detailsOf(() => resolveSearchWindow("tomorrow", undefined, NOW))[0]?.field).toBe("availableFrom");
    });
});

describe("assertFeeRange (AV-R15)", () => {
    it("should reject minFee above maxFee naming minFee and accept equal or partial bounds", () => {
        expect(detailsOf(() => assertFeeRange(200, 100))[0]?.field).toBe("minFee");
        expect(() => assertFeeRange(100, 100)).not.toThrow();
        expect(() => assertFeeRange(undefined, 100)).not.toThrow();
        expect(() => assertFeeRange(100, undefined)).not.toThrow();
    });
});

describe("resolveNamePrefix (AV-R15, AV-R27 headline term)", () => {
    it("should be undefined when no name is supplied", () => {
        expect(resolveNamePrefix(undefined)).toBeUndefined();
    });

    it("should trim, collapse whitespace, normalise to NFC and lower-case", () => {
        expect(resolveNamePrefix("  Dr.   ANNA \t Smith ")).toBe("dr. anna smith");
        expect(resolveNamePrefix("Café")).toBe("café");
    });

    it("should reject a name shorter than two code points after normalisation, but count an astral character once", () => {
        expect(detailsOf(() => resolveNamePrefix("  a  "))[0]?.field).toBe("name");
        expect(detailsOf(() => resolveNamePrefix("ا"))[0]?.field).toBe("name");
        expect(resolveNamePrefix("\u{1F600}\u{1F600}")).toBe("\u{1F600}\u{1F600}");
    });
});

describe("effectiveKind (AV-R20)", () => {
    it.each([
        [SearchSortKind.EarliestAvailability, true, DiscoveryCursorKind.Earliest],
        [SearchSortKind.EarliestAvailability, false, DiscoveryCursorKind.Degraded],
        [SearchSortKind.Price, true, DiscoveryCursorKind.Price],
        [SearchSortKind.Price, false, DiscoveryCursorKind.Price],
        [SearchSortKind.Experience, true, DiscoveryCursorKind.Experience],
        [SearchSortKind.Experience, false, DiscoveryCursorKind.Experience],
    ])("should map sort %s with a usable index %s to %s", (sort, usable, expected) => {
        expect(effectiveKind(sort, usable)).toBe(expected);
    });
});

const candidate = (profileId: number, fee: number, years: number): Candidate => ({ profileId, userId: profileId + 1000, fee, years });
const POOL: Candidate[] = [candidate(1, 300, 5), candidate(2, 100, 9), candidate(3, 100, 9), candidate(4, 200, 1), candidate(5, 300, 5), candidate(6, 50, 20)];
const scoresOf = (entries: Record<number, number>): Map<number, number> => new Map(Object.entries(entries).map(([profileId, score]) => [Number(profileId) + 1000, score]));

describe("orderCandidates (AV-R17)", () => {
    it("should order earliest by score then profile id, ranking unknown and known-none doctors last by id", () => {
        const scores = scoresOf({ 1: NOW + 5, 2: NOW + 1, 3: NOW + 1, 4: NONE_SCORE });
        expect(orderCandidates(POOL, DiscoveryCursorKind.Earliest, scores).map((c) => c.profileId)).toEqual([2, 3, 1, 4, 5, 6]);
    });

    it("should order price and degraded by fee then id ascending", () => {
        const expected = [6, 2, 3, 4, 1, 5];
        expect(orderCandidates(POOL, DiscoveryCursorKind.Price, new Map()).map((c) => c.profileId)).toEqual(expected);
        expect(orderCandidates(POOL, DiscoveryCursorKind.Degraded, new Map()).map((c) => c.profileId)).toEqual(expected);
    });

    it("should order experience by years then id descending", () => {
        expect(orderCandidates(POOL, DiscoveryCursorKind.Experience, new Map()).map((c) => c.profileId)).toEqual([6, 3, 2, 5, 1, 4]);
    });

    it("should not mutate its input", () => {
        const copy = [...POOL];
        orderCandidates(POOL, DiscoveryCursorKind.Price, new Map());
        expect(POOL).toEqual(copy);
    });
});

describe("applyCursor (AV-R17)", () => {
    const scores = scoresOf({ 1: NOW + 5, 2: NOW + 1, 3: NOW + 1, 4: NONE_SCORE });
    it.each([DiscoveryCursorKind.Earliest, DiscoveryCursorKind.Price, DiscoveryCursorKind.Degraded, DiscoveryCursorKind.Experience])(
        "should return exactly the items after the cursor position for kind %s, at every position including ties", (kind) => {
            const ordered = orderCandidates(POOL, kind, scores);
            expect(applyCursor(ordered, kind, scores, null)).toEqual(ordered);
            ordered.forEach((item, position) => {
                const after = { k: kind, v: cursorValueOf(item, kind, scores), id: item.profileId };
                expect(applyCursor(ordered, kind, scores, after)).toEqual(ordered.slice(position + 1));
            });
        });

    it("should use the none score as the cursor value of a doctor without an index entry", () => {
        expect(cursorValueOf(candidate(5, 1, 1), DiscoveryCursorKind.Earliest, new Map())).toBe(NONE_SCORE);
    });
});

describe("matchBySchedule (AV-R18, spec 12.2.2)", () => {
    const window = { fromMs: NOW + 2 * DAY, toMs: NOW + 3 * DAY };
    it("should never match a known-none doctor", () => {
        expect(matchBySchedule(NONE_SCORE, window)).toBe(WindowMatchVerdict.NoMatch);
    });

    it("should not match a first start in a bucket after the window, without a map", () => {
        expect(matchBySchedule(window.toMs, window)).toBe(WindowMatchVerdict.NoMatch);
        expect(matchBySchedule(window.toMs + DAY, window)).toBe(WindowMatchVerdict.NoMatch);
    });

    it("should match a first start inside the window buckets, without a map", () => {
        expect(matchBySchedule(window.fromMs, window)).toBe(WindowMatchVerdict.Match);
        expect(matchBySchedule(window.toMs - 1, window)).toBe(WindowMatchVerdict.Match);
    });

    it("should need the map when the first start is before the window", () => {
        expect(matchBySchedule(NOW + HOUR, window)).toBe(WindowMatchVerdict.NeedsMap);
    });

    it("should agree with map-only evaluation whenever it settles a window, across 500 seeded cases", () => {
        let seed = 0x1234abcd;
        const random = (): number => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0x1_0000_0000; };
        const base = baseBucketOf(NOW);
        let settled = 0;
        for (let i = 0; i < 500; i += 1) {
            const starts = Array.from({ length: 1 + Math.floor(random() * 12) }, () => NOW + 1 + Math.floor(random() * (FREE_MAP_BUCKETS * FREE_MAP_BUCKET_MS - 2)));
            const map = toFreeMap(starts, base);
            const fromMs = NOW + Math.floor(random() * 13 * DAY);
            const probe = { fromMs, toMs: fromMs + 1 + Math.floor(random() * 2 * DAY) };
            const verdict = matchBySchedule(Math.min(...starts), probe);
            if (verdict === WindowMatchVerdict.NeedsMap) continue;
            settled += 1;
            expect(testFreeMap(map, probe.fromMs, probe.toMs)).toBe(verdict === WindowMatchVerdict.Match);
        }
        expect(settled).toBeGreaterThan(50);
    });
});
