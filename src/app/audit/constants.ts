export const AUDIT_DEFAULT_WINDOW_DAYS = 30;
export const AUDIT_READ_LIMIT = 120;
export const AUDIT_READ_WINDOW_MS = 60_000;
export const AUDIT_READ_RATE_NAME = "audit-read";
export const AUDIT_ACTION_MAX_LENGTH = 64;
export const AUDIT_ENTITY_TYPE_MAX_LENGTH = 64;
export const AUDIT_DATE_MAX_LENGTH = 40;
/** `created_at` at full microsecond precision (foundation fix #7). */
export const AUDIT_CURSOR_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
/** The frozen exclusive upper bound, millisecond ISO form. */
export const AUDIT_CURSOR_TO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
