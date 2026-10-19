import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";
import { RecordAttachment } from "../entity/record-attachment.entity";
import type { NewRecordAttachment, RecordAttachmentRow, RecordAttachmentSummary, RecordAttachmentSummaryRow } from "../types";

export const RECORD_ATTACHMENT_COLUMNS = [
    "id", "medical_record_id", "uploaded_by_user_id", "object_key", "file_type", "size_bytes", "description", "created_at", "deleted_at",
] as const;

/** No `object_key`, no `uploaded_by_user_id`: the list path cannot leak a key even by mistake. */
export const RECORD_ATTACHMENT_SUMMARY_COLUMNS = ["id", "medical_record_id", "file_type", "size_bytes", "description", "created_at"] as const;

function toEntity(row: RecordAttachmentRow): RecordAttachment {
    return new RecordAttachment({
        id: row.id, recordId: row.medical_record_id, uploadedByUserId: row.uploaded_by_user_id, objectKey: row.object_key, fileType: row.file_type,
        sizeBytes: row.size_bytes, attachmentDescription: row.description, createdAt: row.created_at, deletedAt: row.deleted_at,
    });
}

function toSummary(row: RecordAttachmentSummaryRow): RecordAttachmentSummary {
    return {
        id: row.id, recordId: row.medical_record_id, fileType: row.file_type, sizeBytes: row.size_bytes,
        attachmentDescription: row.description, createdAt: row.created_at,
    };
}

/**
 * Append-only column-level INSERT (ADR 0018): `id` and `created_at` take their defaults. A `23505` on `uq_record_attachments_object_key`
 * is unreachable (random UUID key) and is left to surface as a programming error (`500`).
 */
export async function insertAttachment(input: NewRecordAttachment, trx: Knex.Transaction): Promise<RecordAttachment> {
    const rows: RecordAttachmentRow[] = await trx("record_attachments").insert({
        medical_record_id: input.recordId, uploaded_by_user_id: input.uploadedByUserId, object_key: input.objectKey, file_type: input.fileType,
        size_bytes: input.sizeBytes, description: input.attachmentDescription,
    }).returning([...RECORD_ATTACHMENT_COLUMNS]);
    const row = rows[0];
    if (row === undefined) throw new Error("record_attachment_insert_returned_no_row");
    return toEntity(row);
}

/** A live attachment of this record by primary key; absent, belonging to another record or deleted -> `undefined`. */
export async function findLive(id: number, recordId: number, conn: Knex = db): Promise<RecordAttachment | undefined> {
    const row = (await conn("record_attachments").select([...RECORD_ATTACHMENT_COLUMNS]).where("id", id).where("medical_record_id", recordId)
        .whereNull("deleted_at").first()) as RecordAttachmentRow | undefined;
    return row === undefined ? undefined : toEntity(row);
}

/** Replay lookup of the row an earlier `complete` created (primary key); a since-deleted row is `undefined`. */
export async function findLiveById(id: number, conn: Knex = db): Promise<RecordAttachment | undefined> {
    const row = (await conn("record_attachments").select([...RECORD_ATTACHMENT_COLUMNS]).where("id", id).whereNull("deleted_at").first()) as RecordAttachmentRow | undefined;
    return row === undefined ? undefined : toEntity(row);
}

/** The cap count, served by `idx_record_attachments_medical_record_id`. */
export async function countLiveByRecord(recordId: number, conn: Knex = db): Promise<number> {
    const row = (await conn("record_attachments").where("medical_record_id", recordId).whereNull("deleted_at").count({ count: "*" }).first()) as { count: string | number } | undefined;
    return Number(row?.count ?? 0);
}

/** Soft delete; the `forbid_attachment_delete_after_lock` trigger is the guard (it raises `check_violation`). Returns the affected row count. */
export async function softDelete(id: number, trx: Knex.Transaction): Promise<number> {
    return trx("record_attachments").where("id", id).whereNull("deleted_at").update({ deleted_at: trx.fn.now() });
}

/** Exported so EXPLAIN tests plan exactly what runs. Served by `idx_record_attachments_medical_record_id`; `id` order is append order. */
export function listByRecordIdsQuery(recordIds: readonly number[], conn: Knex = db): Knex.QueryBuilder {
    return conn("record_attachments").select([...RECORD_ATTACHMENT_SUMMARY_COLUMNS]).whereRaw("medical_record_id = ANY(?::bigint[])", [[...recordIds]])
        .whereNull("deleted_at").orderByRaw("id");
}

/**
 * The live attachments of a whole page in ONE query (never one per record), oldest first, grouped in memory by record id.
 * A record without attachments has no entry; an empty input issues no query.
 */
export async function listByRecordIds(recordIds: readonly number[], conn: Knex = db): Promise<Map<number, RecordAttachmentSummary[]>> {
    const byRecord = new Map<number, RecordAttachmentSummary[]>();
    if (recordIds.length === 0) return byRecord;
    const rows = (await listByRecordIdsQuery(recordIds, conn)) as RecordAttachmentSummaryRow[];
    for (const row of rows) {
        const list = byRecord.get(row.medical_record_id) ?? [];
        list.push(toSummary(row));
        byRecord.set(row.medical_record_id, list);
    }
    return byRecord;
}
