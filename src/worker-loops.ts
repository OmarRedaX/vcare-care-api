import { SYSTEM_SYNC_TIMING } from "./app/identity-sync/constants";
import { IdentitySyncService } from "./app/identity-sync/service/identity-sync.service";
import { buildIdentitySyncLoop } from "./app/identity-sync/worker/identity-sync.loop";
import { VerificationService } from "./app/verification/service/verification.service";
import { buildUploadIntentPurgeLoop } from "./app/verification/worker/upload-intent-purge.loop";
import { AuditRecorder } from "./lib/audit/audit";
import { buildAuditPartitionLoop } from "./lib/audit/partition-loop";
import type { WorkerLoop, WorkerLoopDeps } from "./lib/worker/types";

/**
 * Every care-worker loop (ADR 0008). Each module with background work (outbox, reminders, sync retries) adds its loop
 * here, built from the worker's own pool — never the API's.
 */
export function buildWorkerLoops(deps: WorkerLoopDeps): WorkerLoop[] {
    const audit = new AuditRecorder({ logger: deps.logger });
    const identitySync = new IdentitySyncService(deps.db, audit, deps.identity, deps.env, SYSTEM_SYNC_TIMING);
    const verification = new VerificationService(deps.db, audit, deps.storage, deps.identity, deps.env, identitySync);
    return [
        buildAuditPartitionLoop({
            db: deps.db,
            logger: deps.logger,
            monthsAhead: deps.env.AUDIT_PARTITION_MONTHS_AHEAD,
        }),
        buildIdentitySyncLoop({ service: identitySync, logger: deps.logger, pollSeconds: deps.env.IDENTITY_SYNC_POLL_SECONDS }),
        buildUploadIntentPurgeLoop({ service: verification, db: deps.db, logger: deps.logger, intervalSeconds: deps.env.UPLOAD_INTENT_PURGE_SECONDS }),
    ];
}
