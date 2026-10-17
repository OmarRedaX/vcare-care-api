/** Matches `chk_consultations_status` exactly. */
export enum ConsultationStatus {
    Booked = "booked",
    Waiting = "waiting",
    InProgress = "in_progress",
    Completed = "completed",
    Cancelled = "cancelled",
    NoShow = "no_show",
}

/** Matches `chk_consultations_cancelled_by` exactly. */
export enum CancelledBy {
    Patient = "patient",
    Doctor = "doctor",
    Admin = "admin",
}

/** Matches `chk_consultations_followup_reason` exactly. */
export enum FollowupReason {
    DoctorSuspended = "doctor_suspended",
    ScheduleBlocked = "schedule_blocked",
}

export enum ConsultationScope {
    Upcoming = "upcoming",
    Past = "past",
    All = "all",
}

export enum ConsultationAuditAction {
    Booked = "consultation.booked",
    Rescheduled = "consultation.rescheduled",
    Cancelled = "consultation.cancelled",
    Read = "consultation.read",
    Waiting = "consultation.waiting",
    Started = "consultation.started",
    Completed = "consultation.completed",
    NoShow = "consultation.no_show",
}

/** What `ConsultationChangeListener` is told after commit. */
export enum ConsultationChangeKind {
    Booked = "booked",
    Rescheduled = "rescheduled",
    Cancelled = "cancelled",
    Completed = "completed",
    NoShow = "no_show",
}
