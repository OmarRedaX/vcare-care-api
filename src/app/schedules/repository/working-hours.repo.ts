import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";
import { WorkingHour } from "../entity/working-hour.entity";
import type { WorkingHoursInsertRow, WorkingHoursRow } from "../types";

export const WORKING_HOURS_COLUMNS = ["id", "weekday", "start_time", "end_time"] as const;

/** pg `TIME` text is `HH:MM:SS` (`24:00:00` for the end of day); the wire and entity form is `HH:mm`. */
function toEntity(row: WorkingHoursRow): WorkingHour {
    return new WorkingHour({ id: row.id, weekday: row.weekday, startTime: row.start_time.slice(0, 5), endTime: row.end_time.slice(0, 5) });
}

export async function listLiveHours(profileId: number, conn: Knex = db): Promise<WorkingHour[]> {
    const rows: WorkingHoursRow[] = await conn<WorkingHoursRow>("working_hours")
        .select(...WORKING_HOURS_COLUMNS).where("doctor_profile_id", profileId).whereNull("deleted_at")
        .orderBy("weekday", "asc").orderBy("start_time", "asc");
    return rows.map(toEntity);
}

/** The exact statement of `listLiveHours`, exported so an EXPLAIN test inspects what runs. */
export function listLiveHoursQuery(profileId: number, conn: Knex = db): Knex.QueryBuilder<WorkingHoursRow, WorkingHoursRow[]> {
    return conn<WorkingHoursRow>("working_hours").select<WorkingHoursRow[]>(...WORKING_HOURS_COLUMNS)
        .where("doctor_profile_id", profileId).whereNull("deleted_at").orderBy("weekday", "asc").orderBy("start_time", "asc");
}

export async function softDeleteLiveHours(profileId: number, conn: Knex.Transaction): Promise<void> {
    await conn("working_hours").where("doctor_profile_id", profileId).whereNull("deleted_at")
        .update({ deleted_at: conn.fn.now(), updated_at: conn.fn.now() });
}

/** One multi-row INSERT; an empty list issues no statement. */
export async function insertHours(profileId: number, rows: readonly WorkingHoursInsertRow[], conn: Knex.Transaction): Promise<WorkingHour[]> {
    if (rows.length === 0) return [];
    const inserted: WorkingHoursRow[] = await conn<WorkingHoursRow>("working_hours")
        .insert(rows.map((row) => ({ doctor_profile_id: profileId, weekday: row.weekday, start_time: row.startTime, end_time: row.endTime })))
        .returning([...WORKING_HOURS_COLUMNS]);
    return inserted.map(toEntity).sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime));
}
