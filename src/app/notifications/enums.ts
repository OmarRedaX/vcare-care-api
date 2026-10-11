/** Matches `chk_notification_outbox_kind` exactly. */
export enum OutboxKind {
    BookingConfirmed = "booking_confirmed",
    Reminder24h = "reminder_24h",
    Reminder1h = "reminder_1h",
    Rescheduled = "rescheduled",
    Cancelled = "cancelled",
    ScheduleBlocked = "schedule_blocked",
    DoctorJoined = "doctor_joined",
}

/** Matches `chk_notification_outbox_status` exactly. */
export enum OutboxStatus {
    Pending = "pending",
    Sent = "sent",
    Dead = "dead",
    Skipped = "skipped",
}
