import type { Knex } from "knex";
import { timestampCursorSelect } from "../../../lib/http/pagination/timestamp-cursor";
import { db } from "../../../lib/knex/knex";
import { MAX_DURATION_MINUTES } from "../constants";
import { Consultation } from "../entity/consultation.entity";
import { ConsultationScope, ConsultationStatus } from "../enums";
import type { FollowupReason } from "../enums";
import type {
    CandidateRow, CandidateWindow, ConsultationListDbRow, ConsultationListRow, ConsultationListEntry, ConsultationListFilter, ConsultationRow, FlaggedRow,
    FutureFlaggedRow, DeliveryDbRow, ReminderDbRow, NewConsultation, TransitionChanges,
} from "../types";

export const CONSULTATION_COLUMNS = [
    "id", "doctor_user_id", "patient_user_id", "consultation_type_id", "starts_at", "ends_at", "status", "complaint_text", "patient_timezone",
    "price", "currency", "room_id", "joined_at", "started_at", "completed_at", "cancelled_at", "cancel_reason", "cancelled_by",
    "cancelled_by_user_id", "no_show_marked_at", "needs_admin_followup", "followup_reason", "follow_up_of_record_id", "reminder_24h_sent_at",
    "reminder_1h_sent_at", "idempotency_key", "request_hash", "created_at", "updated_at",
] as const;

/**
 * Columns a list item renders. `complaint_text`, `request_hash`, `idempotency_key`, `room_id`, the reminder marks, `no_show_marked_at` and
 * `cancelled_by_user_id` are never emitted by a list, so they are not read (clinical text stays in the row). `cancel_reason` and
 * `follow_up_of_record_id` stay because the list DTO emits them.
 */
export const CONSULTATION_LIST_COLUMNS = [
    "id", "doctor_user_id", "patient_user_id", "consultation_type_id", "starts_at", "ends_at", "status", "patient_timezone", "price", "currency",
    "joined_at", "started_at", "completed_at", "cancelled_at", "cancel_reason", "cancelled_by", "needs_admin_followup", "followup_reason",
    "follow_up_of_record_id", "created_at", "updated_at",
] as const;

const QUALIFIED_COLUMNS = CONSULTATION_COLUMNS.map((column) => `consultations.${column}`);
const QUALIFIED_LIST_COLUMNS = CONSULTATION_LIST_COLUMNS.map((column) => `consultations.${column}`);
const TYPE_NAME_COLUMN = "consultation_types.name as type_name";
/** Statuses of a consultation that can still happen (the impact checks and the follow-up queue). */
export const NON_TERMINAL_STATUSES: readonly ConsultationStatus[] = [ConsultationStatus.Booked, ConsultationStatus.Waiting, ConsultationStatus.InProgress];
const RELATIONSHIP_STATUSES: readonly ConsultationStatus[] = [...NON_TERMINAL_STATUSES, ConsultationStatus.Completed];
const MINUTE_MS = 60_000;

function toEntity(row: ConsultationListRow, typeName?: string): Consultation {
    return new Consultation({
        id: row.id, doctorUserId: row.doctor_user_id, patientUserId: row.patient_user_id, consultationTypeId: row.consultation_type_id,
        consultationTypeName: typeName ?? row.type_name ?? "", startsAt: row.starts_at, endsAt: row.ends_at, status: row.status,
        complaintText: row.complaint_text ?? "", patientTimezone: row.patient_timezone, price: row.price, currency: row.currency, roomId: row.room_id ?? null,
        joinedAt: row.joined_at, startedAt: row.started_at, completedAt: row.completed_at, cancelledAt: row.cancelled_at,
        cancelReason: row.cancel_reason, cancelledBy: row.cancelled_by, cancelledByUserId: row.cancelled_by_user_id ?? null,
        noShowMarkedAt: row.no_show_marked_at ?? null, needsAdminFollowup: row.needs_admin_followup, followupReason: row.followup_reason,
        followUpOfRecordId: row.follow_up_of_record_id, reminder24hSentAt: row.reminder_24h_sent_at ?? null,
        reminder1hSentAt: row.reminder_1h_sent_at ?? null, idempotencyKey: row.idempotency_key ?? "", requestHash: row.request_hash ?? "", createdAt: row.created_at, updatedAt: row.updated_at,
    });
}

function joined(conn: Knex, columns: readonly string[] = QUALIFIED_COLUMNS): Knex.QueryBuilder {
    return conn("consultations").join("consultation_types", "consultation_types.id", "consultations.consultation_type_id")
        .select(...columns, TYPE_NAME_COLUMN);
}

/** One live row with its type name; absent or soft-deleted -> `undefined`. */
export async function findById(id: number, conn: Knex = db): Promise<Consultation | undefined> {
    const row = (await joined(conn).where("consultations.id", id).whereNull("consultations.deleted_at").first()) as ConsultationRow | undefined;
    return row === undefined ? undefined : toEntity(row);
}

/** `SELECT ... FOR UPDATE OF consultations`: serializes lifecycle changes of one row. */
export async function findByIdForUpdate(id: number, trx: Knex.Transaction): Promise<Consultation | undefined> {
    const row = (await joined(trx).where("consultations.id", id).whereNull("consultations.deleted_at").forUpdate("consultations").first()) as ConsultationRow | undefined;
    return row === undefined ? undefined : toEntity(row);
}

/** Booking replay lookup, served by `uq_consultations_idempotency`. */
export async function findByIdempotencyKey(patientUserId: number, idempotencyKey: string, conn: Knex = db): Promise<Consultation | undefined> {
    const row = (await joined(conn).where("consultations.patient_user_id", patientUserId).where("consultations.idempotency_key", idempotencyKey)
        .whereNull("consultations.deleted_at").first()) as ConsultationRow | undefined;
    return row === undefined ? undefined : toEntity(row);
}

/** Inserts a `booked` row; an overlap raises 23P01 and a reused key 23505 (the service maps both). */
export async function insertConsultation(input: NewConsultation, trx: Knex.Transaction): Promise<Consultation> {
    const rows: ConsultationRow[] = await trx("consultations").insert({
        doctor_user_id: input.doctorUserId, patient_user_id: input.patientUserId, consultation_type_id: input.consultationTypeId,
        starts_at: input.startsAt, ends_at: input.endsAt, status: ConsultationStatus.Booked, complaint_text: input.complaintText,
        patient_timezone: input.patientTimezone, price: input.price, currency: input.currency, idempotency_key: input.idempotencyKey,
        request_hash: input.requestHash,
    }).returning([...CONSULTATION_COLUMNS]);
    const row = rows[0];
    if (row === undefined) throw new Error("consultation_insert_returned_no_row");
    return toEntity(row, input.typeName);
}

/**
 * Moves a `booked` row to a new interval (status stays `booked`), resets the reminder marks and clears the follow-up flag.
 * Zero rows -> `undefined` (the row left `booked` meanwhile). An overlap raises 23P01.
 */
export async function rescheduleRow(current: Consultation, startsAt: Date, endsAt: Date, trx: Knex.Transaction): Promise<Consultation | undefined> {
    const rows: ConsultationRow[] = await trx("consultations").where("id", current.id).where("status", ConsultationStatus.Booked).whereNull("deleted_at")
        .update({
            starts_at: startsAt, ends_at: endsAt, reminder_24h_sent_at: null, reminder_1h_sent_at: null, needs_admin_followup: false,
            followup_reason: null, updated_at: trx.fn.now(),
        }).returning([...CONSULTATION_COLUMNS]);
    const row = rows[0];
    return row === undefined ? undefined : toEntity(row, current.consultationTypeName);
}

/**
 * The one lifecycle update (Domain rule 9): `WHERE status = ANY(from)` makes a terminal row immutable even when the service
 * check raced. Zero rows -> `undefined`. `sessions` reuses it for join/start/complete/no-show.
 */
export async function applyTransition(current: Consultation, from: readonly ConsultationStatus[], to: ConsultationStatus,
    changes: TransitionChanges, trx: Knex.Transaction): Promise<Consultation | undefined> {
    const rows: ConsultationRow[] = await trx("consultations").where("id", current.id).whereIn("status", [...from]).whereNull("deleted_at")
        .update({ ...changes, status: to, updated_at: trx.fn.now() }).returning([...CONSULTATION_COLUMNS]);
    const row = rows[0];
    return row === undefined ? undefined : toEntity(row, current.consultationTypeName);
}

/**
 * The one query of `GET /api/consultations` (exported so EXPLAIN tests plan exactly what runs). The participant predicate comes
 * from the verified principal, so each viewer's keyset index is the access path: patient/doctor `(..._user_id, starts_at, id)`,
 * the follow-up queue `idx_consultations_followup_starts_at_id`, the unfiltered admin list `idx_consultations_starts_at_id`.
 * `upcoming` adds `starts_at >= now - 240 min` (durations are capped at 240) so the range scan on `starts_at` is bounded.
 */
export function listPageQuery(filter: ConsultationListFilter, conn: Knex = db): Knex.QueryBuilder {
    const query = joined(conn, QUALIFIED_LIST_COLUMNS).select(timestampCursorSelect(conn, "consultations.starts_at", "starts_at_cursor"))
        .whereNull("consultations.deleted_at");
    if (filter.doctorUserId !== null) query.where("consultations.doctor_user_id", filter.doctorUserId);
    if (filter.patientUserId !== null) query.where("consultations.patient_user_id", filter.patientUserId);
    const now = filter.now.toISOString();
    if (filter.scope === ConsultationScope.Upcoming) {
        query.whereRaw("consultations.ends_at > ?::timestamptz AND consultations.starts_at >= ?::timestamptz",
            [now, new Date(filter.now.getTime() - MAX_DURATION_MINUTES * MINUTE_MS).toISOString()]);
    } else if (filter.scope === ConsultationScope.Past) {
        query.whereRaw("consultations.ends_at <= ?::timestamptz AND consultations.starts_at <= ?::timestamptz", [now, now]);
    }
    if (filter.from !== null) query.whereRaw("consultations.starts_at >= ?::timestamptz", [filter.from.toISOString()]);
    if (filter.to !== null) query.whereRaw("consultations.starts_at < ?::timestamptz", [filter.to.toISOString()]);
    if (filter.statuses !== null) query.whereIn("consultations.status", filter.statuses);
    if (filter.needsAdminFollowup === true) query.whereRaw("consultations.needs_admin_followup").whereIn("consultations.status", [...NON_TERMINAL_STATUSES]);
    if (filter.needsAdminFollowup === false) query.whereRaw("NOT consultations.needs_admin_followup");
    const descending = filter.scope === ConsultationScope.Past;
    if (filter.after !== null) {
        query.whereRaw(`(consultations.starts_at, consultations.id) ${descending ? "<" : ">"} (?::timestamptz, ?::bigint)`, [filter.after.sortValue, filter.after.id]);
    }
    return query.orderByRaw(descending ? "consultations.starts_at DESC, consultations.id DESC" : "consultations.starts_at ASC, consultations.id ASC").limit(filter.fetch);
}

export async function listPage(filter: ConsultationListFilter, conn: Knex = db): Promise<ConsultationListEntry[]> {
    const rows = (await listPageQuery(filter, conn)) as ConsultationListDbRow[];
    return rows.map((row) => ({ consultation: toEntity(row), cursorTimestamp: row.starts_at_cursor }));
}

/** Doctor-patient relationship for `GET /patients/:patientUserId`, served by `idx_consultations_doctor_user_id_patient_user_id`. */
export function hasRelationshipQuery(doctorUserId: number, patientUserId: number, conn: Knex = db): Knex.QueryBuilder {
    return conn("consultations").select("id").where("doctor_user_id", doctorUserId).where("patient_user_id", patientUserId)
        .whereNull("deleted_at").whereIn("status", [...RELATIONSHIP_STATUSES]).limit(1);
}

export async function hasRelationship(doctorUserId: number, patientUserId: number, conn: Knex = db): Promise<boolean> {
    const rows = (await hasRelationshipQuery(doctorUserId, patientUserId, conn)) as Array<{ id: number }>;
    return rows.length > 0;
}

/** Ownership resolver query: a live consultation the user takes part in (patient or assigned doctor). */
export async function isParticipant(id: number, userId: number, conn: Knex = db): Promise<boolean> {
    const row: Pick<ConsultationRow, "id"> | undefined = await conn<ConsultationRow>("consultations").select("id").where("id", id).whereNull("deleted_at")
        .where((builder) => { builder.where("patient_user_id", userId).orWhere("doctor_user_id", userId); }).first();
    return row !== undefined;
}

/** Ownership resolver query: a live consultation the user booked as the patient. */
export async function isPatientOwner(id: number, userId: number, conn: Knex = db): Promise<boolean> {
    const row: Pick<ConsultationRow, "id"> | undefined = await conn<ConsultationRow>("consultations").select("id").where("id", id)
        .where("patient_user_id", userId).whereNull("deleted_at").first();
    return row !== undefined;
}

function futureNonTerminal(doctorUserId: number, now: Date, conn: Knex): Knex.QueryBuilder {
    return conn("consultations").where("doctor_user_id", doctorUserId).whereIn("status", [...NON_TERMINAL_STATUSES]).whereNull("deleted_at")
        .where("ends_at", ">", now).where("starts_at", ">=", new Date(now.getTime() - MAX_DURATION_MINUTES * MINUTE_MS));
}

/**
 * Future `booked`/`waiting`/`in_progress` consultations of a doctor, ascending ids, optionally limited to those overlapping a
 * UTC window. The `starts_at` lower bound only keeps the scan on `idx_consultations_doctor_user_id_starts_at_id`.
 */
export async function listAffectedCandidates(doctorUserId: number, now: Date, window: CandidateWindow | null, conn: Knex): Promise<CandidateRow[]> {
    const query = futureNonTerminal(doctorUserId, now, conn).select("id", "starts_at", "ends_at");
    if (window !== null) {
        query.where("starts_at", "<", new Date(window.toMs)).where("ends_at", ">", new Date(window.fromMs));
    }
    return (await query.orderBy("id", "asc")) as CandidateRow[];
}

/**
 * Flags the given rows for admin follow-up; rows that left a non-terminal status meanwhile are skipped, and so are rows already flagged
 * with the same `reason` (the predicate keeps `RETURNING` to the newly flagged rows, so a patient is notified once). Ascending ids.
 */
export async function flagConsultations(ids: readonly number[], doctorUserId: number, reason: FollowupReason, trx: Knex.Transaction): Promise<FlaggedRow[]> {
    if (ids.length === 0) return [];
    const rows: FlaggedRow[] = await trx("consultations").whereIn("id", [...ids]).where("doctor_user_id", doctorUserId).whereIn("status", [...NON_TERMINAL_STATUSES])
        .whereNull("deleted_at").whereRaw("NOT (needs_admin_followup AND followup_reason IS NOT DISTINCT FROM ?)", [reason])
        .update({ needs_admin_followup: true, followup_reason: reason, updated_at: trx.fn.now() })
        .returning(["id", "patient_user_id", "starts_at", "ends_at"]);
    return rows.sort((a, b) => a.id - b.id);
}

/**
 * Case 3: flags every future non-terminal consultation of a suspended doctor. Last writer wins on `followup_reason`. Ascending ids.
 * `newly_flagged` is computed from the pre-image in the same statement: false when the row already carried this `reason` (flag-once,
 * so a patient is notified once per flag).
 */
export async function flagFutureForDoctor(doctorUserId: number, now: Date, reason: FollowupReason, trx: Knex.Transaction): Promise<FutureFlaggedRow[]> {
    const result = await trx.raw<{ rows: FutureFlaggedRow[] }>(
        `WITH target AS (
            SELECT id, (needs_admin_followup AND followup_reason IS NOT DISTINCT FROM ?) AS already_flagged
            FROM consultations
            WHERE doctor_user_id = ? AND status IN ('booked','waiting','in_progress') AND deleted_at IS NULL
              AND ends_at > ? AND starts_at >= ?
            FOR UPDATE)
        UPDATE consultations c SET needs_admin_followup = TRUE, followup_reason = ?, updated_at = NOW()
        FROM target t WHERE c.id = t.id
        RETURNING c.id, c.patient_user_id, c.starts_at, c.ends_at, NOT t.already_flagged AS newly_flagged`,
        [reason, doctorUserId, now, new Date(now.getTime() - MAX_DURATION_MINUTES * MINUTE_MS), reason],
    );
    return [...result.rows].sort((a, b) => a.id - b.id);
}

/**
 * Delivery context for outbox rows, soft-deleted consultations included. The doctor's timezone comes from the live profile
 * (`uq_doctor_profiles_user_id`); `null` when the profile is gone.
 */
export async function findDeliveryRows(ids: readonly number[], conn: Knex): Promise<DeliveryDbRow[]> {
    if (ids.length === 0) return [];
    return conn("consultations as c").leftJoin("doctor_profiles as dp", function join() {
        this.on("dp.user_id", "=", "c.doctor_user_id").andOnNull("dp.deleted_at");
    }).select("c.id", "c.status", "c.starts_at", "c.ends_at", "c.patient_user_id", "c.doctor_user_id", "c.patient_timezone",
        "dp.timezone as doctor_timezone", "c.deleted_at").whereIn("c.id", [...ids]);
}

/**
 * Reminder scan candidates: booked consultations that start within the window and have not been stamped for it, locked so a concurrent
 * scan, reschedule or cancel cannot interleave. Served by `idx_consultations_booked_starts_at`.
 */
export async function listReminderRows(windowMs: number, stampColumn: "reminder_24h_sent_at" | "reminder_1h_sent_at", now: Date, limit: number, trx: Knex.Transaction): Promise<ReminderDbRow[]> {
    return trx("consultations as c").select("c.id", "c.patient_user_id", "c.doctor_user_id", "c.starts_at", "c.ends_at", "c.created_at")
        .where("c.status", ConsultationStatus.Booked).whereNull("c.deleted_at").where("c.starts_at", ">", now)
        .where("c.starts_at", "<=", new Date(now.getTime() + windowMs)).whereNull(`c.${stampColumn}`)
        .orderBy([{ column: "c.starts_at", order: "asc" }, { column: "c.id", order: "asc" }]).limit(limit).forUpdate("c").skipLocked();
}

/** Marks a reminder as queued. `updated_at` is not touched (a stamp is not a business change). */
export async function stampReminderColumn(ids: readonly number[], column: "reminder_24h_sent_at" | "reminder_1h_sent_at", now: Date, trx: Knex.Transaction): Promise<void> {
    if (ids.length === 0) return;
    await trx("consultations").whereIn("id", [...ids]).where("status", ConsultationStatus.Booked).whereNull("deleted_at").whereNull(column).update({ [column]: now });
}

/** Ids of the doctor's future non-terminal consultations currently flagged with `reason`, ascending. */
export async function listFlaggedIds(doctorUserId: number, reason: FollowupReason, now: Date, conn: Knex): Promise<number[]> {
    const rows = (await futureNonTerminal(doctorUserId, now, conn).select("id").where("needs_admin_followup", true)
        .where("followup_reason", reason).orderBy("id", "asc")) as Array<{ id: number }>;
    return rows.map((row) => row.id);
}
