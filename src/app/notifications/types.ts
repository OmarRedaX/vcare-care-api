import type { Knex } from "knex";
import type { Env } from "../../lib/config/types";
import type { OutboxErrorCode, OutboxKind, OutboxStatus, RecipientRole } from "./enums";

/** Flat, non-clinical render parameters; keys are restricted to `OUTBOX_PAYLOAD_KEYS`. */
export type OutboxPayload = Readonly<Record<string, string | number | boolean | null>>;

/** One email to queue; the recipient's address is resolved at send time, never stored. */
export interface OutboxMessage {
    kind: OutboxKind;
    consultationId: number;
    /** Identity user id. */
    recipientUserId: number;
    payload: OutboxPayload;
}

export interface OutboxInsertRow {
    kind: OutboxKind;
    consultation_id: number;
    recipient_user_id: number;
    payload: string;
    status: string;
    request_id: string | null;
}

/** Clock and randomness of the delivery path; production uses `SYSTEM_NOTIFICATION_TIMING`, tests a fake. */
export interface NotificationTiming { now(): number; random(): number }

/** A row leased by the claim; `attempts` is the claim number and the lease token. */
export interface OutboxClaimedRow {
    id: number;
    kind: OutboxKind;
    consultation_id: number | null;
    recipient_user_id: number;
    payload: OutboxPayload;
    attempts: number;
    request_id: string | null;
}

/** One guarded result write (`finishRows`). `attemptsDelta` is -1 for a delayed contacts failure, otherwise 0. */
export interface OutboxFinish {
    id: number;
    expectedAttempts: number;
    status: OutboxStatus;
    attemptsDelta: number;
    nextAttemptAt: Date | null;
    lastErrorCode: OutboxErrorCode | null;
    sentAt: Date | null;
}

/** What delivery needs to know about the consultation behind a row (includes soft-deleted rows). */
export interface DeliveryContext {
    status: string;
    startsAt: Date;
    endsAt: Date;
    patientUserId: number;
    doctorUserId: number;
    patientTimezone: string;
    /** `null` when the doctor profile row is gone. */
    doctorTimezone: string | null;
    deleted: boolean;
}

/** A booked consultation inside a reminder window. */
export interface ReminderCandidate {
    id: number;
    patientUserId: number;
    doctorUserId: number;
    startsAt: Date;
    endsAt: Date;
    createdAt: Date;
}

/** The reminder column a scan reads and stamps. */
export type ReminderKind = OutboxKind.Reminder24h | OutboxKind.Reminder1h;

/** Consultations-side read used by delivery (claim-time re-check and render inputs). */
export interface ConsultationDeliveryPort {
    findDeliveryContexts(ids: readonly number[], conn: Knex): Promise<Map<number, DeliveryContext>>;
}

/** Consultations-side reminder columns used by the scan; both calls run inside the scan's transaction. */
export interface ConsultationReminderPort extends ConsultationDeliveryPort {
    listReminderCandidates(kind: ReminderKind, now: Date, limit: number, trx: Knex.Transaction): Promise<ReminderCandidate[]>;
    stampReminders(ids24h: readonly number[], ids1h: readonly number[], now: Date, trx: Knex.Transaction): Promise<void>;
}

/** Locales with a template file. */
export type SupportedLocale = "en";

export interface RenderInput {
    kind: OutboxKind;
    role: RecipientRole;
    locale: string;
    recipientName: string;
    timezone: string;
    startsAtMs: number;
    previousStartsAtMs?: number;
    byRole?: "patient" | "doctor" | "admin";
}

export interface RenderedEmail { subject: string; text: string }

/** A template renders subject and body from already-formatted parts. */
export interface TemplateParts {
    greeting: string;
    when: string;
    previous: string | undefined;
    byRole: "patient" | "doctor" | "admin" | undefined;
}

export type TemplateFunction = (parts: TemplateParts) => RenderedEmail;
export type LocaleTemplates = Partial<Record<OutboxKind, Partial<Record<RecipientRole, TemplateFunction>>>>;

/** Result of a tick's delivery rounds. */
export interface DeliveryRoundResult { claimed: number; leaseLost: number }

/** The settings the delivery service reads. */
export type DeliveryEnv = Pick<Env, "OUTBOX_BATCH_SIZE" | "OUTBOX_MAX_ATTEMPTS">;
/** The setting the purge reads. */
export type PurgeEnv = Pick<Env, "OUTBOX_RETENTION_DAYS">;

/** What one scan iteration did: consultations enqueued per kind, and whether a full page suggests more. */
export interface ReminderScanCounts { enqueued24h: number; enqueued1h: number; more: boolean }

/** Verdict of the claim-time re-check: send (as `role`), or finish the row without sending. */
export type PreSendDecision =
    | { send: true; role: RecipientRole }
    | { send: false; errorCode: OutboxErrorCode };

/** A claimed row that passed the re-check, with the consultation it describes and the role of its recipient. */
export interface DeliveryCandidate { row: OutboxClaimedRow; role: RecipientRole; context: DeliveryContext }

/** A candidate with its recipient's contact (held in memory for one batch only). */
export interface SendableRow extends DeliveryCandidate { email: string; fullName: string; locale: string }
