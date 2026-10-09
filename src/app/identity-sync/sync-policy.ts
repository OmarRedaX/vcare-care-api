import type { Env } from "../../lib/config/types";
import { SUSPENSION_FAILURE_PAGE_THRESHOLD, SUSPENSION_FAILURE_REPAGE_EVERY } from "./constants";
import { IdentitySyncJobKind } from "./enums";
import type { SyncKindPolicy, SyncPolicies, TransientFailureContext } from "./types";

/** Ticket-class alert: once, by the first attempt that finds the job unsynced for longer than the configured window. */
function unsyncedTooLong(message: string, alertAfterSeconds: number): SyncKindPolicy {
    return {
        alertOnTransient: ({ job, nowMs }: TransientFailureContext) => {
            const alertAt = job.created_at.getTime() + alertAfterSeconds * 1000;
            return job.updated_at.getTime() < alertAt && nowMs >= alertAt ? { message, fields: {} } : null;
        },
    };
}

/** Page-class alert: no time rule, the failure count decides (3, then 13, 23, ...). */
const suspensionPolicy: SyncKindPolicy = {
    alertOnTransient: ({ consecutiveFailures, lastErrorCode }: TransientFailureContext) => {
        const sinceThreshold = consecutiveFailures - SUSPENSION_FAILURE_PAGE_THRESHOLD;
        if (sinceThreshold < 0 || sinceThreshold % SUSPENSION_FAILURE_REPAGE_EVERY !== 0) return null;
        return { message: "IdentitySuspensionSyncFailing", fields: { consecutiveFailures, lastErrorCode } };
    },
};

/** Adding a job kind is a policy row here plus a DB CHECK value, never a new loop (spec §5.3). */
export function buildSyncPolicies(env: Pick<Env, "IDENTITY_SYNC_ALERT_AFTER_SECONDS">): SyncPolicies {
    return {
        [IdentitySyncJobKind.Verification]: unsyncedTooLong("IdentityApprovalSyncPending", env.IDENTITY_SYNC_ALERT_AFTER_SECONDS),
        [IdentitySyncJobKind.Suspension]: suspensionPolicy,
        [IdentitySyncJobKind.Reinstatement]: unsyncedTooLong("IdentityReinstatementSyncPending", env.IDENTITY_SYNC_ALERT_AFTER_SECONDS),
    };
}
