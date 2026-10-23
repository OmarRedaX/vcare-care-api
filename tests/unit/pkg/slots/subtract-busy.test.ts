import { subtractBusy } from "../../../../src/pkg/slots/busy";
import type { UtcInterval } from "../../../../src/pkg/slots/types";

describe("subtractBusy", () => {
    const open = [{ date: "2027-01-04", intervals: [{ startMs: 0, endMs: 120 }] }];
    const pieces = (busy: UtcInterval[]) => subtractBusy(open, busy);

    it("should keep the whole anchored interval when no booking overlaps", () => {
        expect(pieces([])).toEqual([{ anchorMs: 0, startMs: 0, endMs: 120 }]);
        expect(pieces([{ startMs: 120, endMs: 150 }])).toEqual([{ anchorMs: 0, startMs: 0, endMs: 120 }]);
    });

    it("should split around a middle booking and preserve both grid anchors", () => {
        expect(pieces([{ startMs: 40, endMs: 60 }])).toEqual([
            { anchorMs: 0, startMs: 0, endMs: 40 }, { anchorMs: 0, startMs: 60, endMs: 120 },
        ]);
    });

    it("should return no segment when a booking covers the entire interval", () => {
        expect(pieces([{ startMs: -10, endMs: 130 }])).toEqual([]);
    });

    it("should retain only the tail when a booking starts before hours and ends inside", () => {
        expect(pieces([{ startMs: -20, endMs: 50 }])).toEqual([{ anchorMs: 0, startMs: 50, endMs: 120 }]);
    });

    it("should merge unsorted overlapping bookings without mutating the input", () => {
        const busy = [{ startMs: 70, endMs: 100 }, { startMs: 25, endMs: 80 }];
        const original = busy.map((range) => ({ ...range }));
        expect(pieces(busy)).toEqual([{ anchorMs: 0, startMs: 0, endMs: 25 }, { anchorMs: 0, startMs: 100, endMs: 120 }]);
        expect(busy).toEqual(original);
    });

    it("should return no segment when the day has no hours", () => {
        expect(subtractBusy([{ date: "2027-01-04", intervals: [] }], [{ startMs: 0, endMs: 10 }])).toEqual([]);
    });
});
