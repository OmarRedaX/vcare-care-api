import type { NotificationTiming, SupportedLocale } from "./types";

/**
 * The only keys an outbox payload may carry: ids, ISO instants and roles. Reasons, complaint text, names and emails are
 * never allowed (ADR 0011; consultations spec C-R17). A key outside this list is a programming error.
 */
export const OUTBOX_PAYLOAD_KEYS: readonly string[] = ["startsAt", "endsAt", "previousStartsAt", "byRole", "recipientRole"];

export const OUTBOX_LOOP_NAME = "notification-outbox";
export const REMINDER_LOOP_NAME = "consultation-reminders";
export const OUTBOX_PURGE_LOOP_NAME = "notification-outbox-purge";

/** Consultation statuses that can no longer change (a delayed `rescheduled` or `doctor_suspended` notice is moot for them, N-D14). */
export const TERMINAL_CONSULTATION_STATUSES: readonly string[] = ["cancelled", "completed", "no_show"];

/** Lease taken by the claim (`next_attempt_at = now + lease`). Must exceed `OUTBOX_BATCH_SIZE x EMAIL_SEND_TIMEOUT_MS + 2 s` (contacts call): env.ts caps the batch at 59 for 300 s. */
export const OUTBOX_LEASE_SECONDS = 300;
export const EMAIL_SEND_TIMEOUT_MS = 5_000;
export const OUTBOX_BACKOFF_BASE_MS = 30_000;
export const OUTBOX_BACKOFF_CAP_MS = 1_800_000;
/** Claim rounds per tick. */
export const OUTBOX_MAX_ROUNDS = 10;
export const REMINDER_BATCH_LIMIT = 200;
export const REMINDER_MAX_BATCHES = 5;
export const REMINDER_WINDOW_24H_MS = 24 * 60 * 60 * 1000;
export const REMINDER_WINDOW_1H_MS = 60 * 60 * 1000;
export const OUTBOX_PURGE_BATCH = 5_000;
export const OUTBOX_PURGE_MAX_BATCHES = 20;
/** Fallback locale and the longest greeting name rendered (code points). */
export const DEFAULT_LOCALE: SupportedLocale = "en";
export const GREETING_NAME_MAX_CODE_POINTS = 80;
/** Production clock and randomness of the delivery path; tests inject a fake. */
export const SYSTEM_NOTIFICATION_TIMING: NotificationTiming = { now: () => Date.now(), random: () => Math.random() };
