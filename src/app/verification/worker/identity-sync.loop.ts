import type { Logger } from "../../../lib/logger/logger";
import type { TickOutcome, WorkerLoop } from "../../../lib/worker/types";
import type { VerificationService } from "../service/verification.service";
import { IDENTITY_SYNC_BATCH, IDENTITY_SYNC_LOOP_NAME } from "../constants";

/** care-worker loop `identity-sync` (spec §7): retries due `verification` jobs one at a time (the pool is tiny). */
export function buildIdentitySyncLoop(deps: { service: VerificationService; logger: Logger; pollSeconds: number }): WorkerLoop {
    return {
        name: IDENTITY_SYNC_LOOP_NAME,
        intervalMs: deps.pollSeconds * 1000,
        tick: async (signal: AbortSignal): Promise<TickOutcome | void> => {
            const ids = await deps.service.listDueSyncJobIds(IDENTITY_SYNC_BATCH);
            let failed = 0;
            for (const id of ids) {
                if (signal.aborted) return;
                try { await deps.service.processDueSyncJob(id); } catch (error) { failed += 1; deps.logger.error("identity_sync_job_failed", { error }); }
            }
            deps.logger.metric("identity_sync_jobs_processed", ids.length - failed);
            return failed === 0 ? "done" : "incomplete";
        },
    };
}
