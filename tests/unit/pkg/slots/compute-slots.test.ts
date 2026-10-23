import { DateTime } from "luxon";
import { SlotResponseDto } from "../../../../src/app/availability/dto/availability.response.dto";
import { computeSlots } from "../../../../src/pkg/slots/compute";
import { localInstant } from "../../../../src/pkg/slots/instant";
import type { ComputeSlotsInput } from "../../../../src/pkg/slots/types";

describe("computeSlots", () => {
    const date = "2027-04-28";
    const timezone = "Africa/Cairo";
    const fromMs = localInstant(date, 0, timezone, "start");
    const toMs = localInstant("2027-04-29", 0, timezone, "start");
    const weekday = DateTime.fromISO(date, { zone: timezone }).weekday;
    const baseline: ComputeSlotsInput = { timezone, weekly: [{ weekday, intervals: [{ startMinute: 0, endMinute: 120 }] }],
        exceptions: [], busy: [], durationMinutes: 30, bounds: { fromMs, toMs } };

    it("should replace weekly hours with custom hours and remove all starts for day off", () => {
        const custom = computeSlots({ ...baseline, exceptions: [{ date, type: "custom_hours", startMinute: 60, endMinute: 120 }] });
        expect(custom.map((slot) => slot.startMs)).toEqual([fromMs + 60 * 60_000, fromMs + 90 * 60_000]);
        expect(computeSlots({ ...baseline, exceptions: [{ date, type: "day_off", startMinute: null, endMinute: null }] })).toEqual([]);
    });

    it("should render a Cairo morning slot on the previous New York calendar date", () => {
        const first = computeSlots(baseline)[0]!;
        const rendered = SlotResponseDto.from(first, "America/New_York");
        expect(rendered.startsAt).toBe(new Date(fromMs).toISOString());
        expect(rendered.startsAtLocal.slice(0, 10)).toBe("2027-04-27");
        expect(first.endMs - first.startMs).toBe(30 * 60_000);
    });

    it("should preserve real-minute durations across a two-shift UTC midnight boundary", () => {
        const utcDate = "2027-01-04";
        const utcStart = Date.parse(`${utcDate}T00:00:00Z`);
        const monday = DateTime.fromISO(utcDate).weekday;
        const slots = computeSlots({ timezone: "UTC", weekly: [{ weekday: monday, intervals: [{ startMinute: 1320, endMinute: 1440 }] },
            { weekday: monday + 1, intervals: [{ startMinute: 0, endMinute: 120 }] }], exceptions: [], busy: [], durationMinutes: 30,
        bounds: { fromMs: utcStart + 22 * 3_600_000, toMs: utcStart + 26 * 3_600_000 } });
        expect(slots).toHaveLength(8);
        expect(slots.every((slot) => slot.endMs - slot.startMs === 30 * 60_000)).toBe(true);
        expect(slots[4]?.startMs).toBe(utcStart + 24 * 3_600_000);
    });
});
