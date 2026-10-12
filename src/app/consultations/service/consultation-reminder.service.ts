import type { Knex } from "knex";
import { injectable } from "tsyringe";
import { REMINDER_WINDOW_1H_MS, REMINDER_WINDOW_24H_MS } from "../../notifications/constants";
import { OutboxKind } from "../../notifications/enums";
import type { ConsultationReminderPort, DeliveryContext, ReminderCandidate, ReminderKind } from "../../notifications/types";
import { findDeliveryRows, listReminderRows, stampReminderColumn } from "../repository/consultations.repo";

/**
 * The consultations side of notification delivery (ADR 0011): the claim-time context of an outbox row, the reminder candidates of the
 * scan and the reminder stamps. The notifications module only sees this port, never the consultations repository.
 */
@injectable()
export class ConsultationReminderService implements ConsultationReminderPort {
    async findDeliveryContexts(ids: readonly number[], conn: Knex): Promise<Map<number, DeliveryContext>> {
        const contexts = new Map<number, DeliveryContext>();
        for (const row of await findDeliveryRows(ids, conn)) {
            contexts.set(row.id, {
                status: row.status, startsAt: row.starts_at, endsAt: row.ends_at, patientUserId: row.patient_user_id, doctorUserId: row.doctor_user_id,
                patientTimezone: row.patient_timezone, doctorTimezone: row.doctor_timezone, deleted: row.deleted_at !== null,
            });
        }
        return contexts;
    }

    async listReminderCandidates(kind: ReminderKind, now: Date, limit: number, trx: Knex.Transaction): Promise<ReminderCandidate[]> {
        const is24h = kind === OutboxKind.Reminder24h;
        const rows = await listReminderRows(is24h ? REMINDER_WINDOW_24H_MS : REMINDER_WINDOW_1H_MS,
            is24h ? "reminder_24h_sent_at" : "reminder_1h_sent_at", now, limit, trx);
        return rows.map((row) => ({
            id: row.id, patientUserId: row.patient_user_id, doctorUserId: row.doctor_user_id, startsAt: row.starts_at, endsAt: row.ends_at, createdAt: row.created_at,
        }));
    }

    async stampReminders(ids24h: readonly number[], ids1h: readonly number[], now: Date, trx: Knex.Transaction): Promise<void> {
        await stampReminderColumn(ids24h, "reminder_24h_sent_at", now, trx);
        await stampReminderColumn(ids1h, "reminder_1h_sent_at", now, trx);
    }
}
