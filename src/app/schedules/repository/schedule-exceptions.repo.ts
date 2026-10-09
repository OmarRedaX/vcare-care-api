import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";
import { ScheduleException } from "../entity/schedule-exception.entity";
import type { ExceptionInsertRow, ExceptionPageParams, ScheduleExceptionRow } from "../types";

export const SCHEDULE_EXCEPTION_COLUMNS = ["id", "date", "type", "start_time", "end_time", "reason", "created_at"] as const;

function timeOf(value: string | null): string | null {
    return value === null ? null : value.slice(0, 5);
}

function toEntity(row: ScheduleExceptionRow): ScheduleException {
    return new ScheduleException({
        id: row.id, date: row.date, type: row.type, startTime: timeOf(row.start_time), endTime: timeOf(row.end_time),
        reason: row.reason, createdAt: row.created_at,
    });
}

/** The keyset page query is exported so an EXPLAIN test can inspect exactly what runs. */
export function listExceptionsPageQuery(profileId: number, params: ExceptionPageParams, conn: Knex = db): Knex.QueryBuilder<ScheduleExceptionRow, ScheduleExceptionRow[]> {
    const query = conn<ScheduleExceptionRow>("schedule_exceptions").select<ScheduleExceptionRow[]>(...SCHEDULE_EXCEPTION_COLUMNS)
        .where("doctor_profile_id", profileId).whereNull("deleted_at").where("date", ">=", params.fromDate);
    if (params.toDate !== null) query.where("date", "<=", params.toDate);
    if (params.after !== null) query.whereRaw("(date, id) > (?, ?)", [params.after.sortValue, params.after.id]);
    return query.orderBy("date", "asc").orderBy("id", "asc").limit(params.fetch);
}

export async function listExceptionsPage(profileId: number, params: ExceptionPageParams, conn: Knex = db): Promise<ScheduleException[]> {
    const rows: ScheduleExceptionRow[] = await listExceptionsPageQuery(profileId, params, conn);
    return rows.map(toEntity);
}

/** One multi-row INSERT (at most 60 rows). A taken date raises 23505 on the live-date unique index; the service maps it. */
export async function insertExceptions(profileId: number, rows: readonly ExceptionInsertRow[], conn: Knex.Transaction): Promise<ScheduleException[]> {
    if (rows.length === 0) return [];
    const inserted: ScheduleExceptionRow[] = await conn<ScheduleExceptionRow>("schedule_exceptions")
        .insert(rows.map((row) => ({ doctor_profile_id: profileId, date: row.date, type: row.type, start_time: row.startTime, end_time: row.endTime, reason: row.reason })))
        .returning([...SCHEDULE_EXCEPTION_COLUMNS]);
    return inserted.map(toEntity).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
}

/** Scoped to the profile: a foreign or deleted id is `undefined`. */
export async function findExceptionById(profileId: number, id: number, conn: Knex = db): Promise<ScheduleException | undefined> {
    const row: ScheduleExceptionRow | undefined = await conn<ScheduleExceptionRow>("schedule_exceptions")
        .select(...SCHEDULE_EXCEPTION_COLUMNS).where("id", id).where("doctor_profile_id", profileId).whereNull("deleted_at").first();
    return row === undefined ? undefined : toEntity(row);
}

export async function softDeleteException(id: number, conn: Knex.Transaction): Promise<void> {
    await conn("schedule_exceptions").where("id", id).whereNull("deleted_at").update({ deleted_at: conn.fn.now(), updated_at: conn.fn.now() });
}
