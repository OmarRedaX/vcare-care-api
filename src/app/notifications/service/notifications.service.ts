import type { Knex } from "knex";
import { injectable } from "tsyringe";
import { currentRequestId } from "../../../lib/logger/request-context";
import { isUuid } from "../../../pkg/utils/uuid";
import { OUTBOX_PAYLOAD_KEYS } from "../constants";
import { OutboxStatus } from "../enums";
import { insertOutboxRows } from "../repository/notification-outbox.repo";
import type { OutboxInsertRow, OutboxMessage } from "../types";

/** Transactional outbox writer (ADR 0011). Delivery belongs to the notification worker unit. */
@injectable()
export class NotificationsService {
    /**
     * Inserts the messages in the caller's transaction, so they commit or roll back with the change they announce. Never
     * sends anything and never calls Identity. A payload key outside the allowlist is a programming error (500).
     */
    async enqueue(trx: Knex.Transaction, messages: readonly OutboxMessage[]): Promise<void> {
        const requestId = currentRequestId();
        const rows: OutboxInsertRow[] = messages.map((message) => {
            for (const key of Object.keys(message.payload)) {
                if (!OUTBOX_PAYLOAD_KEYS.includes(key)) throw new Error(`outbox_payload_key_not_allowed: ${key}`);
            }
            return {
                kind: message.kind, consultation_id: message.consultationId, recipient_user_id: message.recipientUserId,
                payload: JSON.stringify(message.payload), status: OutboxStatus.Pending,
                request_id: requestId !== undefined && isUuid(requestId) ? requestId : null,
            };
        });
        await insertOutboxRows(rows, trx);
    }
}
