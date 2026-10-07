import type { Knex } from "knex";
import type { Logger } from "../../../lib/logger/logger";
import { withSessionAdvisoryLock } from "../../../lib/knex/session-advisory-lock";
import type { TickOutcome, WorkerLoop } from "../../../lib/worker/types";
import type { VerificationService } from "../service/verification.service";
import { INTENT_PURGE_BATCH, INTENT_PURGE_INTERVAL_MS, INTENT_PURGE_LOCK_NAMESPACE, INTENT_PURGE_LOOP_NAME, INTENT_RETENTION_MS } from "../constants";

/**
 * care-worker loop `upload-intent-purge` (spec §7): singleton under an advisory lock. Expired open intents lose their
 * quarantine object (outside any DB transaction) and are then closed; a storage error leaves the intent open for the
 * next tick. Consumed intents older than seven days are deleted. Orphaned final objects rely on the bucket lifecycle.
 */
export function buildUploadIntentPurgeLoop(deps: { service: VerificationService; db: Knex; logger: Logger; now?: () => Date }): WorkerLoop {
    const now = deps.now ?? (() => new Date());
    return {
        name: INTENT_PURGE_LOOP_NAME,
        intervalMs: INTENT_PURGE_INTERVAL_MS,
        tick: async (signal: AbortSignal): Promise<TickOutcome | void> => {
            const ran = await withSessionAdvisoryLock(deps.db, INTENT_PURGE_LOCK_NAMESPACE, 0, async () => {
                let purged = 0; let failed = 0;
                for (const intent of await deps.service.listExpiredIntents(INTENT_PURGE_BATCH)) {
                    if (signal.aborted) return "done" as const;
                    const handled = await deps.service.withIntentLock(intent.id, async () => {
                        try { await deps.service.purgeExpiredIntent(intent.id, intent.quarantineKey); purged += 1; } catch (error) { failed += 1; deps.logger.error("upload_intent_purge_failed", { error }); }
                    });
                    if (handled === undefined) deps.logger.debug("upload_intent_purge_skipped");
                }
                const removed = await deps.service.deleteIntentsOlderThan(new Date(now().getTime() - INTENT_RETENTION_MS), INTENT_PURGE_BATCH);
                deps.logger.metric("upload_intent_expired", purged);
                deps.logger.info("upload_intent_purge_done", { purged, failed, removed });
                return failed === 0 ? "done" as const : "incomplete" as const;
            });
            return ran ?? "incomplete";
        },
    };
}
