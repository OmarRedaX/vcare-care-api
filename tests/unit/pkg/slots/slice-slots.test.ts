import { firstFreeStart, sliceSlots } from "../../../../src/pkg/slots/slice";

const MINUTE = 60_000;
const segment = (anchor: number, start: number, end: number) => ({ anchorMs: anchor * MINUTE, startMs: start * MINUTE, endMs: end * MINUTE });
const starts = (segments: ReturnType<typeof segment>[], duration: number, from: number, to: number): number[] =>
    sliceSlots(segments, duration, { fromMs: from * MINUTE, toMs: to * MINUTE }).map((slot) => slot.startMs / MINUTE);

describe("sliceSlots", () => {
    it("should resume on the original grid after an off-grid booking end", () => {
        const segments = [segment(0, 0, 40), segment(0, 65, 180)];
        expect(starts(segments, 30, 0, 180)).toEqual([0, 90, 120, 150]);
        expect(firstFreeStart(segments, 30, { fromMs: 65 * MINUTE, toMs: 180 * MINUTE })).toBe(90 * MINUTE);
    });

    it("should return no starts when the duration cannot fit and restart after a split-shift gap", () => {
        expect(starts([segment(0, 0, 20)], 30, 0, 100)).toEqual([]);
        expect(starts([segment(0, 0, 60), segment(90, 90, 150)], 30, 0, 150)).toEqual([0, 30, 90, 120]);
    });

    it("should include a slot whose start is before to even if its end straddles to", () => {
        expect(starts([segment(0, 0, 120)], 30, 30, 65)).toEqual([30, 60]);
        expect(starts([segment(0, 0, 120)], 30, 31, 60)).toEqual([]);
    });

    it("should sort and deduplicate identical UTC starts from overlapping open segments", () => {
        expect(starts([segment(30, 30, 90), segment(0, 0, 120)], 30, 0, 120)).toEqual([0, 30, 60, 90]);
    });
});
