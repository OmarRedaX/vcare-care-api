import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import { parseTimeOfDay } from "../../../pkg/slots/local-time";
import type { ExceptionRule, WeeklyHoursRule } from "../../../pkg/slots/types";
import { listShortestTypes, listSlotExceptions, listSlotHours } from "../repository/slot-inputs.repo";
import type { SlotScheduleInputs } from "../types";

@injectable()
export class SlotInputsReader {
    constructor(@inject(TOKENS.Db) private readonly db: Knex) {}

    async loadSlotInputs(profileIds: readonly number[], fromDate: string, toDate: string, conn: Knex = this.db): Promise<Map<number, SlotScheduleInputs>> {
        // Sequential on purpose: a batch holds one pool connection at a time (the worker pool is small and the sweep pins one).
        const hours = await listSlotHours(profileIds, conn);
        const exceptions = await listSlotExceptions(profileIds, fromDate, toDate, conn);
        const types = await listShortestTypes(profileIds, conn);
        const result = new Map<number, SlotScheduleInputs>(profileIds.map((id) => [id, { weekly: [], exceptions: [], shortestType: null }]));
        for (const row of hours) {
            const entry = result.get(row.doctor_profile_id);
            if (entry === undefined) continue;
            let day = entry.weekly.find((item) => item.weekday === row.weekday);
            if (day === undefined) { day = { weekday: row.weekday, intervals: [] }; entry.weekly.push(day); }
            (day.intervals as { startMinute: number; endMinute: number }[]).push({ startMinute: parseTimeOfDay(row.start_time.slice(0, 5)), endMinute: parseTimeOfDay(row.end_time.slice(0, 5)) });
        }
        for (const row of exceptions) result.get(row.doctor_profile_id)?.exceptions.push({ date: row.date, type: row.type,
            startMinute: row.start_time === null ? null : parseTimeOfDay(row.start_time.slice(0, 5)),
            endMinute: row.end_time === null ? null : parseTimeOfDay(row.end_time.slice(0, 5)) });
        for (const row of types) { const entry = result.get(row.doctor_profile_id); if (entry !== undefined) entry.shortestType = { id: row.id, durationMinutes: row.duration_minutes }; }
        return result;
    }

    async loadHoursAndExceptions(profileId: number, fromDate: string, toDate: string, conn: Knex = this.db): Promise<{ weekly: WeeklyHoursRule[]; exceptions: ExceptionRule[] }> {
        const [hours, exceptions] = await Promise.all([listSlotHours([profileId], conn), listSlotExceptions([profileId], fromDate, toDate, conn)]);
        const weekly: WeeklyHoursRule[] = [];
        for (const row of hours) {
            let day = weekly.find((item) => item.weekday === row.weekday);
            if (day === undefined) { day = { weekday: row.weekday, intervals: [] }; weekly.push(day); }
            (day.intervals as { startMinute: number; endMinute: number }[]).push({ startMinute: parseTimeOfDay(row.start_time.slice(0, 5)), endMinute: parseTimeOfDay(row.end_time.slice(0, 5)) });
        }
        return { weekly, exceptions: exceptions.map((row) => ({ date: row.date, type: row.type,
            startMinute: row.start_time === null ? null : parseTimeOfDay(row.start_time.slice(0, 5)),
            endMinute: row.end_time === null ? null : parseTimeOfDay(row.end_time.slice(0, 5)) })) };
    }
}
