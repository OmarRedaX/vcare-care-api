import fs from "node:fs";
import { IANAZone } from "luxon";
import path from "node:path";
import { mergeUtcIntervals } from "../../../../src/pkg/slots/intervals";
import { resolveOpenIntervals } from "../../../../src/pkg/slots/resolve-open-intervals";
import type { ExceptionRule, ResolveOpenIntervalsInput, UtcInterval, WeeklyHoursRule } from "../../../../src/pkg/slots/types";

const ms = (iso: string): number => Date.parse(iso);
const span = (start: string, end: string): UtcInterval => ({ startMs: ms(start), endMs: ms(end) });
const hours = (startH: number, endH: number): { startMinute: number; endMinute: number } => ({ startMinute: startH * 60, endMinute: endH * 60 });
const weekly = (weekday: number, ...intervals: Array<[number, number]>): WeeklyHoursRule => ({ weekday, intervals: intervals.map(([s, e]) => hours(s, e)) });
const dayOff = (date: string): ExceptionRule => ({ date, type: "day_off", startMinute: null, endMinute: null });
const custom = (date: string, startH: number, endH: number): ExceptionRule => ({ date, type: "custom_hours", startMinute: startH * 60, endMinute: endH * 60 });
function resolve(over: Partial<ResolveOpenIntervalsInput> & Pick<ResolveOpenIntervalsInput, "fromDate" | "toDate">) {
    return resolveOpenIntervals({ timezone: "UTC", weekly: [], exceptions: [], ...over });
}
const single = (over: Partial<ResolveOpenIntervalsInput> & { date: string }): UtcInterval[] =>
    resolve({ ...over, fromDate: over.date, toDate: over.date })[0]!.intervals;

// 2027-03-22 is a Monday.
const MONDAY = "2027-03-22";
const TUESDAY = "2027-03-23";

describe("resolveOpenIntervals (weekly hours and exceptions)", () => {
    it("should return weekly hours per weekday", () => {
        const days = resolve({ weekly: [weekly(1, [9, 17]), weekly(2, [10, 12])], fromDate: MONDAY, toDate: TUESDAY });
        expect(days).toEqual([
            { date: MONDAY, intervals: [span("2027-03-22T09:00:00Z", "2027-03-22T17:00:00Z")] },
            { date: TUESDAY, intervals: [span("2027-03-23T10:00:00Z", "2027-03-23T12:00:00Z")] },
        ]);
    });

    it("should keep a split shift as two intervals with a gap", () => {
        expect(single({ weekly: [weekly(1, [9, 12], [14, 18])], date: MONDAY })).toEqual([
            span("2027-03-22T09:00:00Z", "2027-03-22T12:00:00Z"), span("2027-03-22T14:00:00Z", "2027-03-22T18:00:00Z"),
        ]);
    });

    it("should merge overlapping and touching weekly rows of one weekday", () => {
        expect(single({ weekly: [weekly(1, [9, 12], [11, 14], [14, 16])], date: MONDAY })).toEqual([span("2027-03-22T09:00:00Z", "2027-03-22T16:00:00Z")]);
        expect(single({ weekly: [weekly(1, [9, 12]), weekly(1, [10, 13])], date: MONDAY })).toEqual([span("2027-03-22T09:00:00Z", "2027-03-22T13:00:00Z")]);
    });

    it("should apply a day_off as an empty day", () => {
        expect(single({ weekly: [weekly(1, [9, 17])], exceptions: [dayOff(MONDAY)], date: MONDAY })).toEqual([]);
    });

    it("should apply custom_hours as a replacement and ignore the weekday rows", () => {
        expect(single({ weekly: [weekly(1, [9, 12], [14, 18])], exceptions: [custom(MONDAY, 20, 22)], date: MONDAY }))
            .toEqual([span("2027-03-22T20:00:00Z", "2027-03-22T22:00:00Z")]);
    });

    it("should apply custom_hours on a date whose weekday has no hours", () => {
        expect(single({ weekly: [], exceptions: [custom(MONDAY, 8, 9)], date: MONDAY })).toEqual([span("2027-03-22T08:00:00Z", "2027-03-22T09:00:00Z")]);
    });

    it("should ignore exceptions outside the range and affect only their own date", () => {
        const days = resolve({
            weekly: [weekly(1, [9, 10]), weekly(2, [9, 10])],
            exceptions: [dayOff("2027-03-29"), dayOff(TUESDAY)], fromDate: MONDAY, toDate: TUESDAY,
        });
        expect(days.map((d) => d.intervals.length)).toEqual([1, 0]);
    });

    it("should return empty days for a weekday without rows and one OpenDay per date inclusive", () => {
        const days = resolve({ weekly: [weekly(1, [9, 10])], fromDate: MONDAY, toDate: "2027-03-28" });
        expect(days.map((d) => d.date)).toEqual(["2027-03-22", "2027-03-23", "2027-03-24", "2027-03-25", "2027-03-26", "2027-03-27", "2027-03-28"]);
        expect(days.map((d) => d.intervals.length)).toEqual([1, 0, 0, 0, 0, 0, 0]);
    });

    it("should return a single day when fromDate equals toDate", () => {
        expect(resolve({ fromDate: MONDAY, toDate: MONDAY })).toEqual([{ date: MONDAY, intervals: [] }]);
    });

    it("should keep 22:00-24:00 Monday and 00:00-02:00 Tuesday on separate dates and merge them only through mergeUtcIntervals", () => {
        const days = resolve({ weekly: [weekly(1, [22, 24]), weekly(2, [0, 2])], fromDate: MONDAY, toDate: TUESDAY });
        expect(days[0]!.intervals).toEqual([span("2027-03-22T22:00:00Z", "2027-03-23T00:00:00Z")]);
        expect(days[1]!.intervals).toEqual([span("2027-03-23T00:00:00Z", "2027-03-23T02:00:00Z")]);
        expect(days[0]!.intervals[0]!.endMs).toBe(days[1]!.intervals[0]!.startMs);
        expect(mergeUtcIntervals(days.flatMap((d) => d.intervals))).toEqual([span("2027-03-22T22:00:00Z", "2027-03-23T02:00:00Z")]);
    });

    it("should render the same local hours as different UTC instants for UTC+3 and UTC-5 zones", () => {
        const plus = single({ timezone: "Africa/Cairo", weekly: [weekly(1, [9, 17])], date: "2027-07-19" });
        const minus = single({ timezone: "America/New_York", weekly: [weekly(1, [9, 17])], date: "2027-07-19" });
        expect(plus).toEqual([span("2027-07-19T06:00:00Z", "2027-07-19T14:00:00Z")]);
        expect(minus).toEqual([span("2027-07-19T13:00:00Z", "2027-07-19T21:00:00Z")]);
    });

    it("should not mutate its input", () => {
        const input: ResolveOpenIntervalsInput = { timezone: "UTC", weekly: [weekly(1, [11, 12], [9, 11])], exceptions: [custom(TUESDAY, 1, 2)], fromDate: MONDAY, toDate: TUESDAY };
        const snapshot = JSON.parse(JSON.stringify(input)) as ResolveOpenIntervalsInput;
        resolveOpenIntervals(input);
        expect(input).toEqual(snapshot);
    });
});

describe("resolveOpenIntervals (DST reference table, 2027)", () => {
    const berlin = (date: string, startH: number, startM: number, endH: number, endM: number, weekday: number): UtcInterval[] =>
        single({ timezone: "Europe/Berlin", exceptions: [{ date, type: "custom_hours", startMinute: startH * 60 + startM, endMinute: endH * 60 + endM }], weekly: [{ weekday, intervals: [] }], date });

    it.each([
        ["01:00-04:00", [1, 0, 4, 0], [span("2027-03-28T00:00:00Z", "2027-03-28T02:00:00Z")]],
        ["02:30-03:30 (start in gap)", [2, 30, 3, 30], [span("2027-03-28T01:00:00Z", "2027-03-28T01:30:00Z")]],
        ["02:15-02:45 (wholly in gap)", [2, 15, 2, 45], []],
        ["00:00-02:30 (end in gap)", [0, 0, 2, 30], [span("2027-03-27T23:00:00Z", "2027-03-28T01:00:00Z")]],
    ] as const)("should resolve Berlin spring-forward 2027-03-28 %s", (_label, [sh, sm, eh, em], expected) => {
        expect(berlin("2027-03-28", sh, sm, eh, em, 7)).toEqual(expected);
    });

    it.each([
        ["01:00-04:00", [1, 0, 4, 0], [span("2027-10-30T23:00:00Z", "2027-10-31T03:00:00Z")]],
        ["02:30-03:30 (start ambiguous, earlier)", [2, 30, 3, 30], [span("2027-10-31T00:30:00Z", "2027-10-31T02:30:00Z")]],
        ["01:00-02:30 (end ambiguous, later)", [1, 0, 2, 30], [span("2027-10-30T23:00:00Z", "2027-10-31T01:30:00Z")]],
    ] as const)("should resolve Berlin fall-back 2027-10-31 %s", (_label, [sh, sm, eh, em], expected) => {
        expect(berlin("2027-10-31", sh, sm, eh, em, 7)).toEqual(expected);
    });

    it("should resolve Cairo 18:00-24:00 on 2027-04-29 up to the transition (24:00 is a nonexistent midnight)", () => {
        expect(single({ timezone: "Africa/Cairo", weekly: [weekly(4, [18, 24])], date: "2027-04-29" })).toEqual([span("2027-04-29T16:00:00Z", "2027-04-29T22:00:00Z")]);
    });

    it("should resolve Cairo 00:00-02:00 on 2027-04-30 from the transition", () => {
        expect(single({ timezone: "Africa/Cairo", weekly: [weekly(5, [0, 2])], date: "2027-04-30" })).toEqual([span("2027-04-29T22:00:00Z", "2027-04-29T23:00:00Z")]);
    });

    it("should resolve Cairo 22:00-24:00 on 2027-10-28 as three real hours", () => {
        expect(single({ timezone: "Africa/Cairo", weekly: [weekly(4, [22, 24])], date: "2027-10-28" })).toEqual([span("2027-10-28T19:00:00Z", "2027-10-28T22:00:00Z")]);
    });

    it("should resolve New York 2027-03-14 01:00-04:00 as two real hours", () => {
        const [interval] = single({ timezone: "America/New_York", weekly: [weekly(7, [1, 4])], date: "2027-03-14" });
        expect(interval).toEqual(span("2027-03-14T06:00:00Z", "2027-03-14T08:00:00Z"));
        expect((interval!.endMs - interval!.startMs) / 60_000).toBe(120);
    });

    it("should resolve New York 2027-11-07 00:00-04:00 as five real hours", () => {
        const [interval] = single({ timezone: "America/New_York", weekly: [weekly(7, [0, 4])], date: "2027-11-07" });
        expect(interval).toEqual(span("2027-11-07T04:00:00Z", "2027-11-07T09:00:00Z"));
        expect((interval!.endMs - interval!.startMs) / 60_000).toBe(300);
    });

    it("should drop an interval wholly inside the New York gap", () => {
        expect(single({ timezone: "America/New_York", weekly: [weekly(7, [2, 3])], date: "2027-03-14" })).toEqual([]);
    });

    it("should yield real elapsed minutes across a range spanning the Berlin DST change", () => {
        const days = resolve({ timezone: "Europe/Berlin", weekly: [weekly(6, [0, 24]), weekly(7, [0, 24]), weekly(1, [0, 24])], fromDate: "2027-03-27", toDate: "2027-03-29" });
        const minutes = days.map((d) => d.intervals.reduce((sum, i) => sum + (i.endMs - i.startMs) / 60_000, 0));
        expect(minutes).toEqual([1440, 1380, 1440]);
        expect(mergeUtcIntervals(days.flatMap((d) => d.intervals))).toEqual([span("2027-03-26T23:00:00Z", "2027-03-29T22:00:00Z")]);
    });

    it("should yield 25 real hours on the Berlin fall-back day", () => {
        const [interval] = single({ timezone: "Europe/Berlin", weekly: [weekly(7, [0, 24])], date: "2027-10-31" });
        expect((interval!.endMs - interval!.startMs) / 3_600_000).toBe(25);
    });
});

describe("resolveOpenIntervals (errors, purity and budget)", () => {
    it("should throw RangeError for an invalid zone", () => {
        expect(() => resolve({ timezone: "Not/AZone", fromDate: MONDAY, toDate: MONDAY })).toThrow(RangeError);
    });
    it("should throw RangeError for a reversed range and invalid dates", () => {
        expect(() => resolve({ fromDate: TUESDAY, toDate: MONDAY })).toThrow(RangeError);
        expect(() => resolve({ fromDate: "2027-02-30", toDate: "2027-03-01" })).toThrow(RangeError);
        expect(() => resolve({ fromDate: MONDAY, toDate: "nope" })).toThrow(RangeError);
    });
    it("should accept exactly 400 dates and throw RangeError for 401", () => {
        expect(resolve({ fromDate: "2027-01-01", toDate: "2028-02-04" })).toHaveLength(400);
        expect(() => resolve({ fromDate: "2027-01-01", toDate: "2028-02-05" })).toThrow(RangeError);
    });
    it("should throw RangeError for duplicate exception dates and invalid exception shapes", () => {
        expect(() => resolve({ exceptions: [dayOff(MONDAY), custom(MONDAY, 1, 2)], fromDate: MONDAY, toDate: MONDAY })).toThrow(RangeError);
        expect(() => resolve({ exceptions: [{ date: MONDAY, type: "custom_hours", startMinute: null, endMinute: null }], fromDate: MONDAY, toDate: MONDAY })).toThrow(RangeError);
        expect(() => resolve({ exceptions: [dayOff("2027-02-30")], fromDate: MONDAY, toDate: MONDAY })).toThrow(RangeError);
    });
    it.each([
        [{ startMinute: 600, endMinute: 600 }], [{ startMinute: 700, endMinute: 600 }], [{ startMinute: -1, endMinute: 60 }],
        [{ startMinute: 0, endMinute: 1441 }], [{ startMinute: 1.5, endMinute: 60 }], [{ startMinute: 1440, endMinute: 1440 }],
    ])("should throw RangeError for the weekly interval %j", (interval) => {
        expect(() => resolve({ weekly: [{ weekday: 1, intervals: [interval] }], fromDate: MONDAY, toDate: MONDAY })).toThrow(RangeError);
    });
    it("should throw RangeError for a weekday outside 1..7 and an out-of-range custom_hours interval", () => {
        expect(() => resolve({ weekly: [{ weekday: 0, intervals: [] }], fromDate: MONDAY, toDate: MONDAY })).toThrow(RangeError);
        expect(() => resolve({ weekly: [{ weekday: 8, intervals: [] }], fromDate: MONDAY, toDate: MONDAY })).toThrow(RangeError);
        expect(() => resolve({ exceptions: [custom(MONDAY, 10, 9)], fromDate: MONDAY, toDate: MONDAY })).toThrow(RangeError);
    });

    it("should produce identical output at two different frozen system times (it never reads the clock)", () => {
        const input: ResolveOpenIntervalsInput = {
            timezone: "Europe/Berlin", weekly: [weekly(7, [0, 24]), weekly(1, [9, 12], [13, 17])], exceptions: [custom("2027-03-29", 8, 10)],
            fromDate: "2027-03-27", toDate: "2027-03-30",
        };
        jest.useFakeTimers();
        try {
            jest.setSystemTime(new Date("2020-01-01T00:00:00Z"));
            const first = resolveOpenIntervals(input);
            jest.setSystemTime(new Date("2035-12-31T23:59:59Z"));
            expect(resolveOpenIntervals(input)).toEqual(first);
        } finally {
            jest.useRealTimers();
        }
    });

    const budgetInput: ResolveOpenIntervalsInput = {
        timezone: "Europe/Berlin",
        weekly: [1, 2, 3, 4, 5, 6, 7].map((weekday) => weekly(weekday, [8, 11], [12, 15], [16, 20])),
        exceptions: [dayOff("2027-03-24"), custom("2027-03-26", 9, 13)],
        fromDate: "2027-03-22", toDate: "2027-04-04",
    };
    function bestOf(runs: number): number {
        resolveOpenIntervals(budgetInput); // warm the Intl caches; the budget is the steady-state cost
        let best = Number.POSITIVE_INFINITY;
        for (let run = 0; run < runs; run += 1) {
            const started = performance.now();
            resolveOpenIntervals(budgetInput);
            best = Math.min(best, performance.now() - started);
        }
        return best;
    }

    // The strict 5 ms budget (spec sections 8 / 9.1) is verified by the opt-in benchmark `npm run test:bench`
    // (tests/bench/resolve-open-intervals.bench.test.ts): wall-clock asserts are flaky in the parallel suite.
    it("should validate each zone name a constant number of times, not once per localInstant call (deterministic cost guard)", () => {
        const spy = jest.spyOn(IANAZone, "isValidZone");
        try {
            const input = { ...budgetInput, timezone: "Asia/Tokyo" };
            resolveOpenIntervals(input);
            const first = spy.mock.calls.length; // our single validation plus luxon's own one-time zone construction
            expect(first).toBeLessThanOrEqual(2);
            resolveOpenIntervals(input);
            expect(spy.mock.calls.length).toBe(first);
        } finally {
            spy.mockRestore();
        }
    });

    it("should still reject an invalid zone after valid ones were validated", () => {
        resolveOpenIntervals(budgetInput);
        expect(() => resolveOpenIntervals({ ...budgetInput, timezone: "Not/AZone" })).toThrow(RangeError);
    });

    it("should stay under 50 ms for 14 days with 3 shifts a day (regression guard)", () => {
        expect(bestOf(10)).toBeLessThan(50);
    });
});

describe("pkg/slots purity (import surface)", () => {
    const dir = path.resolve(__dirname, "..", "..", "..", "..", "src", "pkg", "slots");
    const files = fs.readdirSync(dir).filter((name) => name.endsWith(".ts"));

    it.each(files)("should import only luxon and sibling modules in %s", (file) => {
        const source = fs.readFileSync(path.join(dir, file), "utf8");
        const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");
        for (const specifier of specifiers) {
            expect(specifier === "luxon" || /^\.\/[a-z-]+$/.test(specifier)).toBe(true);
        }
    });

    it.each(files)("should not read the clock, env or globals in %s", (file) => {
        const source = fs.readFileSync(path.join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
        expect(source).not.toMatch(/Date\.now|new Date\(|process\.env|performance\.now|Math\.random|console\./);
    });
});
