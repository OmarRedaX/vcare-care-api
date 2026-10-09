import { DateTime, IANAZone } from "luxon";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Pure cache of zone names already proven valid (names come from the profile column, so it stays small). Invalid names are never added. */
const VALIDATED_ZONES = new Set<string>();

/** Year 0000 matches the pattern and luxon, but Postgres DATE rejects it, so it is not a usable calendar date. */
function hasSupportedYear(date: string): boolean {
    return Number(date.slice(0, 4)) >= 1;
}

function parseDate(date: string): DateTime {
    const parsed = typeof date === "string" && DATE_PATTERN.test(date) && hasSupportedYear(date) ? DateTime.fromISO(date, { zone: "utc" }) : null;
    if (parsed === null || !parsed.isValid) {
        throw new RangeError("Invalid calendar date");
    }
    return parsed;
}

export function isCalendarDate(date: string): boolean {
    return typeof date === "string" && DATE_PATTERN.test(date) && hasSupportedYear(date) && DateTime.fromISO(date, { zone: "utc" }).isValid;
}

/** Epoch ms of 00:00 UTC on a `YYYY-MM-DD` calendar date (hot path: plain arithmetic, no luxon parsing). Throws RangeError when invalid. */
export function utcMidnightMs(date: string): number {
    if (typeof date !== "string" || !DATE_PATTERN.test(date) || !hasSupportedYear(date)) {
        throw new RangeError("Invalid calendar date");
    }
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(5, 7));
    const day = Number(date.slice(8, 10));
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const monthLength = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
    if (month < 1 || month > 12 || day < 1 || day > monthLength) {
        throw new RangeError("Invalid calendar date");
    }
    // Days from civil (Howard Hinnant): proleptic Gregorian days since 1970-01-01.
    const shiftedYear = month <= 2 ? year - 1 : year;
    const era = Math.floor(shiftedYear / 400);
    const yearOfEra = shiftedYear - era * 400;
    const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
    const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
    return (era * 146097 + dayOfEra - 719468) * 86_400_000;
}

/** Calendar maths on `YYYY-MM-DD` strings (UTC is only the carrier; no zone is involved). */
export function addDays(date: string, days: number): string {
    const result = parseDate(date).plus({ days }).toISODate();
    if (result === null || !hasSupportedYear(result)) {
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
    if (typeof timezone !== "string" || timezone.length === 0) {
        throw new RangeError("Invalid IANA timezone");
    }
    if (VALIDATED_ZONES.has(timezone)) {
        return;
    }
    if (!IANAZone.isValidZone(timezone)) {
        throw new RangeError("Invalid IANA timezone");
    }
    VALIDATED_ZONES.add(timezone);
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
