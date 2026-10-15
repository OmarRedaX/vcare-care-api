import { isInsideWindow, sessionWindow } from "../../../../src/pkg/utils/session-window";

const STARTS = Date.parse("2030-03-30T10:00:00Z");
const ENDS = Date.parse("2030-03-30T10:30:00Z");
const MINUTE = 60_000;

describe("pkg/utils/session-window", () => {
    it("should open ten minutes before the start and close fifteen minutes after the end", () => {
        expect(sessionWindow(STARTS, ENDS, 10, 15)).toEqual({ opensAtMs: STARTS - 10 * MINUTE, closesAtMs: ENDS + 15 * MINUTE });
    });

    it("should include the opening instant and exclude the closing instant", () => {
        const window = sessionWindow(STARTS, ENDS, 10, 15);
        expect(isInsideWindow(window, window.opensAtMs - 1)).toBe(false);
        expect(isInsideWindow(window, window.opensAtMs)).toBe(true);
        expect(isInsideWindow(window, window.closesAtMs - 1)).toBe(true);
        expect(isInsideWindow(window, window.closesAtMs)).toBe(false);
    });

    it("should open exactly at the start when the open offset is zero", () => {
        const window = sessionWindow(STARTS, ENDS, 0, 0);
        expect(window).toEqual({ opensAtMs: STARTS, closesAtMs: ENDS });
        expect(isInsideWindow(window, STARTS)).toBe(true);
        expect(isInsideWindow(window, ENDS)).toBe(false);
    });

    it("should reject a negative offset", () => {
        expect(() => sessionWindow(STARTS, ENDS, -1, 15)).toThrow(RangeError);
    });
});
