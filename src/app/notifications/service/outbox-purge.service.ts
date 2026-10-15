import type { Knex } from "knex";
import type { Logger } from "../../../lib/logger/logger";
import type { TickOutcome } from "../../../lib/worker/types";
import { OUTBOX_PURGE_BATCH, OUTBOX_PURGE_MAX_BATCHES } from "../constants";
import { deleteSentOlderThan } from "../repository/notification-outbox.repo";
import type { NotificationTiming, PurgeEnv } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Deletes `sent` rows older than `OUTBOX_RETENTION_DAYS` in batches; `pending`, `dead` and `skipped` rows are never deleted (N-R18). Safe with two workers. */
export class OutboxPurgeService {
    constructor(
        private readonly db: Knex,
        private readonly env: PurgeEnv,
        private readonly logger: Logger,
        private readonly timing: NotificationTiming,
    ) {}

    async tick(signal: AbortSignal): Promise<TickOutcome> {
        const cutoff = new Date(this.timing.now() - this.env.OUTBOX_RETENTION_DAYS * DAY_MS);
        let deleted = 0;
        for (let batch = 0; batch < OUTBOX_PURGE_MAX_BATCHES && !signal.aborted; batch++) {
            const count = await deleteSentOlderThan(cutoff, OUTBOX_PURGE_BATCH, this.db);
            deleted += count;
            if (count < OUTBOX_PURGE_BATCH) break;
        }
        this.logger.info("outbox_purged", { deleted });
        return "done";
    }
}
