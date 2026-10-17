import type { Knex } from "knex";
import { timestampCursorSelect } from "../../../lib/http/pagination/timestamp-cursor";
import { db } from "../../../lib/knex/knex";
import { MedicalRecord } from "../entity/medical-record.entity";
import type {
    MedicalRecordListEntry, MedicalRecordRow, MedicalRecordTimelineRow, NewRecord, RecordAccessRow, RecordColumnChanges, TimelineFilter,
} from "../types";

export const MEDICAL_RECORD_COLUMNS = [
    "id", "consultation_id", "patient_user_id", "doctor_user_id", "chief_complaint", "examination_notes", "diagnosis_text", "diagnosis_code",
    "treatment_plan", "follow_up_in_days", "locked_at", "created_at", "updated_at",
] as const;

/** Every read carries the lock flag computed with the DATABASE clock (the trigger clock, R-D8); Node's clock never decides a lock. */
function selectColumns(conn: Knex): Array<string | Knex.Raw> {
    return [...MEDICAL_RECORD_COLUMNS, conn.raw("(locked_at <= NOW()) AS is_locked")];
}

function toEntity(row: MedicalRecordRow): MedicalRecord {
    return new MedicalRecord({
        id: row.id, consultationId: row.consultation_id, patientUserId: row.patient_user_id, doctorUserId: row.doctor_user_id,
        chiefComplaint: row.chief_complaint, examinationNotes: row.examination_notes, diagnosisText: row.diagnosis_text,
        diagnosisCode: row.diagnosis_code, treatmentPlan: row.treatment_plan, followUpInDays: row.follow_up_in_days, lockedAt: row.locked_at,
        isLocked: row.is_locked, createdAt: row.created_at, updatedAt: row.updated_at,
    });
}

/**
 * `locked_at = NOW() + 24 h` is set in SQL; `created_at` takes its DEFAULT NOW(). `NOW()` is the transaction start, so both come from the same
 * instant and `chk_medical_records_lock` holds exactly. A concurrent duplicate raises 23505 on `uq_medical_records_consultation_id`.
 */
export async function insertRecord(input: NewRecord, trx: Knex.Transaction): Promise<MedicalRecord> {
    const rows: MedicalRecordRow[] = await trx("medical_records").insert({
        consultation_id: input.consultationId, patient_user_id: input.patientUserId, doctor_user_id: input.doctorUserId,
        chief_complaint: input.input.chiefComplaint, examination_notes: input.input.examinationNotes ?? null,
        diagnosis_text: input.input.diagnosisText ?? null, diagnosis_code: input.input.diagnosisCode ?? null,
        treatment_plan: input.input.treatmentPlan ?? null, follow_up_in_days: input.input.followUpInDays ?? null,
        locked_at: trx.raw("NOW() + interval '24 hours'"),
    }).returning(selectColumns(trx));
    const row = rows[0];
    if (row === undefined) throw new Error("medical_record_insert_returned_no_row");
    return toEntity(row);
}

/** One live record by primary key; absent or soft-deleted -> `undefined`. */
export async function findById(id: number, conn: Knex = db): Promise<MedicalRecord | undefined> {
    const row = (await conn("medical_records").select(selectColumns(conn)).where("id", id).whereNull("deleted_at").first()) as MedicalRecordRow | undefined;
    return row === undefined ? undefined : toEntity(row);
}

/**
 * `FOR NO KEY UPDATE`: serializes `PATCH`es of one record without blocking a follow-up booking, whose foreign key takes `FOR KEY SHARE`
 * on this row (keys never change). The lock and `is_locked` come from the same statement, so the verdict is the lock's.
 */
export async function findByIdForNoKeyUpdate(id: number, trx: Knex.Transaction): Promise<MedicalRecord | undefined> {
    const row = (await trx("medical_records").select(selectColumns(trx)).where("id", id).whereNull("deleted_at").forNoKeyUpdate().first()) as MedicalRecordRow | undefined;
    return row === undefined ? undefined : toEntity(row);
}

/** Create-gate courtesy duplicate check, served by `uq_medical_records_consultation_id`; the unique index is the guarantee. */
export async function findLiveIdByConsultationId(consultationId: number, conn: Knex = db): Promise<number | undefined> {
    const row: Pick<MedicalRecordRow, "id"> | undefined = await conn<MedicalRecordRow>("medical_records").select("id").where("consultation_id", consultationId).whereNull("deleted_at").first();
    return row?.id;
}

/** In-place update of the changed columns; the `forbid_update_after_lock` trigger is the guard (it raises `check_violation`). */
export async function updateRecordFields(id: number, columns: RecordColumnChanges, trx: Knex.Transaction): Promise<MedicalRecord> {
    const rows: MedicalRecordRow[] = await trx("medical_records").where("id", id).whereNull("deleted_at")
        .update({ ...columns, updated_at: trx.fn.now() }).returning(selectColumns(trx));
    const row = rows[0];
    if (row === undefined) throw new Error("medical_record_update_returned_no_row");
    return toEntity(row);
}

/** Ids and parties only (no clinical text): what the ownership resolvers need. */
export async function findAccessRow(id: number, conn: Knex = db): Promise<RecordAccessRow | undefined> {
    const row: Pick<MedicalRecordRow, "id" | "patient_user_id" | "doctor_user_id"> | undefined = await conn<MedicalRecordRow>("medical_records")
        .select("id", "patient_user_id", "doctor_user_id").where("id", id).whereNull("deleted_at").first();
    return row === undefined ? undefined : { id: row.id, patientUserId: row.patient_user_id, doctorUserId: row.doctor_user_id };
}

/** The follow-up link check: a live record of this patient written by this doctor (primary-key access). */
export async function isFollowUpTarget(recordId: number, patientUserId: number, doctorUserId: number, conn: Knex = db): Promise<boolean> {
    const row: Pick<MedicalRecordRow, "id"> | undefined = await conn<MedicalRecordRow>("medical_records").select("id").where("id", recordId)
        .where("patient_user_id", patientUserId).where("doctor_user_id", doctorUserId).whereNull("deleted_at").first();
    return row !== undefined;
}

/** The `hasRecord` batch: one `= ANY` query for a whole page, served by `uq_medical_records_consultation_id`. */
export async function listConsultationIdsWithRecord(consultationIds: readonly number[], conn: Knex = db): Promise<number[]> {
    if (consultationIds.length === 0) return [];
    const rows: Array<Pick<MedicalRecordRow, "consultation_id">> = await conn<MedicalRecordRow>("medical_records").select("consultation_id")
        .whereRaw("consultation_id = ANY(?::bigint[])", [[...consultationIds]]).whereNull("deleted_at");
    return rows.map((row) => row.consultation_id);
}

/**
 * The one query of `GET /api/patients/{patientUserId}/records` (exported so EXPLAIN tests plan exactly what runs): the patient live records
 * newest first, keyset on `(created_at, id)`, served by `idx_medical_records_patient_user_id_created_at_id`.
 */
export function listTimelineQuery(filter: TimelineFilter, conn: Knex = db): Knex.QueryBuilder {
    const query = conn("medical_records").select([...selectColumns(conn), timestampCursorSelect(conn, "created_at", "created_at_cursor")])
        .where("patient_user_id", filter.patientUserId).whereNull("deleted_at");
    if (filter.after !== null) query.whereRaw("(created_at, id) < (?::timestamptz, ?::bigint)", [filter.after.sortValue, filter.after.id]);
    return query.orderByRaw("created_at DESC, id DESC").limit(filter.fetch);
}

export async function listTimeline(filter: TimelineFilter, conn: Knex = db): Promise<MedicalRecordListEntry[]> {
    const rows = (await listTimelineQuery(filter, conn)) as MedicalRecordTimelineRow[];
    return rows.map((row) => ({ record: toEntity(row), cursorTimestamp: row.created_at_cursor }));
}
