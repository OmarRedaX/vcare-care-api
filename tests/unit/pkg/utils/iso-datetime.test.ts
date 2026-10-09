import { parseIsoDateTimeWithOffset } from "../../../../src/pkg/utils/iso-datetime";

const iso = (value: unknown): string | undefined => parseIsoDateTimeWithOffset(value)?.toISOString();

describe("parseIsoDateTimeWithOffset", () => {
    it.each([
        ["2026-04-15T12:00:00Z", "2026-04-15T12:00:00.000Z"],
        ["2026-04-15T12:00:00+05:30", "2026-04-15T06:30:00.000Z"],
        ["2026-04-15T12:00:00-08:00", "2026-04-15T20:00:00.000Z"],
        ["2026-04-15T12:00:00+00:00", "2026-04-15T12:00:00.000Z"],
        ["2026-04-15T12:00:00.5Z", "2026-04-15T12:00:00.500Z"],
        ["2026-04-15T12:00:00.123Z", "2026-04-15T12:00:00.123Z"],
        ["2026-04-15T12:00:00.123456Z", "2026-04-15T12:00:00.123Z"],
        ["2026-04-15T12:00:00.123999999Z", "2026-04-15T12:00:00.123Z"],
        ["2026-04-15T12:00:00.000000001Z", "2026-04-15T12:00:00.000Z"],
        ["2028-02-29T00:00:00Z", "2028-02-29T00:00:00.000Z"],
    ])("should accept %s and return %s when it is a valid ISO date-time with an offset", (value, expected) => {
        expect(iso(value)).toBe(expected);
    });

    it("should convert 2026-04-15T14:00:00+02:00 to 12:00:00.000Z", () => {
        expect(iso("2026-04-15T14:00:00+02:00")).toBe("2026-04-15T12:00:00.000Z");
    });

    it("should accept the lowest and highest instants of the allowed range", () => {
        expect(iso("1970-01-01T00:00:00Z")).toBe("1970-01-01T00:00:00.000Z");
        expect(iso("9999-12-31T23:59:59.999Z")).toBe("9999-12-31T23:59:59.999Z");
    });

    it.each([
        ["date only", "2026-04-15"],
        ["no offset", "2026-04-15T12:00:00"],
        ["offset without colon", "2026-04-15T12:00:00+0100"],
        ["offset hours only", "2026-04-15T12:00:00+01"],
        ["lowercase t", "2026-04-15t12:00:00Z"],
        ["lowercase z", "2026-04-15T12:00:00z"],
        ["space separator", "2026-04-15 12:00:00Z"],
        ["a space where a raw plus was decoded", "2026-04-15T12:00:00 02:00"],
        ["hour 24", "2026-04-15T24:00:00Z"],
        ["minute 60", "2026-04-15T12:60:00Z"],
        ["leap second 60", "2026-04-15T12:00:60Z"],
        ["offset hour 24", "2026-04-15T12:00:00+24:00"],
        ["offset minute 60", "2026-04-15T12:00:00+01:60"],
        ["Feb 30", "2027-02-30T00:00:00Z"],
        ["Feb 29 of a common year", "2027-02-29T00:00:00Z"],
        ["month 13", "2026-13-01T00:00:00Z"],
        ["year 0000", "0000-01-01T00:00:00Z"],
        ["year 1969", "1969-12-31T23:59:59Z"],
        ["year 10000", "10000-01-01T00:00:00Z"],
        ["an instant before the epoch through a positive offset", "1970-01-01T00:00:00+01:00"],
        ["an instant after 9999 through a negative offset", "9999-12-31T23:59:59-01:00"],
        ["ten fraction digits", "2026-04-15T12:00:00.1234567890Z"],
        ["an empty fraction", "2026-04-15T12:00:00.Z"],
        ["leading space", " 2026-04-15T12:00:00Z"],
        ["trailing newline", "2026-04-15T12:00:00Z\n"],
        ["empty string", ""],
        ["epoch digits", "1776254400"],
        ["text", "tomorrow"],
    ])("should reject %s", (_label, value) => {
        expect(parseIsoDateTimeWithOffset(value)).toBeUndefined();
    });

    it.each([[undefined], [null], [1776254400000], [true], [{}], [["2026-04-15T12:00:00Z"]], [new Date("2026-04-15T12:00:00Z")]])(
        "should reject the non-string %p",
        (value) => {
            expect(parseIsoDateTimeWithOffset(value)).toBeUndefined();
        },
    );
});
