import { DateTime, IANAZone } from "luxon";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(date: string): DateTime {
    const parsed = typeof date === "string" && DATE_PATTERN.test(date) ? DateTime.fromISO(date, { zone: "utc" }) : null;
    if (parsed === null || !parsed.isValid) {
        throw new RangeError("Invalid calendar date");
    }
    return parsed;
}

export function isCalendarDate(date: string): boolean {
    return typeof date === "string" && DATE_PATTERN.test(date) && DateTime.fromISO(date, { zone: "utc" }).isValid;
}

/** Calendar maths on `YYYY-MM-DD` strings (UTC is only the carrier; no zone is involved). */
export function addDays(date: string, days: number): string {
    const result = parseDate(date).plus({ days }).toISODate();
    if (result === null) {
        throw new RangeError("Date out of range");
    }
    return result;
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
    return Math.round(parseDate(to).diff(parseDate(from), "days").days);
}

/** ISO weekday of a calendar date: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(date: string): number {
    return parseDate(date).weekday;
}

export function assertValidZone(timezone: string): void {
    if (typeof timezone !== "string" || timezone.length === 0 || !IANAZone.isValidZone(timezone)) {
        throw new RangeError("Invalid IANA timezone");
    }
}

/** The doctor-local calendar date of an instant. */
export function localDateOf(instantMs: number, timezone: string): string {
    assertValidZone(timezone);
    const date = DateTime.fromMillis(instantMs, { zone: timezone }).toISODate();
    if (date === null) {
        throw new RangeError("Instant out of range");
    }
    return date;
}
