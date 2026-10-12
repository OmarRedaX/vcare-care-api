import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";
import { OutboxStatus } from "../enums";
import type { OutboxClaimedRow, OutboxFinish, OutboxInsertRow } from "../types";

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

/**
 * The claim: ONE autocommit statement that leases due rows (`FOR UPDATE SKIP LOCKED` inside the statement), bumps `attempts` (the claim
 * number, i.e. the lease token) and pushes `next_attempt_at` out by the lease. The rows stay `pending`; no transaction stays open while
 * Identity or the email provider is called. Served by `idx_notification_outbox_pending_next_attempt_at_id`. Sorted by id for stable processing.
 */
export async function claimDue(now: Date, limit: number, leaseSeconds: number, conn: Knex = db): Promise<OutboxClaimedRow[]> {
    const result = await conn.raw<{ rows: OutboxClaimedRow[] }>(
        `WITH due AS (
            SELECT id FROM notification_outbox
            WHERE status = 'pending' AND next_attempt_at <= ?::timestamptz
            ORDER BY next_attempt_at, id
            LIMIT ?
            FOR UPDATE SKIP LOCKED)
        UPDATE notification_outbox o
        SET attempts = o.attempts + 1, next_attempt_at = ?::timestamptz + make_interval(secs => ?)
        FROM due WHERE o.id = due.id
        RETURNING o.id, o.kind, o.consultation_id, o.recipient_user_id, o.payload, o.attempts, o.request_id`,
        [now, limit, now, leaseSeconds],
    );
    return [...result.rows].sort((a, b) => a.id - b.id);
}

/** Age in whole seconds of the oldest due `pending` row (first entry of the claim index); 0 when none is due. */
export async function oldestDueAgeSeconds(now: Date, conn: Knex = db): Promise<number> {
    const row = await conn("notification_outbox").where("status", OutboxStatus.Pending).where("next_attempt_at", "<=", now)
        .min<{ oldest: Date | null }>({ oldest: "next_attempt_at" }).first();
    const oldest = row?.oldest ?? null;
    return oldest === null ? 0 : Math.max(0, Math.round((now.getTime() - oldest.getTime()) / 1000));
}

/**
 * Guarded result writes: a row changes only while it is still `pending` AND still at the claimed attempt number, so a slow worker never
 * overwrites a re-claimed row. One statement for any number of rows; returns the ids actually written (the others lost their lease).
 */
export async function finishRows(finishes: readonly OutboxFinish[], conn: Knex = db): Promise<number[]> {
    if (finishes.length === 0) return [];
    const payload = JSON.stringify(finishes.map((finish) => ({
        id: finish.id, expected_attempts: finish.expectedAttempts, status: finish.status, attempts_delta: finish.attemptsDelta,
        next_attempt_at: finish.nextAttemptAt === null ? null : finish.nextAttemptAt.toISOString(),
        last_error_code: finish.lastErrorCode, sent_at: finish.sentAt === null ? null : finish.sentAt.toISOString(),
    })));
    const result = await conn.raw<{ rows: Array<{ id: number }> }>(
        `UPDATE notification_outbox o
        SET status = f.status, attempts = o.attempts + f.attempts_delta,
            next_attempt_at = COALESCE(f.next_attempt_at, o.next_attempt_at), last_error_code = f.last_error_code, sent_at = f.sent_at
        FROM jsonb_to_recordset(?::jsonb) AS f(id bigint, expected_attempts int, status text, attempts_delta int,
            next_attempt_at timestamptz, last_error_code text, sent_at timestamptz)
        WHERE o.id = f.id AND o.status = 'pending' AND o.attempts = f.expected_attempts
        RETURNING o.id`,
        [payload],
    );
    return result.rows.map((row) => row.id);
}

export async function finishRow(finish: OutboxFinish, conn: Knex = db): Promise<boolean> {
    return (await finishRows([finish], conn)).length === 1;
}

/** Purge: one batch of `sent` rows older than the cutoff, served by `idx_notification_outbox_sent_at`. Returns the number deleted. */
export async function deleteSentOlderThan(cutoff: Date, limit: number, conn: Knex = db): Promise<number> {
    const result = await conn.raw<{ rowCount: number }>(
        `DELETE FROM notification_outbox WHERE id IN (
            SELECT id FROM notification_outbox WHERE status = 'sent' AND sent_at < ?::timestamptz
            ORDER BY sent_at LIMIT ? FOR UPDATE SKIP LOCKED)`,
        [cutoff, limit],
    );
    return result.rowCount;
}
