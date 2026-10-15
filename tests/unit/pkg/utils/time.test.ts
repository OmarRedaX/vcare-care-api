import { toIsoInZone, toMs, toSeconds } from "../../../../src/pkg/utils/time";

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

describe("pkg/utils/time toIsoInZone", () => {
    it("should render the instant with the zone offset, dropping zero milliseconds", () => {
        const instant = Date.parse("2026-10-24T20:00:00Z");
        expect(toIsoInZone(instant, "Europe/Berlin")).toBe("2026-10-24T22:00:00+02:00");
        expect(toIsoInZone(Date.parse("2026-10-25T20:00:00Z"), "Europe/Berlin")).toBe("2026-10-25T21:00:00+01:00");
        expect(toIsoInZone(instant, "UTC")).toBe("2026-10-24T20:00:00Z");
    });

    it("should change offset across the New York fall-back", () => {
        expect(toIsoInZone(Date.parse("2026-11-01T05:30:00Z"), "America/New_York")).toBe("2026-11-01T01:30:00-04:00");
        expect(toIsoInZone(Date.parse("2026-11-01T06:30:00Z"), "America/New_York")).toBe("2026-11-01T01:30:00-05:00");
    });

    it("should throw RangeError for an invalid zone", () => {
        expect(() => toIsoInZone(0, "Not/AZone")).toThrow(RangeError);
    });
});
