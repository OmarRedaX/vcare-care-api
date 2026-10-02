import type { WorkerLoop } from "../worker/types";
import {
    AUDIT_DEFAULT_SAMPLE_LIMIT,
    AUDIT_PARTITION_INTERVAL_MS,
    AUDIT_PARTITION_LOCK_KEY,
    AUDIT_PARTITION_LOOP_NAME,
} from "./constants";
import type { AuditPartitionLoopDeps, EnsuredPartitionRow } from "./types";

/**
 * care-worker loop `audit-partitions` (access spec §3.6, ADR 0009): daily, ensure the monthly `audit_logs` partitions
 * for the current UTC month and the next `monthsAhead` months exist, then report whether `audit_logs_default` holds
 * rows (it must stay empty).
 *
 * The worker connects as `care_app`, so creation goes through the owner-defined SECURITY DEFINER function
 * `audit_logs_ensure_partitions(int)` (ADR 0018). Concurrent workers serialize on a TRANSACTION-scoped advisory lock
 * (`pg_try_advisory_xact_lock`): it releases on commit or rollback, so a pooled connection never leaks a held lock.
 */
export function buildAuditPartitionLoop(deps: AuditPartitionLoopDeps): WorkerLoop {
    const { db, logger, monthsAhead } = deps;

    const ensure = async (): Promise<void> => {
        try {
            await db.transaction(async (trx) => {
                const lock = await trx.raw<{ rows: Array<{ locked: boolean }> }>(
                    "SELECT pg_try_advisory_xact_lock(?) AS locked",
                    [AUDIT_PARTITION_LOCK_KEY],
                );
                if (lock.rows[0]?.locked !== true) {
                    logger.debug("audit_partitions_locked_elsewhere");
                    return;
                }
                const result = await trx.raw<{ rows: EnsuredPartitionRow[] }>(
                    "SELECT partition_name, created FROM audit_logs_ensure_partitions(?)",
                    [monthsAhead],
                );
                logger.info("audit_partitions_ensured", {
                    created: result.rows.filter((row) => row.created).map((row) => row.partition_name),
                    checked: result.rows.length,
                });
                logger.metric("audit_partition_missing", 0);
            });
        } catch (error) {
            // Lock timeout, a DEFAULT row inside the new month's range, permissions. Not rethrown: the default-partition
            // check below must still run. The error is serialized without its message for database errors.
            logger.error("audit_partition_missing", { error });
            logger.metric("audit_partition_missing", 1);
        }
    };

    const checkDefaultPartition = async (): Promise<void> => {
        const result = await db.raw<{ rows: Array<{ sampled: number }> }>(
            "SELECT count(*)::int AS sampled FROM (SELECT 1 FROM audit_logs_default LIMIT ?) AS sample",
            [AUDIT_DEFAULT_SAMPLE_LIMIT],
        );
        const rows = result.rows[0]?.sampled ?? 0;
        logger.metric("audit_default_partition_rows", rows);
        if (rows > 0) {
            logger.warn("audit_default_partition_nonempty", { rows });
        }
    };

    return {
        name: AUDIT_PARTITION_LOOP_NAME,
        intervalMs: AUDIT_PARTITION_INTERVAL_MS,
        tick: async (signal: AbortSignal): Promise<void> => {
            if (signal.aborted) {
                return;
            }
            await ensure();
            await checkDefaultPartition();
        },
    };
}
