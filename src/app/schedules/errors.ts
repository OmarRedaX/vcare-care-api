import { AppError } from "../../lib/error/AppError";
import { Conflict, ValidationFailed } from "../../lib/error/errors";

export const ExceptionDateTaken = Conflict.withDetails([{ field: "date", issue: "already has a schedule exception" }]);
export const ConsultationTypeNameTaken = Conflict.withDetails([{ field: "name", issue: "is already used by another consultation type" }]);
export const ConsultationTypeLimitReached = Conflict.withDetails([{ field: "consultationTypes", issue: "limit of 20 consultation types reached" }]);
export const TypeCurrencyMismatch = ValidationFailed.withDetails([{ field: "currency", issue: "must equal the profile currency and be an allowed currency" }]);
export const ExceptionInPast = ValidationFailed.withDetails([{ field: "date", issue: "must not be before today in the doctor's timezone" }]);
export const EmptyConsultationTypeUpdate = ValidationFailed.withDetails([{ field: "body", issue: "must contain at least one property" }]);
export const DayOffWithTimes = ValidationFailed.withDetails([{ field: "startTime", issue: "and endTime must be absent for a day_off exception" }]);
export const CustomHoursWithoutTimes = ValidationFailed.withDetails([{ field: "startTime", issue: "and endTime are required for a custom_hours exception" }]);
export const CustomHoursWithEndDate = ValidationFailed.withDetails([{ field: "endDate", issue: "must be absent for a custom_hours exception" }]);
export const ExceptionTimesOutOfOrder = ValidationFailed.withDetails([{ field: "endTime", issue: "must be after startTime" }]);
export const ExceptionEndDateBeforeDate = ValidationFailed.withDetails([{ field: "endDate", issue: "must not be before date" }]);
export const ExceptionRangeTooLong = ValidationFailed.withDetails([{ field: "endDate", issue: "range must cover at most 60 dates" }]);
export const DateRangeReversed = ValidationFailed.withDetails([{ field: "fromDate", issue: "must not be after toDate" }]);
export const DuplicateWeekday = ValidationFailed.withDetails([{ field: "days", issue: "must contain each weekday at most once" }]);

/** `details[].field` is a path such as `days[2].intervals`; the rejected value is never echoed. */
export function invalidWorkingHours(field: string, issue: string): AppError {
    return ValidationFailed.withDetails([{ field, issue }]);
}

/** 409 with the affected consultation ids as a sibling `conflicts` member (contract `ScheduleConflicts`). */
export function scheduleConflictsUnconfirmed(ids: readonly number[]): AppError {
    return new AppError("ScheduleConflictsUnconfirmed", 409, "The change affects existing consultations; resubmit with confirmConflicts=true")
        .withExtra({ conflicts: { consultationIds: [...ids], count: ids.length } });
}
