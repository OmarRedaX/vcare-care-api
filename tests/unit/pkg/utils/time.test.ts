import { toMs, toSeconds } from "../../../../src/pkg/utils/time";

describe("pkg/utils/time", () => {
    it.each([
        [1, "ms", 1],
        [2, "s", 2_000],
        [3, "min", 180_000],
        [1.5, "h", 5_400_000],
        [2, "d", 172_800_000],
        [0, "d", 0],
    ] as const)("should convert %p %s to %p milliseconds when given a finite value", (value, unit, expected) => {
        expect(toMs(value, unit)).toBe(expected);
    });

    it("should floor to whole seconds when converting with toSeconds", () => {
        expect(toSeconds(1_999, "ms")).toBe(1);
        expect(toSeconds(2, "min")).toBe(120);
    });

    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
        "should throw RangeError when the value is %p",
        (value) => {
            expect(() => toMs(value, "s")).toThrow(RangeError);
            expect(() => toSeconds(value, "s")).toThrow(RangeError);
        },
    );
});
