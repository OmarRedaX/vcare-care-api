import { localInstant } from "../../../../src/pkg/slots/instant";

const utc = (iso: string): number => Date.parse(iso);

describe("localInstant (normal times)", () => {
    it.each([
        ["UTC", "2027-06-10", 600, "2027-06-10T10:00:00Z"],
        ["Africa/Cairo", "2027-01-15", 600, "2027-01-15T08:00:00Z"],
        ["Africa/Cairo", "2027-07-15", 600, "2027-07-15T07:00:00Z"],
        ["America/New_York", "2027-01-15", 600, "2027-01-15T15:00:00Z"],
        ["America/New_York", "2027-07-15", 600, "2027-07-15T14:00:00Z"],
        ["Asia/Kolkata", "2027-07-15", 600, "2027-07-15T04:30:00Z"],
        ["Pacific/Kiritimati", "2027-07-15", 0, "2027-07-14T10:00:00Z"],
    ] as const)("should map %s %s minute %i to %s for both edges", (zone, date, minute, expected) => {
        expect(localInstant(date, minute, zone, "start")).toBe(utc(expected));
        expect(localInstant(date, minute, zone, "end")).toBe(utc(expected));
    });
});

describe("localInstant (spring-forward gap: nonexistent wall time)", () => {
    it.each([
        ["Europe/Berlin", "2027-03-28", 150, "2027-03-28T01:00:00Z"],
        ["Africa/Cairo", "2027-04-30", 30, "2027-04-29T22:00:00Z"],
        ["America/New_York", "2027-03-14", 150, "2027-03-14T07:00:00Z"],
    ] as const)("should return the transition instant for %s %s minute %i at both edges", (zone, date, minute, expected) => {
        expect(localInstant(date, minute, zone, "start")).toBe(utc(expected));
        expect(localInstant(date, minute, zone, "end")).toBe(utc(expected));
    });

    it("should map the first and last nonexistent minute of the Berlin gap to the transition", () => {
        expect(localInstant("2027-03-28", 120, "Europe/Berlin", "start")).toBe(utc("2027-03-28T01:00:00Z"));
        expect(localInstant("2027-03-28", 179, "Europe/Berlin", "end")).toBe(utc("2027-03-28T01:00:00Z"));
        expect(localInstant("2027-03-28", 180, "Europe/Berlin", "start")).toBe(utc("2027-03-28T01:00:00Z"));
        expect(localInstant("2027-03-28", 119, "Europe/Berlin", "start")).toBe(utc("2027-03-28T00:59:00Z"));
    });
});

describe("localInstant (fall-back overlap: ambiguous wall time)", () => {
    it.each([
        ["Europe/Berlin", "2027-10-31", 150, "2027-10-31T00:30:00Z", "2027-10-31T01:30:00Z"],
        ["America/New_York", "2027-11-07", 90, "2027-11-07T05:30:00Z", "2027-11-07T06:30:00Z"],
        ["Africa/Cairo", "2027-10-28", 1410, "2027-10-28T20:30:00Z", "2027-10-28T21:30:00Z"],
    ] as const)("should return the earlier instant for a start and the later for an end in %s %s minute %i", (zone, date, minute, earlier, later) => {
        expect(localInstant(date, minute, zone, "start")).toBe(utc(earlier));
        expect(localInstant(date, minute, zone, "end")).toBe(utc(later));
    });
});

describe("localInstant (minute 1440 = next local midnight)", () => {
    it("should map 1440 to the next local midnight", () => {
        expect(localInstant("2027-06-10", 1440, "UTC", "end")).toBe(utc("2027-06-11T00:00:00Z"));
        expect(localInstant("2027-06-10", 1440, "Africa/Cairo", "end")).toBe(utc("2027-06-10T21:00:00Z"));
        expect(localInstant("2027-06-10", 1440, "America/New_York", "end")).toBe(utc("2027-06-11T04:00:00Z"));
    });
    it("should map 1440 across a month and a year end", () => {
        expect(localInstant("2027-01-31", 1440, "UTC", "end")).toBe(utc("2027-02-01T00:00:00Z"));
        expect(localInstant("2027-12-31", 1440, "UTC", "end")).toBe(utc("2028-01-01T00:00:00Z"));
        expect(localInstant("2028-02-28", 1440, "UTC", "end")).toBe(utc("2028-02-29T00:00:00Z"));
    });
    it("should map 1440 to the transition when the next midnight does not exist (Cairo 2027-04-29)", () => {
        expect(localInstant("2027-04-29", 1440, "Africa/Cairo", "end")).toBe(utc("2027-04-29T22:00:00Z"));
    });
    it("should equal minute 0 of the next date", () => {
        expect(localInstant("2027-10-28", 1440, "Africa/Cairo", "end")).toBe(localInstant("2027-10-29", 0, "Africa/Cairo", "start"));
        expect(localInstant("2027-10-28", 1440, "Africa/Cairo", "end")).toBe(utc("2027-10-28T22:00:00Z"));
    });
});

describe("localInstant (input checks)", () => {
    it("should throw RangeError for an invalid zone or minute", () => {
        expect(() => localInstant("2027-06-10", 600, "Not/AZone", "start")).toThrow(RangeError);
        expect(() => localInstant("2027-06-10", -1, "UTC", "start")).toThrow(RangeError);
        expect(() => localInstant("2027-06-10", 1441, "UTC", "start")).toThrow(RangeError);
        expect(() => localInstant("2027-06-10", 1.5, "UTC", "start")).toThrow(RangeError);
    });
});
