import { DateTime } from "luxon";
import { computeSlots } from "../../src/pkg/slots/compute";
import type { ComputeSlotsInput } from "../../src/pkg/slots/types";

/** Opt-in CPU benchmark of the 14-day, 150-busy-consultation computation. */
describe("availability slot computation budget (benchmark)", () => {
    it("should compute a busy 14-day doctor window below 300 ms p95", () => {
        const fromMs = DateTime.fromISO("2027-03-21T00:00:00Z").toMillis();
        const input: ComputeSlotsInput = {
            timezone: "Europe/Berlin",
            weekly: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, intervals: [{ startMinute: 480, endMinute: 1200 }] })),
            exceptions: [],
            busy: Array.from({ length: 150 }, (_, i) => ({ startMs: fromMs + i * 2 * 3_600_000, endMs: fromMs + i * 2 * 3_600_000 + 1_800_000 })),
            durationMinutes: 30,
            bounds: { fromMs, toMs: fromMs + 14 * 86_400_000 },
        };
        for (let i = 0; i < 10; i += 1) computeSlots(input);
        const durations: number[] = [];
        for (let i = 0; i < 100; i += 1) {
            const start = performance.now();
            computeSlots(input);
            durations.push(performance.now() - start);
        }
        const p95 = durations.sort((a, b) => a - b)[94]!;
        process.stderr.write(`availability computeSlots 14-day/150-busy p95: ${p95.toFixed(2)} ms\n`);
        expect(p95).toBeLessThan(300);
    });
});
