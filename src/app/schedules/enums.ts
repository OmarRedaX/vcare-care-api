/** Matches `chk_schedule_exceptions_type` exactly. */
export enum ScheduleExceptionType { DayOff = "day_off", CustomHours = "custom_hours" }

export enum ScheduleAuditAction {
    HoursReplaced = "schedule.hours_replaced",
    ExceptionCreated = "schedule.exception_created",
    ExceptionDeleted = "schedule.exception_deleted",
    ConflictsConfirmed = "schedule.conflicts_confirmed",
}

export enum ConsultationTypeAuditAction { Created = "consultation_type.created", Updated = "consultation_type.updated" }

/** What changed, handed to the `ScheduleChangeListener` after commit. */
export enum ScheduleChangeKind { WorkingHours = "working_hours", ScheduleException = "schedule_exception", ConsultationType = "consultation_type" }

/** Wire names of the updatable consultation type members (audit `changedFields`). */
export enum ConsultationTypeField { Name = "name", DurationMinutes = "durationMinutes", Price = "price", Currency = "currency", IsActive = "isActive" }
