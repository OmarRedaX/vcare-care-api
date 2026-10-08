import { addDays, daysBetween } from "../../pkg/slots/local-date";
import { formatTimeOfDay } from "../../pkg/slots/local-time";
import { MAX_EXCEPTION_RANGE_DATES, MAX_INTERVALS_PER_DAY, MAX_WEEKDAYS } from "./constants";
import { ConsultationTypeField, ScheduleExceptionType } from "./enums";
import {
    CustomHoursWithEndDate, CustomHoursWithoutTimes, DayOffWithTimes, DuplicateWeekday, ExceptionEndDateBeforeDate,
    ExceptionRangeTooLong, ExceptionTimesOutOfOrder, invalidWorkingHours,
} from "./errors";
import type { ConsultationType } from "./entity/consultation-type.entity";
import type { WorkingHour } from "./entity/working-hour.entity";
import type { ConsultationTypeChanges, ConsultationTypeDiff, ExceptionInput, WorkingHoursDayInput, WorkingHoursDayView, WorkingHoursInsertRow } from "./types";

/** Pure Care rules: no I/O, no clock. Cross-field validation the DTO decorators cannot express. */

/** Per weekday: one entry, 1-6 intervals, `start < end`, no overlap (touching is allowed). Before any I/O. */
export function assertValidHours(days: readonly WorkingHoursDayInput[]): void {
    if (days.length > MAX_WEEKDAYS) throw invalidWorkingHours("days", "must contain at most 7 days");
    const seen = new Set<number>();
    days.forEach((day, index) => {
        if (seen.has(day.weekday)) throw DuplicateWeekday;
        seen.add(day.weekday);
        const field = `days[${index}].intervals`;
        if (day.intervals.length < 1 || day.intervals.length > MAX_INTERVALS_PER_DAY) throw invalidWorkingHours(field, "must contain between 1 and 6 intervals");
        for (const interval of day.intervals) {
            if (interval.endMinute <= interval.startMinute) throw invalidWorkingHours(field, "endTime must be after startTime");
            if (interval.startMinute >= 1440) throw invalidWorkingHours(field, "startTime must be before 24:00");
        }
        const sorted = [...day.intervals].sort((a, b) => a.startMinute - b.startMinute);
        for (let i = 1; i < sorted.length; i += 1) {
            const previous = sorted[i - 1];
            const current = sorted[i];
            if (previous !== undefined && current !== undefined && current.startMinute < previous.endMinute) throw invalidWorkingHours(field, "intervals must not overlap");
        }
    });
}

/** The rows to store, ascending by weekday then start. */
export function normalizeHours(days: readonly WorkingHoursDayInput[]): WorkingHoursInsertRow[] {
    return days
        .flatMap((day) => day.intervals.map((interval) => ({ weekday: day.weekday, startMinute: interval.startMinute, endMinute: interval.endMinute })))
        .sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute)
        .map((row) => ({ weekday: row.weekday, startTime: formatTimeOfDay(row.startMinute), endTime: formatTimeOfDay(row.endMinute) }));
}

/** Equal sets, ignoring order. `current` rows are the stored entities (`HH:mm`). */
export function sameHours(current: readonly WorkingHour[], next: readonly WorkingHoursInsertRow[]): boolean {
    if (current.length !== next.length) return false;
    const key = (weekday: number, start: string, end: string): string => `${weekday}|${start}|${end}`;
    const stored = current.map((row) => key(row.weekday, row.startTime, row.endTime)).sort();
    const wanted = next.map((row) => key(row.weekday, row.startTime, row.endTime)).sort();
    return stored.every((value, index) => value === wanted[index]);
}

/** `date..endDate` inclusive, one string per local date; at most 60 dates. */
export function expandExceptionDates(date: string, endDate: string | null): string[] {
    if (endDate === null) return [date];
    const span = daysBetween(date, endDate);
    if (span < 0) throw ExceptionEndDateBeforeDate;
    if (span + 1 > MAX_EXCEPTION_RANGE_DATES) throw ExceptionRangeTooLong;
    return Array.from({ length: span + 1 }, (_unused, offset) => addDays(date, offset));
}

/** `day_off` has no times; `custom_hours` has both (`end > start`) and exactly one date. */
export function assertExceptionShape(input: ExceptionInput): void {
    if (input.type === ScheduleExceptionType.DayOff) {
        if (input.startMinute !== null || input.endMinute !== null) throw DayOffWithTimes;
        return;
    }
    if (input.startMinute === null || input.endMinute === null) throw CustomHoursWithoutTimes;
    if (input.endDate !== null) throw CustomHoursWithEndDate;
    if (input.endMinute <= input.startMinute || input.startMinute >= 1440) throw ExceptionTimesOutOfOrder;
}

/** A field is changed only when provided and different from the current value. */
export function diffConsultationType(current: ConsultationType, changes: ConsultationTypeChanges): ConsultationTypeDiff {
    const fields: ConsultationTypeField[] = [];
    const columns: ConsultationTypeDiff["columns"] = {};
    if (changes.name !== undefined && changes.name !== current.name) { fields.push(ConsultationTypeField.Name); columns.name = changes.name; }
    if (changes.durationMinutes !== undefined && changes.durationMinutes !== current.durationMinutes) { fields.push(ConsultationTypeField.DurationMinutes); columns.duration_minutes = changes.durationMinutes; }
    if (changes.price !== undefined && changes.price !== current.price) { fields.push(ConsultationTypeField.Price); columns.price = changes.price; }
    if (changes.currency !== undefined && changes.currency !== current.currency) { fields.push(ConsultationTypeField.Currency); columns.currency = changes.currency; }
    if (changes.isActive !== undefined && changes.isActive !== current.isActive) { fields.push(ConsultationTypeField.IsActive); columns.is_active = changes.isActive; }
    fields.sort();
    return { fields, columns };
}

/** Stored rows (ascending weekday, start) grouped into the wire shape; weekdays without intervals are omitted. */
export function groupHours(hours: readonly WorkingHour[]): WorkingHoursDayView[] {
    const days: WorkingHoursDayView[] = [];
    for (const hour of [...hours].sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime))) {
        const interval = { startTime: hour.startTime, endTime: hour.endTime };
        const last = days[days.length - 1];
        if (last !== undefined && last.weekday === hour.weekday) last.intervals.push(interval);
        else days.push({ weekday: hour.weekday, intervals: [interval] });
    }
    return days;
}
