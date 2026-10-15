import type { Knex } from "knex";
import type { Logger } from "../../../lib/logger/logger";
import type { TickOutcome } from "../../../lib/worker/types";
import { REMINDER_BATCH_LIMIT, REMINDER_MAX_BATCHES, REMINDER_WINDOW_1H_MS, REMINDER_WINDOW_24H_MS } from "../constants";
import { OutboxKind, RecipientRole } from "../enums";
import { findQueuedReminders } from "../repository/notification-outbox.repo";
import type { ConsultationReminderPort, NotificationTiming, OutboxMessage, ReminderCandidate, ReminderKind, ReminderScanCounts } from "../types";
import type { NotificationsService } from "./notifications.service";

/**
 * The 1-minute reminder scan (ADR 0011, spec 3.5). Each iteration is ONE transaction with a fixed statement count: lock the due
 * consultations (`FOR UPDATE OF c SKIP LOCKED`), enqueue the messages and stamp the reminder columns, so two workers or a concurrent
 * reschedule/cancel cannot produce a duplicate or half-applied reminder. The scan does not look at Identity; delivery does.
 */
export class ReminderScanService {
    constructor(
        private readonly db: Knex,
        private readonly consultations: ConsultationReminderPort,
        private readonly notifications: NotificationsService,
        private readonly logger: Logger,
        private readonly timing: NotificationTiming,
    ) {}

    async tick(signal: AbortSignal): Promise<TickOutcome> {
        for (let batch = 0; batch < REMINDER_MAX_BATCHES && !signal.aborted; batch++) {
            const counts = await this.scanOnce();
            if (counts.enqueued24h > 0) this.logger.metric("notification_reminders_enqueued", counts.enqueued24h, { kind: OutboxKind.Reminder24h });
            if (counts.enqueued1h > 0) this.logger.metric("notification_reminders_enqueued", counts.enqueued1h, { kind: OutboxKind.Reminder1h });
            if (!counts.more) break;
        }
        return "done";
    }

    /** One iteration in one transaction (handler form); `more` = a query returned a full page, so another iteration is worthwhile. */
    async scanOnce(): Promise<ReminderScanCounts> {
        return this.db.transaction(async (trx) => {
            const now = new Date(this.timing.now());
            const due24 = await this.consultations.listReminderCandidates(OutboxKind.Reminder24h, now, REMINDER_BATCH_LIMIT, trx);
            const due1 = await this.consultations.listReminderCandidates(OutboxKind.Reminder1h, now, REMINDER_BATCH_LIMIT, trx);

            const enqueue24 = due24.filter((candidate) => !isStampOnly(OutboxKind.Reminder24h, candidate, now.getTime()));
            const enqueue1 = due1.filter((candidate) => !isStampOnly(OutboxKind.Reminder1h, candidate, now.getTime()));
            // A reschedule A -> B -> A re-arms the stamps while the first reminder for A may still be queued or sent: one statement finds those.
            const queued = await findQueuedReminders([...new Set([...enqueue24, ...enqueue1].map((candidate) => candidate.id))], trx);
            const alreadyQueued = new Set(queued.map((reminder) => queuedKey(reminder.kind, reminder.consultationId, reminder.recipientUserId, reminder.startsAt)));
            await this.notifications.enqueue(trx, [
                ...enqueue24.flatMap((candidate) => reminderMessages(OutboxKind.Reminder24h, candidate)),
                ...enqueue1.flatMap((candidate) => reminderMessages(OutboxKind.Reminder1h, candidate)),
            ].filter((message) => !alreadyQueued.has(queuedKey(message.kind, message.consultationId, message.recipientUserId, String(message.payload.startsAt)))));
            await this.consultations.stampReminders(due24.map((candidate) => candidate.id), due1.map((candidate) => candidate.id), now, trx);
            return {
                enqueued24h: enqueue24.length, enqueued1h: enqueue1.length,
                more: due24.length >= REMINDER_BATCH_LIMIT || due1.length >= REMINDER_BATCH_LIMIT,
            };
        });
    }
}

/**
 * Stamp without a message: a consultation booked inside the window is covered by the booking confirmation, and a 24 h reminder
 * within the last hour is superseded by the 1 h one (N-D6).
 */
function isStampOnly(kind: ReminderKind, candidate: ReminderCandidate, nowMs: number): boolean {
    const startsAtMs = candidate.startsAt.getTime();
    const windowMs = kind === OutboxKind.Reminder24h ? REMINDER_WINDOW_24H_MS : REMINDER_WINDOW_1H_MS;
    if (candidate.createdAt.getTime() >= startsAtMs - windowMs) return true;
    return kind === OutboxKind.Reminder24h && startsAtMs - nowMs <= REMINDER_WINDOW_1H_MS;
}

function queuedKey(kind: OutboxKind, consultationId: number, recipientUserId: number, startsAt: string): string {
    return `${kind}|${consultationId}|${recipientUserId}|${startsAt}`;
}

function reminderMessages(kind: ReminderKind, candidate: ReminderCandidate): OutboxMessage[] {
    const base = { startsAt: candidate.startsAt.toISOString(), endsAt: candidate.endsAt.toISOString() };
    return [
        { kind, consultationId: candidate.id, recipientUserId: candidate.patientUserId, payload: { ...base, recipientRole: RecipientRole.Patient } },
        { kind, consultationId: candidate.id, recipientUserId: candidate.doctorUserId, payload: { ...base, recipientRole: RecipientRole.Doctor } },
    ];
}
