/** Audit entity type of every attachment row (`attachment.added`, `attachment.removed`, `attachment.url_issued`). */
export const RECORD_ATTACHMENT_ENTITY_TYPE = "record_attachment";
/** Domain rule (CLAUDE.md → Clinical): a record holds at most this many live attachments (RA-D5). */
export const RECORD_ATTACHMENT_MAX_PER_RECORD = 20;
export const ATTACHMENT_DESCRIPTION_MAX_LENGTH = 500;
/** Final object key prefix; the verified object is promoted from `quarantine/<uuid>` to `record-attachments/<uuid>`. */
export const RECORD_ATTACHMENT_KEY_PREFIX = "record-attachments/";
/** The trigger that repeats the delete-after-lock verdict in the database; its `check_violation` maps to `RecordLocked`. */
export const TRG_RECORD_ATTACHMENTS_FORBID_DELETE_AFTER_LOCK = "trg_record_attachments_forbid_delete_after_lock";

/** Rate limits (spec 4.12), all per user, Redis sliding window. `complete` and `DELETE` share one bucket. */
export const RECORD_ATTACHMENTS_INTENT_WINDOW_MS = 3_600_000;
export const RECORD_ATTACHMENTS_INTENT_USER_LIMIT = 20;
export const RECORD_ATTACHMENTS_INTENT_RATE_NAME = "record-attachments-intent-user";
export const RECORD_ATTACHMENTS_RATE_WINDOW_MS = 60_000;
export const RECORD_ATTACHMENTS_WRITE_USER_LIMIT = 20;
export const RECORD_ATTACHMENTS_WRITE_RATE_NAME = "record-attachments-write-user";
export const RECORD_ATTACHMENTS_READ_USER_LIMIT = 120;
export const RECORD_ATTACHMENTS_READ_RATE_NAME = "record-attachments-read-user";
