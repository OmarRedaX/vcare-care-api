import type { Knex } from "knex";
import { timestampCursorSelect } from "../../../lib/http/pagination/timestamp-cursor";
import { db } from "../../../lib/knex/knex";
import { AuditLog } from "../entity/audit-log.entity";
import type { AuditLogCursorRow, ListAuditLogsParams } from "../types";

export const AUDIT_LOG_COLUMNS = ["id", "actor_user_id", "actor_role", "action", "entity_type", "entity_id", "request_id", "metadata", "created_at"] as const;

function toEntity(row: AuditLogCursorRow): AuditLog {
    return new AuditLog({ id: row.id, actorUserId: row.actor_user_id, actorRole: row.actor_role, action: row.action, entityType: row.entity_type, entityId: row.entity_id,
        requestId: row.request_id, metadata: row.metadata, createdAt: row.created_at });
}

/**
 * The one query of GET /api/audit-logs (exported so the EXPLAIN tests plan exactly what runs). Always bounded by `created_at >= from AND
 * created_at < to` with application-computed bound parameters, so PostgreSQL prunes monthly partitions at plan time. Order
 * `created_at DESC, id DESC`; the keyset predicate `(created_at, id) < (t, id)` and the filters are index conditions of
 * idx_audit_logs_entity_type_entity_id_created_at (entity), idx_audit_logs_actor_user_id_created_at (actor) or idx_audit_logs_created_at_id (default / action).
 * `audit_logs` is append-only: no soft delete, hence no `deleted_at` predicate.
 */
export function listAuditLogsQuery(params: ListAuditLogsParams, conn: Knex = db): Knex.QueryBuilder {
    const query = conn("audit_logs").select(...AUDIT_LOG_COLUMNS, timestampCursorSelect(conn, "created_at", "cursor_timestamp"))
        .whereRaw("created_at >= ?::timestamptz AND created_at < ?::timestamptz", [params.from.toISOString(), params.to.toISOString()]);
    if (params.actorUserId !== undefined) query.whereRaw("actor_user_id = ?::bigint", [params.actorUserId]);
    if (params.action !== undefined) query.where("action", params.action);
    if (params.entityType !== undefined) query.where("entity_type", params.entityType);
    if (params.entityId !== undefined) query.whereRaw("entity_id = ?::bigint", [params.entityId]);
    if (params.after !== undefined) query.whereRaw("(created_at, id) < (?::timestamptz, ?::bigint)", [params.after.t, params.after.id]);
    return query.orderByRaw("created_at DESC, id DESC").limit(params.fetchLimit);
}

export async function listAuditLogs(params: ListAuditLogsParams, conn: Knex = db): Promise<{ entry: AuditLog; cursorTimestamp: string }[]> {
    const rows = (await listAuditLogsQuery(params, conn)) as AuditLogCursorRow[];
    return rows.map((row) => ({ entry: toEntity(row), cursorTimestamp: row.cursor_timestamp }));
}
