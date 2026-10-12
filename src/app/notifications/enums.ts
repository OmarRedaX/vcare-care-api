/** Matches `chk_notification_outbox_kind` exactly. */
export enum OutboxKind {
    BookingConfirmed = "booking_confirmed",
    Reminder24h = "reminder_24h",
    Reminder1h = "reminder_1h",
    Rescheduled = "rescheduled",
    Cancelled = "cancelled",
    ScheduleBlocked = "schedule_blocked",
    DoctorJoined = "doctor_joined",
    DoctorSuspended = "doctor_suspended",
}

/** Matches `chk_notification_outbox_status` exactly. */
export enum OutboxStatus {
    Pending = "pending",
    Sent = "sent",
    Dead = "dead",
    Skipped = "skipped",
}

/** The fixed vocabulary of `notification_outbox.last_error_code` (VARCHAR(32)): never a provider or exception message. */
export enum OutboxErrorCode {
    ContactsUnavailable = "contacts_unavailable",
    EmailTimeout = "email_timeout",
    EmailError = "email_error",
    EmailRejected = "email_rejected",
    RecipientUnknown = "recipient_unknown",
    RecipientInactive = "recipient_inactive",
    ConsultationMissing = "consultation_missing",
    ConsultationChanged = "consultation_changed",
    ReminderExpired = "reminder_expired",
    TemplateMissing = "template_missing",
    LeaseExpired = "lease_expired",
}

/** Recipient role of a rendered email, derived from the database (N-D5). */
export enum RecipientRole {
    Patient = "patient",
    Doctor = "doctor",
}
