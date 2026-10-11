import type { Knex } from "knex";
import type { OutboxInsertRow } from "../types";

/**
 * One multi-row INSERT inside the writer's transaction (the app role holds INSERT/SELECT only). `next_attempt_at` is the
 * database clock; `attempts` takes its column default. An empty list issues no statement.
 */
export async function insertOutboxRows(rows: readonly OutboxInsertRow[], conn: Knex.Transaction): Promise<void> {
    if (rows.length === 0) return;
    await conn("notification_outbox").insert(rows.map((row) => ({
        kind: row.kind, consultation_id: row.consultation_id, recipient_user_id: row.recipient_user_id,
        payload: row.payload, status: row.status, next_attempt_at: conn.fn.now(), request_id: row.request_id,
    })));
}
