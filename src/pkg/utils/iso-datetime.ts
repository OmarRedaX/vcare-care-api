import { isCalendarDate } from "../slots/local-date";

const ISO_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
const MIN_YEAR = 1970;
const MAX_INSTANT_MS = 253_402_300_799_999;
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;

/**
 * Parses `YYYY-MM-DDTHH:MM:SS[.f{1,9}](Z|+HH:MM|-HH:MM)` (uppercase `T`/`Z`, real calendar date, no leap second) into the UTC
 * instant, truncated to milliseconds. Returns `undefined` for anything else and for instants outside
 * 1970-01-01T00:00:00Z .. 9999-12-31T23:59:59.999Z. Pure: no clock, no locale.
 */
export function parseIsoDateTimeWithOffset(value: unknown): Date | undefined {
    if (typeof value !== "string") return undefined;
    const match = ISO_DATE_TIME_PATTERN.exec(value);
    if (match === null) return undefined;
    const [, year, month, day, hour, minute, second, fraction, offset] = match;
    if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined || second === undefined || offset === undefined) return undefined;
    if (Number(year) < MIN_YEAR || !isCalendarDate(`${year}-${month}-${day}`)) return undefined;
    if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return undefined;
    let offsetMs = 0;
    if (offset !== "Z") {
        const offsetHours = Number(offset.slice(1, 3));
        const offsetMinutes = Number(offset.slice(4, 6));
        if (offsetHours > 23 || offsetMinutes > 59) return undefined;
        const sign = offset.startsWith("-") ? -1 : 1;
        offsetMs = sign * (offsetHours * MINUTES_PER_HOUR + offsetMinutes) * MS_PER_MINUTE;
    }
    const milliseconds = fraction === undefined ? 0 : Number(fraction.padEnd(3, "0").slice(0, 3));
    const instant = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), milliseconds) - offsetMs;
    if (instant < 0 || instant > MAX_INSTANT_MS) return undefined;
    return new Date(instant);
}
