import { resolveOpenIntervals } from "../../src/pkg/slots/resolve-open-intervals";
import type { ResolveOpenIntervalsInput, WeeklyHoursRule } from "../../src/pkg/slots/types";

/** Opt-in benchmark (`npm run test:bench`): verifies the spec section 8 / 9.1 budget, resolveOpenIntervals < 5 ms. Never part of `npm test`. */
const weekly = (weekday: number, ...intervals: Array<[number, number]>): WeeklyHoursRule => ({
    weekday, intervals: intervals.map(([startH, endH]) => ({ startMinute: startH * 60, endMinute: endH * 60 })),
});

const input: ResolveOpenIntervalsInput = {
    timezone: "Europe/Berlin",
    weekly: [1, 2, 3, 4, 5, 6, 7].map((weekday) => weekly(weekday, [8, 11], [12, 15], [16, 20])),
    exceptions: [
        { date: "2027-03-24", type: "day_off", startMinute: null, endMinute: null },
        { date: "2027-03-26", type: "custom_hours", startMinute: 9 * 60, endMinute: 13 * 60 },
    ],
    fromDate: "2027-03-22", toDate: "2027-04-04",
};

describe("resolveOpenIntervals budget (benchmark)", () => {
    it("should stay under 5 ms for 14 days with 3 shifts a day and exceptions (best of 100)", () => {
        resolveOpenIntervals(input);
        let best = Number.POSITIVE_INFINITY;
        for (let run = 0; run < 100; run += 1) {
            const started = performance.now();
            resolveOpenIntervals(input);
            best = Math.min(best, performance.now() - started);
        }
        process.stderr.write(`resolveOpenIntervals best of 100: ${best.toFixed(2)} ms
`);
        expect(best).toBeLessThan(5);
    });
});
