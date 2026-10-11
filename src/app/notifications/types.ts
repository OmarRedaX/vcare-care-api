import type { OutboxKind } from "./enums";

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
