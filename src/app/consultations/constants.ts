/** Booking writes (book, reschedule, cancel): 10/min per patient or doctor, one shared bucket (spec 3.9). */
export const CONSULTATIONS_WRITE_USER_LIMIT = 10;
/** Admin on-behalf work gets its own bucket: a suspension can flag dozens of rows. */
export const CONSULTATIONS_WRITE_ADMIN_LIMIT = 60;
export const CONSULTATIONS_READ_USER_LIMIT = 120;
export const CONSULTATIONS_RATE_WINDOW_MS = 60_000;
export const CONSULTATIONS_WRITE_USER_RATE_NAME = "consultations-write-user";
export const CONSULTATIONS_WRITE_ADMIN_RATE_NAME = "consultations-write-admin";
export const CONSULTATIONS_READ_RATE_NAME = "consultations-read-user";

export const CONSULTATION_ENTITY_TYPE = "consultation";
export const EXCL_CONSULTATIONS_DOCTOR_NO_OVERLAP = "excl_consultations_doctor_no_overlap";
export const UQ_CONSULTATIONS_IDEMPOTENCY = "uq_consultations_idempotency";

export const COMPLAINT_MIN_LENGTH = 3;
export const COMPLAINT_MAX_LENGTH = 4000;
export const REASON_MIN_LENGTH = 3;
export const REASON_MAX_LENGTH = 1000;
export const TIMEZONE_MAX_LENGTH = 64;
export const MAX_STATUS_FILTER = 6;
/** `chk_consultation_types_duration` caps a type at 240 minutes; the lower bound only makes the `upcoming` range scan sargable. */
export const MAX_DURATION_MINUTES = 240;
/** Doctor-local dates resolved on each side of a booking date, so an interval that crosses midnight is still seen. */
export const OPEN_DAYS_MARGIN = 1;
