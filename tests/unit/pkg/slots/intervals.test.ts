import { mergeLocalIntervals, mergeUtcIntervals } from "../../../../src/pkg/slots/intervals";

describe("mergeLocalIntervals", () => {
    it("should merge overlapping intervals", () => {
        expect(mergeLocalIntervals([{ startMinute: 540, endMinute: 720 }, { startMinute: 660, endMinute: 840 }])).toEqual([{ startMinute: 540, endMinute: 840 }]);
    });
    it("should merge touching intervals", () => {
        expect(mergeLocalIntervals([{ startMinute: 540, endMinute: 720 }, { startMinute: 720, endMinute: 840 }])).toEqual([{ startMinute: 540, endMinute: 840 }]);
    });
    it("should keep a gap as two intervals", () => {
        expect(mergeLocalIntervals([{ startMinute: 540, endMinute: 720 }, { startMinute: 840, endMinute: 1080 }]))
            .toEqual([{ startMinute: 540, endMinute: 720 }, { startMinute: 840, endMinute: 1080 }]);
    });
    it("should sort unordered input", () => {
        expect(mergeLocalIntervals([{ startMinute: 840, endMinute: 900 }, { startMinute: 60, endMinute: 120 }]))
            .toEqual([{ startMinute: 60, endMinute: 120 }, { startMinute: 840, endMinute: 900 }]);
    });
    it("should absorb a contained interval", () => {
        expect(mergeLocalIntervals([{ startMinute: 0, endMinute: 1440 }, { startMinute: 600, endMinute: 700 }])).toEqual([{ startMinute: 0, endMinute: 1440 }]);
    });
    it("should drop empty and inverted intervals", () => {
        expect(mergeLocalIntervals([{ startMinute: 600, endMinute: 600 }, { startMinute: 700, endMinute: 650 }])).toEqual([]);
        expect(mergeLocalIntervals([])).toEqual([]);
    });
    it("should not mutate the input or share its objects", () => {
        const input = [{ startMinute: 720, endMinute: 800 }, { startMinute: 540, endMinute: 720 }];
        const snapshot = JSON.parse(JSON.stringify(input)) as typeof input;
        const output = mergeLocalIntervals(input);
        expect(input).toEqual(snapshot);
        output[0]!.endMinute = 1;
        expect(input).toEqual(snapshot);
    });
});

describe("mergeUtcIntervals", () => {
    it("should merge overlapping and touching intervals and keep gaps", () => {
        expect(mergeUtcIntervals([{ startMs: 0, endMs: 10 }, { startMs: 10, endMs: 20 }, { startMs: 15, endMs: 30 }, { startMs: 40, endMs: 50 }]))
            .toEqual([{ startMs: 0, endMs: 30 }, { startMs: 40, endMs: 50 }]);
    });
    it("should sort and drop empty intervals", () => {
        expect(mergeUtcIntervals([{ startMs: 40, endMs: 50 }, { startMs: 5, endMs: 5 }, { startMs: 0, endMs: 10 }]))
            .toEqual([{ startMs: 0, endMs: 10 }, { startMs: 40, endMs: 50 }]);
    });
    it("should not mutate the input", () => {
        const input = [{ startMs: 10, endMs: 20 }, { startMs: 0, endMs: 10 }];
        const snapshot = JSON.parse(JSON.stringify(input)) as typeof input;
        mergeUtcIntervals(input);
        expect(input).toEqual(snapshot);
    });
});
