import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import { findAccessRow, findLockRowForNoKeyUpdate, isFollowUpTarget, listConsultationIdsWithRecord } from "../repository/medical-records.repo";
import type { RecordAccessRow, RecordLockRow } from "../types";

/**
 * The one way other modules reach `medical_records` (`consultations` for `hasRecord` and the follow-up link, `sessions` for the calendar).
 * Thin, no rules, and it depends only on the database, so `records` and `consultations` never form a constructor cycle.
 */
@injectable()
export class RecordLinksService {
    constructor(@inject(TOKENS.Db) private readonly db: Knex) {}

    /** The subset of `consultationIds` that has a live record, in ONE query; an empty input issues none. */
    async recordedConsultationIds(consultationIds: readonly number[], conn: Knex = this.db): Promise<Set<number>> {
        if (consultationIds.length === 0) return new Set<number>();
        return new Set(await listConsultationIdsWithRecord(consultationIds, conn));
    }

    /** A live record of this patient written by this doctor (a follow-up booking may link to it). */
    isFollowUpTarget(recordId: number, patientUserId: number, doctorUserId: number, conn: Knex = this.db): Promise<boolean> {
        return isFollowUpTarget(recordId, patientUserId, doctorUserId, conn);
    }

    /** Ids and parties of a live record, no clinical text (ownership resolvers). */
    findAccessRow(recordId: number, conn: Knex = this.db): Promise<RecordAccessRow | undefined> {
        return findAccessRow(recordId, conn);
    }

    /**
     * Ids, parties and the lock verdict (database time) of a live record, read `FOR NO KEY UPDATE` inside the caller's transaction
     * (record-attachments writes). Reads no clinical text.
     */
    lockForNoKeyUpdate(recordId: number, trx: Knex.Transaction): Promise<RecordLockRow | undefined> {
        return findLockRowForNoKeyUpdate(recordId, trx);
    }
}
