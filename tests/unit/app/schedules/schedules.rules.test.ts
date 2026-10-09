import { ConsultationType } from "../../../../src/app/schedules/entity/consultation-type.entity";
import { WorkingHour } from "../../../../src/app/schedules/entity/working-hour.entity";
import {
    assertExceptionShape, assertValidHours, diffConsultationType, expandExceptionDates, groupHours, normalizeHours, sameHours,
} from "../../../../src/app/schedules/rules";
import type { ExceptionInput, WorkingHoursDayInput } from "../../../../src/app/schedules/types";

const iv = (startMinute: number, endMinute: number): { startMinute: number; endMinute: number } => ({ startMinute, endMinute });
const day = (weekday: number, ...intervals: Array<[number, number]>): WorkingHoursDayInput => ({ weekday, intervals: intervals.map(([s, e]) => iv(s, e)) });
const rejected = (fn: () => void): { code: string; details: Array<{ field: string; issue: string }> } => {
    try { fn(); } catch (error) { return error as never; }
    throw new Error("expected a ValidationFailed");
};

describe("assertValidHours", () => {
    it("should accept touching intervals and 24:00 as an end", () => {
        expect(() => assertValidHours([day(1, [540, 720], [720, 840]), day(2, [0, 1440])])).not.toThrow();
        expect(() => assertValidHours([])).not.toThrow();
    });
    it("should accept 7 distinct weekdays with 6 intervals each", () => {
        const six: Array<[number, number]> = [[0, 60], [120, 180], [240, 300], [360, 420], [480, 540], [600, 660]];
        expect(() => assertValidHours([1, 2, 3, 4, 5, 6, 7].map((weekday) => day(weekday, ...six)))).not.toThrow();
    });
    it("should reject a duplicate weekday", () => {
        const error = rejected(() => assertValidHours([day(1, [540, 600]), day(1, [700, 800])]));
        expect(error).toMatchObject({ code: "ValidationFailed", details: [{ field: "days" }] });
    });
    it("should reject end <= start, with the day index in the field path", () => {
        expect(rejected(() => assertValidHours([day(1, [540, 600]), day(2, [600, 600])])).details[0]?.field).toBe("days[1].intervals");
        expect(rejected(() => assertValidHours([day(1, [600, 540])])).code).toBe("ValidationFailed");
    });
    it("should reject an overlap (09-12 vs 11-14) regardless of input order", () => {
        expect(rejected(() => assertValidHours([day(1, [540, 720], [660, 840])])).details[0]?.issue).toMatch(/overlap/);
        expect(rejected(() => assertValidHours([day(1, [660, 840], [540, 720])])).details[0]?.issue).toMatch(/overlap/);
    });
    it("should reject start = 24:00", () => {
        expect(rejected(() => assertValidHours([day(1, [1440, 1440])])).code).toBe("ValidationFailed");
    });
    it("should reject 0 and 7 intervals on a day and more than 7 days", () => {
        expect(rejected(() => assertValidHours([day(1)])).details[0]?.field).toBe("days[0].intervals");
        const seven: Array<[number, number]> = [[0, 10], [20, 30], [40, 50], [60, 70], [80, 90], [100, 110], [120, 130]];
        expect(rejected(() => assertValidHours([day(1, ...seven)])).details[0]?.field).toBe("days[0].intervals");
        const eight = [1, 2, 3, 4, 5, 6, 7, 1].map((weekday) => day(weekday, [0, 10]));
        expect(rejected(() => assertValidHours(eight)).details[0]?.field).toBe("days");
    });
    it("should never echo minute values in the error", () => {
        expect(JSON.stringify(rejected(() => assertValidHours([day(1, [541, 721], [661, 841])])))).not.toMatch(/541|721|661|841/);
    });
});

describe("normalizeHours / groupHours / sameHours", () => {
    it("should flatten ascending by weekday then start and format HH:mm with 24:00", () => {
        expect(normalizeHours([day(3, [840, 1440], [540, 720]), day(1, [60, 120])])).toEqual([
            { weekday: 1, startTime: "01:00", endTime: "02:00" },
            { weekday: 3, startTime: "09:00", endTime: "12:00" },
            { weekday: 3, startTime: "14:00", endTime: "24:00" },
        ]);
    });
    const stored = [
        new WorkingHour({ id: 1, weekday: 1, startTime: "09:00", endTime: "12:00" }),
        new WorkingHour({ id: 2, weekday: 1, startTime: "14:00", endTime: "24:00" }),
        new WorkingHour({ id: 3, weekday: 5, startTime: "08:00", endTime: "09:00" }),
    ];
    it("should group stored rows by weekday, omitting weekdays without rows", () => {
        expect(groupHours([stored[2]!, stored[1]!, stored[0]!])).toEqual([
            { weekday: 1, intervals: [{ startTime: "09:00", endTime: "12:00" }, { startTime: "14:00", endTime: "24:00" }] },
            { weekday: 5, intervals: [{ startTime: "08:00", endTime: "09:00" }] },
        ]);
        expect(groupHours([])).toEqual([]);
    });
    it("should treat sets as equal ignoring order and unequal on any difference", () => {
        const rows = normalizeHours([day(5, [480, 540]), day(1, [540, 720], [840, 1440])]);
        expect(sameHours(stored, [...rows].reverse())).toBe(true);
        expect(sameHours(stored, rows.slice(1))).toBe(false);
        expect(sameHours(stored, rows.map((row, index) => index === 0 ? { ...row, endTime: "12:30" } : row))).toBe(false);
        expect(sameHours([], [])).toBe(true);
        expect(sameHours(stored, [])).toBe(false);
    });
});

describe("expandExceptionDates", () => {
    it("should return a single date without endDate and for endDate equal to date", () => {
        expect(expandExceptionDates("2027-05-01", null)).toEqual(["2027-05-01"]);
        expect(expandExceptionDates("2027-05-01", "2027-05-01")).toEqual(["2027-05-01"]);
    });
    it("should expand a 60-date range inclusive and reject 61", () => {
        const dates = expandExceptionDates("2027-05-01", "2027-06-29");
        expect(dates).toHaveLength(60);
        expect(dates[0]).toBe("2027-05-01");
        expect(dates[59]).toBe("2027-06-29");
        expect(rejected(() => expandExceptionDates("2027-05-01", "2027-06-30")).details[0]?.field).toBe("endDate");
    });
    it("should reject endDate before date", () => {
        expect(rejected(() => expandExceptionDates("2027-05-02", "2027-05-01")).details[0]?.field).toBe("endDate");
    });
    it("should cross month and year boundaries and a leap day", () => {
        expect(expandExceptionDates("2027-12-30", "2028-01-02")).toEqual(["2027-12-30", "2027-12-31", "2028-01-01", "2028-01-02"]);
        expect(expandExceptionDates("2028-02-28", "2028-03-01")).toEqual(["2028-02-28", "2028-02-29", "2028-03-01"]);
        expect(expandExceptionDates("2027-02-28", "2027-03-01")).toEqual(["2027-02-28", "2027-03-01"]);
    });
});

describe("assertExceptionShape", () => {
    const base: ExceptionInput = { type: "day_off" as never, date: "2027-05-01", endDate: null, startMinute: null, endMinute: null, reason: null, confirmConflicts: false };
    const custom = (changes: Partial<ExceptionInput>): ExceptionInput => ({ ...base, type: "custom_hours" as never, startMinute: 600, endMinute: 660, ...changes });
    it("should accept a bare day_off and a day_off range", () => {
        expect(() => assertExceptionShape(base)).not.toThrow();
        expect(() => assertExceptionShape({ ...base, endDate: "2027-05-09" })).not.toThrow();
    });
    it("should accept custom_hours with times including 24:00", () => {
        expect(() => assertExceptionShape(custom({}))).not.toThrow();
        expect(() => assertExceptionShape(custom({ endMinute: 1440 }))).not.toThrow();
    });
    it("should reject a day_off with a start time, an end time or both", () => {
        for (const change of [{ startMinute: 600 }, { endMinute: 660 }, { startMinute: 600, endMinute: 660 }]) {
            expect(rejected(() => assertExceptionShape({ ...base, ...change })).details[0]?.field).toBe("startTime");
        }
    });
    it("should reject custom_hours without times, with one time, or with endDate", () => {
        expect(rejected(() => assertExceptionShape(custom({ startMinute: null, endMinute: null }))).details[0]?.field).toBe("startTime");
        expect(rejected(() => assertExceptionShape(custom({ endMinute: null }))).details[0]?.field).toBe("startTime");
        expect(rejected(() => assertExceptionShape(custom({ endDate: "2027-05-02" }))).details[0]?.field).toBe("endDate");
    });
    it("should reject custom_hours with end <= start and start at 24:00", () => {
        expect(rejected(() => assertExceptionShape(custom({ endMinute: 600 }))).details[0]?.field).toBe("endTime");
        expect(rejected(() => assertExceptionShape(custom({ endMinute: 540 }))).details[0]?.field).toBe("endTime");
        expect(rejected(() => assertExceptionShape(custom({ startMinute: 1440, endMinute: 1440 }))).code).toBe("ValidationFailed");
    });
});

describe("diffConsultationType", () => {
    const current = new ConsultationType({ id: 1, name: "Synthetic Visit 001", durationMinutes: 30, price: 100, currency: "EGP", isActive: true });
    it("should report nothing when provided values equal the current ones or nothing is provided", () => {
        expect(diffConsultationType(current, {})).toEqual({ fields: [], columns: {} });
        expect(diffConsultationType(current, { name: "Synthetic Visit 001", durationMinutes: 30, price: 100, currency: "EGP", isActive: true })).toEqual({ fields: [], columns: {} });
    });
    it("should report changed fields sorted by wire name with their columns", () => {
        const diff = diffConsultationType(current, { price: 0, isActive: false, name: "Synthetic Renamed", durationMinutes: 45, currency: "USD" });
        expect(diff.fields).toEqual(["currency", "durationMinutes", "isActive", "name", "price"]);
        expect(diff.columns).toEqual({ name: "Synthetic Renamed", duration_minutes: 45, price: 0, currency: "USD", is_active: false });
    });
    it("should treat price 0 and isActive false as provided values", () => {
        expect(diffConsultationType(current, { price: 0 }).fields).toEqual(["price"]);
        expect(diffConsultationType(current, { isActive: false }).fields).toEqual(["isActive"]);
    });
    it("should only report the members that differ", () => {
        expect(diffConsultationType(current, { name: "Synthetic Visit 001", price: 101 }).fields).toEqual(["price"]);
    });
});
