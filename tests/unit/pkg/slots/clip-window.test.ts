import { clipWindow } from "../../../../src/pkg/slots/window";

describe("clipWindow", () => {
    it("should clip a past start to now while preserving a future end", () => {
        expect(clipWindow(50, 150, 100, 200)).toEqual({ fromMs: 100, toMs: 150, empty: false });
    });

    it("should clip a future end to the horizon while preserving an earlier start", () => {
        expect(clipWindow(150, 250, 100, 200)).toEqual({ fromMs: 150, toMs: 200, empty: false });
    });

    it("should return an empty window exactly at now or horizon when wholly outside", () => {
        expect(clipWindow(0, 99, 100, 200)).toEqual({ fromMs: 100, toMs: 100, empty: true });
        expect(clipWindow(201, 300, 100, 200)).toEqual({ fromMs: 200, toMs: 200, empty: true });
        expect(clipWindow(100, 200, 100, 200)).toEqual({ fromMs: 100, toMs: 200, empty: false });
    });
});
