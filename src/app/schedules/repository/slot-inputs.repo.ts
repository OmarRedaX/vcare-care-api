import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";
import type { ShortestTypeRow, SlotExceptionRow, SlotHourRow } from "../types";

export const SLOT_HOUR_COLUMNS = ["doctor_profile_id", "weekday", "start_time", "end_time"] as const;
export const SLOT_EXCEPTION_COLUMNS = ["doctor_profile_id", "date", "type", "start_time", "end_time"] as const;
export const SHORTEST_TYPE_COLUMNS = ["id", "doctor_profile_id", "duration_minutes"] as const;

export function listSlotHoursQuery(profileIds: readonly number[], conn: Knex = db): Knex.QueryBuilder<SlotHourRow, SlotHourRow[]> {
    return conn<SlotHourRow>("working_hours").select<SlotHourRow[]>(...SLOT_HOUR_COLUMNS)
        .whereRaw("doctor_profile_id = ANY(?::bigint[])", [[...profileIds]]).whereNull("deleted_at")
        .orderBy("doctor_profile_id").orderBy("weekday").orderBy("start_time");
}
export async function listSlotHours(profileIds: readonly number[], conn: Knex = db): Promise<SlotHourRow[]> {
    return profileIds.length === 0 ? [] : listSlotHoursQuery(profileIds, conn);
}
export function listSlotExceptionsQuery(profileIds: readonly number[], fromDate: string, toDate: string, conn: Knex = db): Knex.QueryBuilder<SlotExceptionRow, SlotExceptionRow[]> {
    return conn<SlotExceptionRow>("schedule_exceptions").select<SlotExceptionRow[]>(...SLOT_EXCEPTION_COLUMNS)
        .whereRaw("doctor_profile_id = ANY(?::bigint[])", [[...profileIds]]).whereNull("deleted_at")
        .whereBetween("date", [fromDate, toDate]).orderBy("doctor_profile_id").orderBy("date");
}
export async function listSlotExceptions(profileIds: readonly number[], fromDate: string, toDate: string, conn: Knex = db): Promise<SlotExceptionRow[]> {
    return profileIds.length === 0 ? [] : listSlotExceptionsQuery(profileIds, fromDate, toDate, conn);
}
export function listShortestTypesQuery(profileIds: readonly number[], conn: Knex = db): Knex.QueryBuilder<ShortestTypeRow, ShortestTypeRow[]> {
    return conn<ShortestTypeRow>("consultation_types").distinctOn("doctor_profile_id")
        .select<ShortestTypeRow[]>(...SHORTEST_TYPE_COLUMNS)
        .whereRaw("doctor_profile_id = ANY(?::bigint[])", [[...profileIds]]).where("is_active", true).whereNull("deleted_at")
        .orderBy("doctor_profile_id").orderBy("duration_minutes").orderBy("id");
}
export async function listShortestTypes(profileIds: readonly number[], conn: Knex = db): Promise<ShortestTypeRow[]> {
    return profileIds.length === 0 ? [] : listShortestTypesQuery(profileIds, conn);
}
