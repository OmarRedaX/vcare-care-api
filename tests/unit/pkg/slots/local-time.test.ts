import { formatTimeOfDay, parseTimeOfDay } from "../../../../src/pkg/slots/local-time";

describe("parseTimeOfDay / formatTimeOfDay", () => {
    it.each([["00:00", 0], ["09:30", 570], ["23:59", 1439], ["24:00", 1440]] as const)(
        "should round-trip %s as %i minutes", (text, minutes) => {
            expect(parseTimeOfDay(text)).toBe(minutes);
            expect(formatTimeOfDay(minutes)).toBe(text);
        });

    it.each(["24:01", "9:00", "ab", "25:00", "", "09:60", "09:5", "09:30:00", " 09:30", "9h", "-1:00", "24:30"])(
        "should reject %p when it is not a time of day", (text) => {
            expect(() => parseTimeOfDay(text)).toThrow(RangeError);
        });

    it.each([null, undefined, 930, {}])("should reject the non-string %p", (value) => {
        expect(() => parseTimeOfDay(value as string)).toThrow(RangeError);
    });

    it.each([-1, 1441, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("should reject formatting %p minutes", (minutes) => {
        expect(() => formatTimeOfDay(minutes)).toThrow(RangeError);
    });

    it("should round-trip every minute of the day", () => {
        for (let minute = 0; minute <= 1440; minute += 1) {
            expect(parseTimeOfDay(formatTimeOfDay(minute))).toBe(minute);
        }
    });
});
