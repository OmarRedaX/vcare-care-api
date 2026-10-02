import { buildAuditPartitionLoop } from "./lib/audit/partition-loop";
import type { WorkerLoop, WorkerLoopDeps } from "./lib/worker/types";

/**
 * Every care-worker loop (ADR 0008). Each module with background work (outbox, reminders, sync retries) adds its loop
 * here, built from the worker's own pool — never the API's.
 */
export function buildWorkerLoops(deps: WorkerLoopDeps): WorkerLoop[] {
    return [
        buildAuditPartitionLoop({
            db: deps.db,
            logger: deps.logger,
            monthsAhead: deps.env.AUDIT_PARTITION_MONTHS_AHEAD,
        }),
    ];
}
