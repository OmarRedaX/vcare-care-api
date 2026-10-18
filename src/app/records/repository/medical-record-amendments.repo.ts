import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";
import { MedicalRecordAmendment } from "../entity/medical-record-amendment.entity";
import type { AmendmentRow, NewAmendment } from "../types";

export const AMENDMENT_COLUMNS = [
    "id", "medical_record_id", "author_user_id", "chief_complaint", "examination_notes", "diagnosis_text", "diagnosis_code", "treatment_plan",
    "follow_up_in_days", "reason", "created_at",
] as const;

function toEntity(row: AmendmentRow): MedicalRecordAmendment {
    return new MedicalRecordAmendment({
        id: row.id, recordId: row.medical_record_id, authorUserId: row.author_user_id, chiefComplaint: row.chief_complaint,
        examinationNotes: row.examination_notes, diagnosisText: row.diagnosis_text, diagnosisCode: row.diagnosis_code,
        treatmentPlan: row.treatment_plan, followUpInDays: row.follow_up_in_days, reason: row.reason, createdAt: row.created_at,
    });
}

/**
 * Append-only (ADR 0018): the app role holds SELECT and a column-level INSERT on exactly these nine columns, so `id` and `created_at`
 * always take their defaults. Only the amended fields are written; the rest stay NULL.
 */
export async function insertAmendment(input: NewAmendment, trx: Knex.Transaction): Promise<MedicalRecordAmendment> {
    const rows: AmendmentRow[] = await trx("medical_record_amendments").insert({
        medical_record_id: input.recordId, author_user_id: input.authorUserId, chief_complaint: input.changes.chiefComplaint ?? null,
        examination_notes: input.changes.examinationNotes ?? null, diagnosis_text: input.changes.diagnosisText ?? null,
        diagnosis_code: input.changes.diagnosisCode ?? null, treatment_plan: input.changes.treatmentPlan ?? null,
        follow_up_in_days: input.changes.followUpInDays ?? null, reason: input.reason,
    }).returning([...AMENDMENT_COLUMNS]);
    const row = rows[0];
    if (row === undefined) throw new Error("medical_record_amendment_insert_returned_no_row");
    return toEntity(row);
}

/** Exported so EXPLAIN tests plan exactly what runs. Served by `idx_medical_record_amendments_medical_record_id_id`; `id` order is append order (assigned under the record row lock). */
export function listByRecordIdsQuery(recordIds: readonly number[], conn: Knex = db): Knex.QueryBuilder {
    return conn("medical_record_amendments").select([...AMENDMENT_COLUMNS]).whereRaw("medical_record_id = ANY(?::bigint[])", [[...recordIds]])
        .orderByRaw("id");
}

/**
 * The amendments of a whole page in ONE query (never one per record), oldest first, grouped in memory by record id.
 * A record without amendments has no entry; an empty input issues no query.
 */
export async function listByRecordIds(recordIds: readonly number[], conn: Knex = db): Promise<Map<number, MedicalRecordAmendment[]>> {
    const byRecord = new Map<number, MedicalRecordAmendment[]>();
    if (recordIds.length === 0) return byRecord;
    const rows = (await listByRecordIdsQuery(recordIds, conn)) as AmendmentRow[];
    for (const row of rows) {
        const list = byRecord.get(row.medical_record_id) ?? [];
        list.push(toEntity(row));
        byRecord.set(row.medical_record_id, list);
    }
    return byRecord;
}
