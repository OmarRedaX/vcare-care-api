import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import type { UtcInterval } from "../../../pkg/slots/types";
import { listBusyIntervals } from "../repository/busy-intervals.repo";

@injectable()
export class BusyIntervalsReader {
    constructor(@inject(TOKENS.Db) private readonly db: Knex) {}
    async listBusy(doctorUserIds: readonly number[], fromMs: number, toMs: number, conn: Knex = this.db): Promise<Map<number, UtcInterval[]>> {
        const grouped = new Map<number, UtcInterval[]>(doctorUserIds.map((id) => [id, []]));
        for (const row of await listBusyIntervals(doctorUserIds, fromMs, toMs, conn)) {
            grouped.get(row.doctor_user_id)?.push({ startMs: row.starts_at.getTime(), endMs: row.ends_at.getTime() });
        }
        return grouped;
    }
}
