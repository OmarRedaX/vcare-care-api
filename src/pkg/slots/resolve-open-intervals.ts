import { localInstant } from "./instant";
import { mergeLocalIntervals, mergeUtcIntervals } from "./intervals";
import { addDays, assertValidZone, daysBetween, isCalendarDate, isoWeekday } from "./local-date";
import type { ExceptionRule, LocalInterval, OpenDay, ResolveOpenIntervalsInput, UtcInterval, WeeklyHoursRule } from "./types";

export const MAX_RESOLVE_DATES = 400;

function assertInterval(interval: LocalInterval): void {
    const { startMinute, endMinute } = interval;
    if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute) || startMinute < 0 || endMinute > 1440 || startMinute >= endMinute) {
        throw new RangeError("Invalid local interval");
    }
}

function weeklyByWeekday(weekly: readonly WeeklyHoursRule[]): Map<number, LocalInterval[]> {
    const byWeekday = new Map<number, LocalInterval[]>();
    for (const rule of weekly) {
        if (!Number.isInteger(rule.weekday) || rule.weekday < 1 || rule.weekday > 7) {
            throw new RangeError("Invalid weekday");
        }
        rule.intervals.forEach(assertInterval);
        byWeekday.set(rule.weekday, [...(byWeekday.get(rule.weekday) ?? []), ...rule.intervals]);
    }
    for (const [weekday, intervals] of byWeekday) {
        byWeekday.set(weekday, mergeLocalIntervals(intervals));
    }
    return byWeekday;
}

function exceptionsByDate(exceptions: readonly ExceptionRule[]): Map<string, ExceptionRule> {
    const byDate = new Map<string, ExceptionRule>();
    for (const exception of exceptions) {
        if (!isCalendarDate(exception.date) || byDate.has(exception.date)) {
            throw new RangeError("Invalid or duplicate exception date");
        }
        if (exception.type === "custom_hours") {
            if (exception.startMinute === null || exception.endMinute === null) {
                throw new RangeError("custom_hours needs both times");
            }
            assertInterval({ startMinute: exception.startMinute, endMinute: exception.endMinute });
        }
        byDate.set(exception.date, exception);
    }
    return byDate;
}

function localIntervalsOf(date: string, weekly: Map<number, LocalInterval[]>, exceptions: Map<string, ExceptionRule>): LocalInterval[] {
    const exception = exceptions.get(date);
    if (exception !== undefined) {
        if (exception.type === "day_off" || exception.startMinute === null || exception.endMinute === null) {
            return [];
        }
        return [{ startMinute: exception.startMinute, endMinute: exception.endMinute }];
    }
    return weekly.get(isoWeekday(date)) ?? [];
}

/**
 * Hours + exceptions to merged UTC open intervals, one `OpenDay` per doctor-local date in `[fromDate, toDate]`.
 * A `day_off` empties the date; `custom_hours` REPLACES the weekday's hours (never merged with them). Pure: no
 * clock, no I/O. Throws `RangeError` on invalid input.
 */
export function resolveOpenIntervals(input: ResolveOpenIntervalsInput): OpenDay[] {
    assertValidZone(input.timezone);
    if (!isCalendarDate(input.fromDate) || !isCalendarDate(input.toDate)) {
        throw new RangeError("Invalid date range");
    }
    const span = daysBetween(input.fromDate, input.toDate);
    if (span < 0 || span + 1 > MAX_RESOLVE_DATES) {
        throw new RangeError("Date range out of bounds");
    }
    const weekly = weeklyByWeekday(input.weekly);
    const exceptions = exceptionsByDate(input.exceptions);

    const days: OpenDay[] = [];
    for (let offset = 0; offset <= span; offset += 1) {
        const date = addDays(input.fromDate, offset);
        const utc: UtcInterval[] = [];
        for (const local of localIntervalsOf(date, weekly, exceptions)) {
            const startMs = localInstant(date, local.startMinute, input.timezone, "start");
            const endMs = localInstant(date, local.endMinute, input.timezone, "end");
            if (endMs > startMs) {
                utc.push({ startMs, endMs });
            }
        }
        days.push({ date, intervals: mergeUtcIntervals(utc) });
    }
    return days;
}
