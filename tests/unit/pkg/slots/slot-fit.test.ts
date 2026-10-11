import { isCoveredByOpenIntervals, isSlotOnGrid } from "../../../../src/pkg/slots/slot-fit";
import { resolveOpenIntervals } from "../../../../src/pkg/slots/resolve-open-intervals";
import type { OpenDay, ResolveOpenIntervalsInput } from "../../../../src/pkg/slots/types";

const ms = (iso: string): number => Date.parse(iso);
const day = (date: string, ...intervals: Array<[string, string]>): OpenDay => ({
    date, intervals: intervals.map(([start, end]) => ({ startMs: ms(start), endMs: ms(end) })),
});
const resolve = (input: Partial<ResolveOpenIntervalsInput> & Pick<ResolveOpenIntervalsInput, "timezone" | "fromDate" | "toDate">): OpenDay[] =>
    resolveOpenIntervals({ weekly: [], exceptions: [], ...input });

describe("isSlotOnGrid", () => {
    const morning = [day("2030-01-01", ["2030-01-01T09:00:00Z", "2030-01-01T12:00:00Z"])];

    it("should accept every grid point anchored on the interval start", () => {
        for (const start of ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30"]) {
            expect(isSlotOnGrid(morning, ms(`2030-01-01T${start}:00Z`), 30)).toBe(true);
        }
    });

    it("should reject an off-grid start, a slot ending past the interval, and a start before it", () => {
        expect(isSlotOnGrid(morning, ms("2030-01-01T09:15:00Z"), 30)).toBe(false);
        expect(isSlotOnGrid(morning, ms("2030-01-01T11:45:00Z"), 30)).toBe(false);
        expect(isSlotOnGrid(morning, ms("2030-01-01T12:00:00Z"), 30)).toBe(false);
        expect(isSlotOnGrid(morning, ms("2030-01-01T08:30:00Z"), 30)).toBe(false);
    });

    it("should step by the duration so a 45 minute type has its own grid", () => {
        expect(isSlotOnGrid(morning, ms("2030-01-01T09:45:00Z"), 45)).toBe(true);
        expect(isSlotOnGrid(morning, ms("2030-01-01T10:30:00Z"), 45)).toBe(true);
        expect(isSlotOnGrid(morning, ms("2030-01-01T10:00:00Z"), 45)).toBe(false);
        expect(isSlotOnGrid(morning, ms("2030-01-01T11:15:00Z"), 45)).toBe(true);
        expect(isSlotOnGrid(morning, ms("2030-01-01T11:30:00Z"), 45)).toBe(false);
    });

    it("should anchor each split shift on its own start", () => {
        const split = [day("2030-01-01", ["2030-01-01T09:00:00Z", "2030-01-01T10:00:00Z"], ["2030-01-01T10:20:00Z", "2030-01-01T11:20:00Z"])];
        expect(isSlotOnGrid(split, ms("2030-01-01T10:20:00Z"), 30)).toBe(true);
        expect(isSlotOnGrid(split, ms("2030-01-01T10:50:00Z"), 30)).toBe(true);
        expect(isSlotOnGrid(split, ms("2030-01-01T10:30:00Z"), 30)).toBe(false);
        expect(isSlotOnGrid(split, ms("2030-01-01T10:00:00Z"), 30)).toBe(false);
    });

    it("should not let a slot straddle two intervals or two dates", () => {
        const twoDays = [day("2030-01-01", ["2030-01-01T22:00:00Z", "2030-01-02T00:00:00Z"]), day("2030-01-02", ["2030-01-02T00:00:00Z", "2030-01-02T02:00:00Z"])];
        expect(isSlotOnGrid(twoDays, ms("2030-01-01T23:30:00Z"), 30)).toBe(true);
        expect(isSlotOnGrid(twoDays, ms("2030-01-01T23:45:00Z"), 30)).toBe(false);
    });

    it("should be false for no open day, an empty interval list, or an invalid duration", () => {
        expect(isSlotOnGrid([], ms("2030-01-01T09:00:00Z"), 30)).toBe(false);
        expect(isSlotOnGrid([day("2030-01-01")], ms("2030-01-01T09:00:00Z"), 30)).toBe(false);
        expect(isSlotOnGrid(morning, ms("2030-01-01T09:00:00Z"), 0)).toBe(false);
        expect(isSlotOnGrid(morning, ms("2030-01-01T09:00:00Z"), 1.5)).toBe(false);
        expect(isSlotOnGrid(morning, Number.NaN, 30)).toBe(false);
    });

    it("should honour custom hours and a 24:00 end through resolveOpenIntervals", () => {
        const days = resolve({
            timezone: "UTC", fromDate: "2030-01-07", toDate: "2030-01-07",
            weekly: [{ weekday: 1, intervals: [{ startMinute: 0, endMinute: 1440 }] }],
            exceptions: [{ date: "2030-01-07", type: "custom_hours", startMinute: 600, endMinute: 660 }],
        });
        expect(isSlotOnGrid(days, ms("2030-01-07T10:30:00Z"), 30)).toBe(true);
        expect(isSlotOnGrid(days, ms("2030-01-07T11:00:00Z"), 30)).toBe(false);
        const open = resolve({ timezone: "UTC", fromDate: "2030-01-07", toDate: "2030-01-07", weekly: [{ weekday: 1, intervals: [{ startMinute: 0, endMinute: 1440 }] }] });
        expect(isSlotOnGrid(open, ms("2030-01-07T23:30:00Z"), 30)).toBe(true);
        expect(isSlotOnGrid(open, ms("2030-01-08T00:00:00Z"), 30)).toBe(false);
    });

    it("should count real elapsed minutes across the Europe/Berlin fall-back (2026-10-25)", () => {
        // 00:00 CEST (22:00Z) to 06:00 CET (05:00Z): seven real hours.
        const days = resolve({ timezone: "Europe/Berlin", fromDate: "2026-10-25", toDate: "2026-10-25", weekly: [{ weekday: 7, intervals: [{ startMinute: 0, endMinute: 360 }] }] });
        expect(isSlotOnGrid(days, ms("2026-10-25T04:00:00Z"), 60)).toBe(true); // 05:00 CET, last slot
        expect(isSlotOnGrid(days, ms("2026-10-25T05:00:00Z"), 60)).toBe(false); // 06:00 CET, ends past the interval
        expect(isSlotOnGrid(days, ms("2026-10-25T00:30:00Z"), 60)).toBe(false);
    });

    it("should count real elapsed minutes across the America/New_York spring-forward (2027-03-14)", () => {
        // 00:00 EST (05:00Z) to 06:00 EDT (10:00Z): five real hours.
        const days = resolve({ timezone: "America/New_York", fromDate: "2027-03-14", toDate: "2027-03-14", weekly: [{ weekday: 7, intervals: [{ startMinute: 0, endMinute: 360 }] }] });
        expect(isSlotOnGrid(days, ms("2027-03-14T09:00:00Z"), 60)).toBe(true); // 05:00 EDT, last slot
        expect(isSlotOnGrid(days, ms("2027-03-14T10:00:00Z"), 60)).toBe(false);
    });

    it("should anchor a grid that starts after the fall-back on the new offset", () => {
        const days = resolve({ timezone: "America/New_York", fromDate: "2026-11-01", toDate: "2026-11-01", weekly: [{ weekday: 7, intervals: [{ startMinute: 540, endMinute: 720 }] }] });
        expect(isSlotOnGrid(days, ms("2026-11-01T14:00:00Z"), 30)).toBe(true); // 09:00 EST
        expect(isSlotOnGrid(days, ms("2026-11-01T14:30:00Z"), 30)).toBe(true);
        expect(isSlotOnGrid(days, ms("2026-11-01T14:15:00Z"), 30)).toBe(false);
    });
});

describe("isCoveredByOpenIntervals", () => {
    const days = [day("2030-01-01", ["2030-01-01T09:00:00Z", "2030-01-01T10:00:00Z"], ["2030-01-01T11:00:00Z", "2030-01-01T12:00:00Z"])];

    it("should be true when the range lies inside one interval, edges included", () => {
        expect(isCoveredByOpenIntervals(days, ms("2030-01-01T09:00:00Z"), ms("2030-01-01T10:00:00Z"))).toBe(true);
        expect(isCoveredByOpenIntervals(days, ms("2030-01-01T09:07:00Z"), ms("2030-01-01T09:37:00Z"))).toBe(true);
    });

    it("should be false when the range leaves the interval, spans two, or is empty or inverted", () => {
        expect(isCoveredByOpenIntervals(days, ms("2030-01-01T09:30:00Z"), ms("2030-01-01T10:30:00Z"))).toBe(false);
        expect(isCoveredByOpenIntervals(days, ms("2030-01-01T09:30:00Z"), ms("2030-01-01T11:30:00Z"))).toBe(false);
        expect(isCoveredByOpenIntervals(days, ms("2030-01-01T09:30:00Z"), ms("2030-01-01T09:30:00Z"))).toBe(false);
        expect(isCoveredByOpenIntervals(days, ms("2030-01-01T09:40:00Z"), ms("2030-01-01T09:30:00Z"))).toBe(false);
        expect(isCoveredByOpenIntervals([], 0, 1)).toBe(false);
    });

    it("should not require the slot grid", () => {
        expect(isCoveredByOpenIntervals(days, ms("2030-01-01T11:07:00Z"), ms("2030-01-01T11:52:00Z"))).toBe(true);
    });
});
