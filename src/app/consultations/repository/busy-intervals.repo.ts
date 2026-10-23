import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";
import { MAX_DURATION_MINUTES } from "../constants";
import { ConsultationStatus } from "../enums";
import type { BusyIntervalRow } from "../types";

export const BUSY_INTERVAL_COLUMNS = ["doctor_user_id", "starts_at", "ends_at"] as const;
export function listBusyIntervalsQuery(doctorUserIds: readonly number[], fromMs: number, toMs: number, conn: Knex = db): Knex.QueryBuilder<BusyIntervalRow, BusyIntervalRow[]> {
    return conn<BusyIntervalRow>("consultations").select<BusyIntervalRow[]>(...BUSY_INTERVAL_COLUMNS)
        .whereRaw("doctor_user_id = ANY(?::bigint[])", [[...doctorUserIds]]).whereNull("deleted_at")
        .whereIn("status", [ConsultationStatus.Booked, ConsultationStatus.Waiting, ConsultationStatus.InProgress])
        .where("starts_at", ">=", new Date(fromMs - MAX_DURATION_MINUTES * 60_000)).where("starts_at", "<", new Date(toMs))
        .where("ends_at", ">", new Date(fromMs)).orderBy("doctor_user_id").orderBy("starts_at");
}
export async function listBusyIntervals(doctorUserIds: readonly number[], fromMs: number, toMs: number, conn: Knex = db): Promise<BusyIntervalRow[]> {
    return doctorUserIds.length === 0 ? [] : listBusyIntervalsQuery(doctorUserIds, fromMs, toMs, conn);
}
