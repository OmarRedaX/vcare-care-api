import type { Logger } from "../../../lib/logger/logger";
import type { TickOutcome, WorkerLoop } from "../../../lib/worker/types";
import { IDENTITY_SYNC_BATCH, IDENTITY_SYNC_LOOP_NAME } from "../constants";
import type { IdentitySyncService } from "../service/identity-sync.service";

/** care-worker loop `identity-sync` (spec §5.1): retries due jobs of every kind, one at a time (the pool is tiny). The engine picks the kind policy. */
export function buildIdentitySyncLoop(deps: { service: IdentitySyncService; logger: Logger; pollSeconds: number }): WorkerLoop {
    return {
        name: IDENTITY_SYNC_LOOP_NAME,
        intervalMs: deps.pollSeconds * 1000,
        tick: async (signal: AbortSignal): Promise<TickOutcome | void> => {
            const ids = await deps.service.listDueJobIds(IDENTITY_SYNC_BATCH);
            let failed = 0;
            for (const id of ids) {
                if (signal.aborted) return;
                try { await deps.service.processDue(id); } catch (error) { failed += 1; deps.logger.error("identity_sync_job_failed", { error }); }
            }
            deps.logger.metric("identity_sync_jobs_processed", ids.length - failed);
            return failed === 0 ? "done" : "incomplete";
        },
    };
}
