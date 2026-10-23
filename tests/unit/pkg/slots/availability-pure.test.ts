import { DateTime } from "luxon";
import { subtractBusy } from "../../../../src/pkg/slots/busy";
import { computeSlots } from "../../../../src/pkg/slots/compute";
import { baseBucketOf, FREE_MAP_BYTES, testFreeMap, toFreeMap } from "../../../../src/pkg/slots/free-map";
import { localInstant } from "../../../../src/pkg/slots/instant";
import { resolveOpenIntervals } from "../../../../src/pkg/slots/resolve-open-intervals";
import { firstFreeStart, sliceSlots } from "../../../../src/pkg/slots/slice";
import { isSlotOnGrid } from "../../../../src/pkg/slots/slot-fit";
import type { ExceptionRule, UtcInterval, WeeklyHoursRule } from "../../../../src/pkg/slots/types";
import { clipWindow } from "../../../../src/pkg/slots/window";

const ms = (iso: string): number => DateTime.fromISO(iso, { setZone: true }).toMillis();

describe("availability slot maths (AV-R3, AV-R5, AV-R6)", () => {
    it("should retain the grid anchor when busy blocks an off-grid middle", () => {
        const open = [{ date: "2027-01-04", intervals: [{ startMs: 0, endMs: 180 * 60_000 }] }];
        const segments = subtractBusy(open, [{ startMs: 40 * 60_000, endMs: 65 * 60_000 }]);
        expect(segments).toEqual([{ anchorMs: 0, startMs: 0, endMs: 40 * 60_000 }, { anchorMs: 0, startMs: 65 * 60_000, endMs: 180 * 60_000 }]);
        expect(sliceSlots(segments, 30, { fromMs: 0, toMs: 180 * 60_000 }).map((x) => x.startMs / 60_000)).toEqual([0, 90, 120, 150]);
        expect(firstFreeStart(segments, 30, { fromMs: 65 * 60_000, toMs: 180 * 60_000 })).toBe(90 * 60_000);
        expect(open[0]?.intervals[0]?.startMs).toBe(0);
    });

    it("should respect split shifts, exclusive start bounds, and an end after to", () => {
        const segments = [{ anchorMs: 0, startMs: 0, endMs: 60 }, { anchorMs: 80, startMs: 80, endMs: 140 }];
        expect(() => sliceSlots(segments, 1 / 60, { fromMs: 0, toMs: 50 })).toThrow(RangeError);
        const minuteSegments = segments.map((x) => ({ anchorMs: x.anchorMs * 60_000, startMs: x.startMs * 60_000, endMs: x.endMs * 60_000 }));
        expect(sliceSlots(minuteSegments, 30, { fromMs: 1, toMs: 85 * 60_000 }).map((x) => x.startMs / 60_000)).toEqual([30, 80]);
        expect(firstFreeStart(minuteSegments, 30, { fromMs: 1, toMs: 85 * 60_000 })).toBe(30 * 60_000);
    });

    it("should clip past and future windows to the nearest bound", () => {
        expect(clipWindow(-20, -10, 0, 100)).toEqual({ fromMs: 0, toMs: 0, empty: true });
        expect(clipWindow(110, 120, 0, 100)).toEqual({ fromMs: 100, toMs: 100, empty: true });
        expect(clipWindow(-20, 120, 0, 100)).toEqual({ fromMs: 0, toMs: 100, empty: false });
    });

    it("should resolve exceptions and DST transitions without duplicate UTC starts", () => {
        const weekly: WeeklyHoursRule[] = [{ weekday: 7, intervals: [{ startMinute: 0, endMinute: 360 }] }];
        const from = ms("2027-03-14T00:00:00-05:00");
        const to = ms("2027-03-14T06:00:00-04:00");
        const slots = computeSlots({ timezone: "America/New_York", weekly, exceptions: [], busy: [], durationMinutes: 30, bounds: { fromMs: from, toMs: to } });
        expect(slots.length).toBe(10);
        expect(new Set(slots.map((slot) => slot.startMs)).size).toBe(slots.length);
        expect(slots.every((slot) => slot.endMs - slot.startMs === 30 * 60_000)).toBe(true);
        const fallFrom = ms("2027-11-07T00:00:00-04:00");
        const fallTo = ms("2027-11-07T06:00:00-05:00");
        const fall = computeSlots({ timezone: "America/New_York", weekly, exceptions: [], busy: [], durationMinutes: 30, bounds: { fromMs: fallFrom, toMs: fallTo } });
        expect(fall.length).toBe(14);
        const off: ExceptionRule[] = [{ date: "2027-03-14", type: "day_off", startMinute: null, endMinute: null }];
        expect(computeSlots({ timezone: "America/New_York", weekly, exceptions: off, busy: [], durationMinutes: 30, bounds: { fromMs: from, toMs: to } })).toEqual([]);
    });

    it("should encode and test free-map buckets at their exact edges", () => {
        const base = baseBucketOf(ms("2027-01-01T00:00:00Z"));
        const start = base * 900_000 + 900_000;
        const map = toFreeMap([start], base);
        expect(map.length).toBe(FREE_MAP_BYTES);
        expect(map[0]).toBe(1);
        expect(map[5]).toBe(0x40);
        expect(testFreeMap(map, start, start + 1)).toBe(true);
        expect(testFreeMap(map, start - 900_000, start)).toBe(false);
        expect(testFreeMap(map, start + 900_000, start + 1_800_000)).toBe(false);
        expect(testFreeMap(new Uint8Array(172), start, start + 1)).toBeUndefined();
    });
});

describe("seeded booking parity property (AV-R3)", () => {
    it("should list exactly the production-bookable whole-minute starts in 500 generated cases", () => {
        let seed = 0x87ac12fe;
        const random = (): number => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0x1_0000_0000; };
        const zones = ["UTC", "Africa/Cairo", "America/New_York", "Europe/London", "Asia/Kolkata", "Australia/Lord_Howe", "America/St_Johns"];
        const durations = [5, 10, 15, 20, 30, 45, 60, 90, 240];
        for (let caseNo = 0; caseNo < 500; caseNo += 1) {
            const timezone = zones[caseNo % zones.length]!;
            const durationMinutes = durations[Math.floor(random() * durations.length)]!;
            const date = caseNo % 2 === 0 ? "2027-03-14" : "2027-11-07";
            const weekday = DateTime.fromISO(date, { zone: timezone }).weekday;
            const weekly: WeeklyHoursRule[] = [{ weekday, intervals: [{ startMinute: 0, endMinute: 360 }, { startMinute: 600, endMinute: caseNo % 3 === 0 ? 1440 : 900 }] }];
            const exceptions: ExceptionRule[] = caseNo % 13 === 0 ? [{ date, type: "custom_hours", startMinute: 540, endMinute: 780 }] : [];
            const fromMs = localInstant(date, 0, timezone, "start");
            const toMs = fromMs + 18 * 60 * 60_000;
            const now = fromMs + Math.floor(random() * 90) * 60_000;
            const window = clipWindow(fromMs, toMs, now, now + 60 * 86_400_000);
            const busy: UtcInterval[] = Array.from({ length: 3 }, () => { const startMs = fromMs + Math.floor(random() * 12 * 60) * 60_000; return { startMs, endMs: startMs + (5 + Math.floor(random() * 100)) * 60_000 }; });
            const bounds = { fromMs: Math.max(window.fromMs, now + 1), toMs: window.toMs };
            const listed = computeSlots({ timezone, weekly, exceptions, busy, durationMinutes, bounds });
            const days = resolveOpenIntervals({ timezone, weekly, exceptions, fromDate: date, toDate: date });
            const starts = new Set(listed.map((slot) => slot.startMs));
            for (let minute = fromMs; minute < toMs; minute += 60_000) {
                const oracle = minute > now && minute >= window.fromMs && minute < window.toMs &&
                    isSlotOnGrid(days, minute, durationMinutes) && !busy.some((range) => minute < range.endMs && minute + durationMinutes * 60_000 > range.startMs);
                if (starts.has(minute) !== oracle) throw new Error(`booking parity mismatch in generated case ${caseNo}`);
            }
        }
    });
});
