import { OutboxErrorCode, OutboxKind, RecipientRole } from "./enums";
import { TERMINAL_CONSULTATION_STATUSES } from "./constants";
import type { DeliveryContext, OutboxClaimedRow, PreSendDecision } from "./types";
import { hasTemplate } from "./templates/registry";

const REMINDER_KINDS: readonly OutboxKind[] = [OutboxKind.Reminder24h, OutboxKind.Reminder1h];
const BY_ROLES: readonly string[] = ["patient", "doctor", "admin"];

/** The recipient's role, derived from the database and never from `payload.recipientRole` (N-D5). */
export function recipientRoleOf(recipientUserId: number, context: DeliveryContext): RecipientRole | undefined {
    if (recipientUserId === context.patientUserId) return RecipientRole.Patient;
    if (recipientUserId === context.doctorUserId) return RecipientRole.Doctor;
    return undefined;
}

/** The instant an email talks about: `payload.startsAt` when it is a valid ISO instant, else the consultation's current start. */
export function payloadInstantMs(row: OutboxClaimedRow, key: "startsAt" | "previousStartsAt"): number | undefined {
    const value = row.payload[key];
    if (typeof value !== "string") return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

export function payloadByRole(row: OutboxClaimedRow): "patient" | "doctor" | "admin" | undefined {
    const value = row.payload.byRole;
    return typeof value === "string" && BY_ROLES.includes(value) ? (value as "patient" | "doctor" | "admin") : undefined;
}

/**
 * The claim-time re-check (spec 3.4 step 4). Reminders are derived from state, so one for a consultation that is gone, no longer
 * `booked`, moved, or started is dropped. A delayed `rescheduled` notice is dropped once the consultation is terminal or has moved again,
 * and a `doctor_suspended` notice once it is terminal (N-D14); other event notifications, and every `cancelled` notice, are sent regardless.
 */
export function decidePreSend(row: OutboxClaimedRow, context: DeliveryContext | undefined, nowMs: number): PreSendDecision {
    if (context === undefined) return { send: false, errorCode: OutboxErrorCode.ConsultationMissing };
    if (REMINDER_KINDS.includes(row.kind)) {
        if (context.deleted || context.status !== "booked") return { send: false, errorCode: OutboxErrorCode.ConsultationChanged };
        if (payloadInstantMs(row, "startsAt") !== context.startsAt.getTime()) return { send: false, errorCode: OutboxErrorCode.ConsultationChanged };
        if (nowMs >= context.startsAt.getTime()) return { send: false, errorCode: OutboxErrorCode.ReminderExpired };
    }
    if (row.kind === OutboxKind.Rescheduled) {
        const payloadStart = payloadInstantMs(row, "startsAt");
        if (TERMINAL_CONSULTATION_STATUSES.includes(context.status) || (payloadStart !== undefined && payloadStart !== context.startsAt.getTime())) {
            return { send: false, errorCode: OutboxErrorCode.ConsultationChanged };
        }
    }
    if (row.kind === OutboxKind.DoctorSuspended && TERMINAL_CONSULTATION_STATUSES.includes(context.status)) {
        return { send: false, errorCode: OutboxErrorCode.ConsultationChanged };
    }
    const role = recipientRoleOf(row.recipient_user_id, context);
    if (role === undefined) return { send: false, errorCode: OutboxErrorCode.ConsultationChanged };
    if (!hasTemplate(row.kind, role)) return { send: false, errorCode: OutboxErrorCode.TemplateMissing };
    return { send: true, role };
}
