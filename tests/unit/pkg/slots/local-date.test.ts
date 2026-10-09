import { DateTime } from "luxon";
import { addDays, assertValidZone, daysBetween, isCalendarDate, isoWeekday, localDateOf, utcMidnightMs } from "../../../../src/pkg/slots/local-date";

describe("isCalendarDate", () => {
    it.each(["2027-02-28", "2028-02-29", "2027-12-31", "2027-01-01"])("should accept the real date %s", (value) => {
        expect(isCalendarDate(value)).toBe(true);
    });
    it.each(["2027-02-30", "2027-02-29", "2027-13-01", "2027-00-10", "2027-04-31", "0000-01-01", "0000-12-31", "27-01-01", "2027-1-1", "2027-01-01T00:00", "", " 2027-01-01"])(
        "should reject %p", (value) => { expect(isCalendarDate(value)).toBe(false); });
    it.each([null, undefined, 20270101, {}, []])("should reject the non-string %p", (value) => {
        expect(isCalendarDate(value as string)).toBe(false);
    });
});

describe("addDays / daysBetween / isoWeekday", () => {
    it("should cross month, year and leap-day boundaries", () => {
        expect(addDays("2027-01-31", 1)).toBe("2027-02-01");
        expect(addDays("2027-12-31", 1)).toBe("2028-01-01");
        expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
        expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
        expect(addDays("2027-03-01", -1)).toBe("2027-02-28");
        expect(addDays("2027-03-28", 0)).toBe("2027-03-28");
    });
    it("should count whole calendar days regardless of DST (calendar maths, not elapsed time)", () => {
        expect(daysBetween("2027-03-27", "2027-03-29")).toBe(2);
        expect(daysBetween("2027-10-30", "2027-11-01")).toBe(2);
        expect(daysBetween("2027-03-29", "2027-03-27")).toBe(-2);
        expect(daysBetween("2027-05-05", "2027-05-05")).toBe(0);
    });
    it("should return ISO weekdays with Monday as 1 and Sunday as 7", () => {
        expect(isoWeekday("2027-03-22")).toBe(1);
        expect(isoWeekday("2027-03-28")).toBe(7);
        expect(isoWeekday("2027-04-29")).toBe(4);
        expect(isoWeekday("2027-04-30")).toBe(5);
    });
    it("should throw RangeError for an invalid date", () => {
        expect(() => addDays("2027-02-30", 1)).toThrow(RangeError);
        expect(() => isoWeekday("nope")).toThrow(RangeError);
        expect(() => daysBetween("2027-01-01", "2027-13-01")).toThrow(RangeError);
    });
    it("should throw RangeError for year 0000 and when date maths would leave year 1", () => {
        expect(() => addDays("0000-01-01", 1)).toThrow(RangeError);
        expect(() => isoWeekday("0000-06-01")).toThrow(RangeError);
        expect(() => addDays("0001-01-01", -1)).toThrow(RangeError);
        expect(addDays("0001-01-01", 1)).toBe("0001-01-02");
    });
});

describe("assertValidZone / localDateOf", () => {
    it("should accept IANA zones and reject others", () => {
        expect(() => assertValidZone("Africa/Cairo")).not.toThrow();
        expect(() => assertValidZone("UTC")).not.toThrow();
        for (const zone of ["Not/AZone", "", "Cairo", 5 as unknown as string]) expect(() => assertValidZone(zone)).toThrow(RangeError);
    });
    it("should still reject invalid zones after valid ones are cached, and never cache a rejected name", () => {
        for (const zone of ["Africa/Cairo", "Europe/Berlin", "Africa/Cairo"]) expect(() => assertValidZone(zone)).not.toThrow();
        for (let attempt = 0; attempt < 2; attempt += 1) {
            for (const zone of ["Not/AZone", "Africa/Cairo2", "", "Cairo"]) expect(() => assertValidZone(zone)).toThrow(RangeError);
        }
        expect(() => assertValidZone("Africa/Cairo")).not.toThrow();
    });
    it("should read the doctor-local date of an instant in either direction from UTC", () => {
        const instant = Date.parse("2027-06-10T22:30:00Z");
        expect(localDateOf(instant, "UTC")).toBe("2027-06-10");
        expect(localDateOf(instant, "Africa/Cairo")).toBe("2027-06-11");
        expect(localDateOf(instant, "Pacific/Kiritimati")).toBe("2027-06-11");
        expect(localDateOf(instant, "Pacific/Pago_Pago")).toBe("2027-06-10");
        expect(localDateOf(Date.parse("2027-06-10T05:00:00Z"), "America/New_York")).toBe("2027-06-10");
        expect(localDateOf(Date.parse("2027-06-10T03:00:00Z"), "America/New_York")).toBe("2027-06-09");
    });
    it("should reject an invalid zone", () => {
        expect(() => localDateOf(0, "Not/AZone")).toThrow(RangeError);
    });
});

describe("utcMidnightMs", () => {
    it("should agree with luxon for every day across leap and century years", () => {
        for (const date of ["0001-01-01", "1970-01-01", "1999-12-31", "2000-02-29", "2100-03-01", "2027-03-28", "2028-02-29", "9999-12-31"]) {
            expect(utcMidnightMs(date)).toBe(DateTime.fromISO(date, { zone: "utc" }).toMillis());
        }
        let cursor = "2026-12-25";
        for (let step = 0; step < 800; step += 1) {
            expect(utcMidnightMs(cursor)).toBe(DateTime.fromISO(cursor, { zone: "utc" }).toMillis());
            cursor = addDays(cursor, 1);
        }
    });
    it.each(["0000-01-01", "2027-02-29", "2100-02-29", "2027-04-31", "2027-13-01", "2027-00-10", "nope", ""])("should throw RangeError for %p", (value) => {
        expect(() => utcMidnightMs(value)).toThrow(RangeError);
    });
});
