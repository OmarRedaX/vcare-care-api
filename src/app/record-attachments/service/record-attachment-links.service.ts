import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import { listByRecordIds } from "../repository/record-attachments.repo";
import type { RecordAttachmentSummary } from "../types";

/**
 * The one way `records` reaches `record_attachments` for its views. Thin, no rules, and it depends only on the database (like
 * `RecordLinksService`), so `records` and `record-attachments` never form a constructor cycle.
 */
@injectable()
export class RecordAttachmentLinksService {
    constructor(@inject(TOKENS.Db) private readonly db: Knex) {}

    /**
     * The live attachment metadata of a whole page in ONE query, oldest first, grouped by record id; a record without attachments has no
     * entry and an empty input issues no query. Selects no object key and no uploader.
     */
    listByRecordIds(recordIds: readonly number[], conn: Knex = this.db): Promise<Map<number, RecordAttachmentSummary[]>> {
        return listByRecordIds(recordIds, conn);
    }
}
