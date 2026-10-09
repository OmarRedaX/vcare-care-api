import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { actorFromAuth, AuditRecorder } from "../../../lib/audit/audit";
import { backoffMs } from "../../../lib/async/backoff";
import type { Env } from "../../../lib/config/types";
import { TOKENS } from "../../../lib/di/tokens";
import { NotFound } from "../../../lib/error/errors";
import { IdentityClient } from "../../../lib/identity-client/identity-client";
import { withSessionAdvisoryLock } from "../../../lib/knex/session-advisory-lock";
import { logger } from "../../../lib/logger/logger";
import { currentRequestId } from "../../../lib/logger/request-context";
import type { AuthContext } from "../../../lib/types/types";
import { truncateCodePoints } from "../../../pkg/utils/code-points";
import { IdentitySyncStatus } from "../../doctors/enums";
import { IDENTITY_REASON_MAX_CODE_POINTS, IDENTITY_SYNC_LOCK_NAMESPACE, IDENTITY_SYNC_PROFILE_ENTITY } from "../constants";
import { IdentitySyncAuditAction, IdentitySyncJobStatus } from "../enums";
import { findLatestSyncJob, findPendingSyncJob, findProfileForSync, findSyncJob, insertSyncJob, listDuePendingJobs, setProfileIdentitySync, supersedePendingSyncJob, updateSyncJob } from "../repository/identity-sync.repo";
import { buildSyncPolicies } from "../sync-policy";
import type { EnqueueSyncJob, IdentitySyncJobRow, SyncAttempt, SyncPolicies, SyncReport, SyncTiming } from "../types";

/**
 * The Identity-sync transition engine shared by verification (Case 1), suspension (Case 3) and reinstatement (Case 4).
 * It knows the job, the profile's `identity_sync_status` and the kind policy; the preconditions of a decision stay in the
 * module that takes it (ADR 0021).
 */
@injectable()
export class IdentitySyncService {
    private readonly policies: SyncPolicies;

    constructor(
        @inject(TOKENS.Db) private readonly db: Knex,
        @inject(TOKENS.AuditRecorder) private readonly audit: AuditRecorder,
        @inject(TOKENS.IDENTITY_CLIENT) private readonly identity: IdentityClient,
        @inject(TOKENS.Env) private readonly env: Env,
        @inject(TOKENS.SyncTiming) private readonly timing: SyncTiming,
    ) {
        this.policies = buildSyncPolicies(env);
    }

    private requestId(): string { return currentRequestId() ?? randomUUID(); }

    /** Inside the caller's decision transaction: opens the pending job. The kind/target pair is enforced by the DB CHECK. */
    async enqueue(trx: Knex.Transaction, job: EnqueueSyncJob): Promise<IdentitySyncJobRow> {
        return insertSyncJob({ doctor_profile_id: job.profile.id, doctor_user_id: job.profile.userId, kind: job.kind, target_status: job.targetStatus, reason: job.reason, actor_user_id: job.actorUserId,
            request_id: job.requestId, status: IdentitySyncJobStatus.Pending, next_attempt_at: new Date(this.timing.now()) }, trx);
    }
    async supersedeOpen(profileId: number, trx: Knex.Transaction): Promise<void> { await supersedePendingSyncJob(profileId, trx); }
    /** Latest job of a profile in any status (a no-op re-report asks whether the last reinstatement is still unsynced). */
    findLatestJob(profileId: number, conn: Knex): Promise<IdentitySyncJobRow | undefined> { return findLatestSyncJob(profileId, conn); }

    /** Inline path of the three decisions: guarded Identity call + local transition, then the profile as it now stands. Never throws for Identity failures. */
    async syncNow(jobId: number, actor: AuthContext, attempts: number): Promise<SyncReport> {
        const { profileId, locked } = await this.attempt(jobId, actor, attempts, false);
        const profile = await findProfileForSync(profileId, this.db); if (!profile) throw NotFound;
        if (!locked) return { profile, status: 202, identitySync: "pending" };
        if (profile.identitySyncStatus === IdentitySyncStatus.Synced) return { profile, status: 200 };
        return { profile, status: 202, identitySync: profile.identitySyncStatus === IdentitySyncStatus.Failed ? "failed" : "pending" };
    }
    /** Worker path: one attempt for a due pending job of any kind. */
    async processDue(jobId: number): Promise<void> {
        const job = await findSyncJob(jobId, this.db); if (!job || job.status !== IdentitySyncJobStatus.Pending) return;
        await this.attempt(jobId, null, 1, true);
    }
    async listDueJobIds(limit: number): Promise<number[]> { return (await listDuePendingJobs(limit, new Date(this.timing.now()), this.db)).map((job) => job.id); }

    /** Builds no view, so worker retries never hydrate. */
    private async attempt(jobId: number, actor: AuthContext | null, attempts: number, dueOnly: boolean): Promise<SyncAttempt> {
        const initial = await findSyncJob(jobId, this.db); if (!initial) throw NotFound;
        const auditActor = actor ? actorFromAuth(actor) : { kind: "system" as const };
        const locked = await withSessionAdvisoryLock(this.db, IDENTITY_SYNC_LOCK_NAMESPACE, initial.doctor_profile_id, async () => {
            const job = await findSyncJob(jobId, this.db);
            const pending = await findPendingSyncJob(initial.doctor_profile_id, this.db);
            if (!job || job.status !== IdentitySyncJobStatus.Pending || pending?.id !== jobId) {
                if (job?.status === IdentitySyncJobStatus.Pending) await updateSyncJob(jobId, { status: IdentitySyncJobStatus.Superseded }, this.db);
                // Settled or superseded while we waited (e.g. the worker already confirmed it): the lock WAS ours, so the caller reads the profile instead of reporting contention.
                return true;
            }
            // Worker path: another worker may have just recorded a transient failure and scheduled the next attempt. Honour that backoff.
            if (dueOnly && job.next_attempt_at.getTime() > this.timing.now()) return true;
            // Identity rejects a blank reason (400, never retryable): a blank stored text, or one that is blank after the clamp, falls back to the kind.
            const clamped = truncateCodePoints(job.reason ?? "", IDENTITY_REASON_MAX_CODE_POINTS);
            const reason = /\S/.test(clamped) ? clamped : job.kind;
            const outcome = await this.identity.setUserStatus(job.doctor_user_id, job.target_status, reason, job.actor_user_id, job.request_id ?? this.requestId(), attempts);
            await this.db.transaction(async (trx) => {
                const current = await findProfileForSync(job.doctor_profile_id, trx, true);
                const currentJob = await findSyncJob(jobId, trx);
                if (!current || !currentJob || currentJob.status !== IdentitySyncJobStatus.Pending) return;
                const currentPending = await findPendingSyncJob(current.id, trx);
                if (currentPending?.id !== jobId) { await updateSyncJob(jobId, { status: IdentitySyncJobStatus.Superseded }, trx); return; }
                if (outcome.outcome === "applied") {
                    await updateSyncJob(jobId, { status: IdentitySyncJobStatus.Succeeded, succeeded_at: new Date(this.timing.now()), attempts: currentJob.attempts + outcome.attemptsMade, consecutive_failures: 0 }, trx);
                    await setProfileIdentitySync(current.id, IdentitySyncStatus.Synced, trx);
                    await this.audit.record(trx, { actor: auditActor, action: IdentitySyncAuditAction.Synced, entityType: IDENTITY_SYNC_PROFILE_ENTITY, entityId: current.id, metadata: { jobId } });
                } else if (outcome.outcome === "rejected-transition" || outcome.outcome === "permanent") {
                    // Terminal: 409 InvalidStatusTransition, or Identity refused the request itself (400/403/422). Retrying cannot fix either; page, keep the local state.
                    const code = outcome.outcome === "permanent" ? outcome.errorCode : "InvalidStatusTransition";
                    await updateSyncJob(jobId, { status: IdentitySyncJobStatus.Failed, attempts: currentJob.attempts + outcome.attemptsMade, last_error_code: code }, trx);
                    await setProfileIdentitySync(current.id, IdentitySyncStatus.Failed, trx);
                    await this.audit.record(trx, { actor: auditActor, action: IdentitySyncAuditAction.Failed, entityType: IDENTITY_SYNC_PROFILE_ENTITY, entityId: current.id, metadata: { jobId } });
                    logger.error("IdentitySyncTransitionRejected", { code, kind: currentJob.kind, jobId, profileId: current.id });
                } else {
                    const nowMs = this.timing.now();
                    const delay = backoffMs(currentJob.attempts, () => this.timing.random(), this.env.IDENTITY_SYNC_RETRY_CAP_SECONDS * 1000);
                    const consecutiveFailures = currentJob.consecutive_failures + 1;
                    await updateSyncJob(jobId, { attempts: currentJob.attempts + outcome.attemptsMade, consecutive_failures: consecutiveFailures, last_error_code: outcome.errorCode,
                        next_attempt_at: new Date(nowMs + delay), updated_at: new Date(nowMs) }, trx);
                    if (currentJob.attempts === 0) await this.audit.record(trx, { actor: auditActor, action: IdentitySyncAuditAction.Pending, entityType: IDENTITY_SYNC_PROFILE_ENTITY, entityId: current.id, metadata: { jobId } });
                    const alert = this.policies[currentJob.kind].alertOnTransient({ job: currentJob, consecutiveFailures, lastErrorCode: outcome.errorCode, nowMs });
                    if (alert) logger.error(alert.message, { kind: currentJob.kind, jobId, profileId: current.id, ...alert.fields });
                }
            });
            return true;
        });
        return { profileId: initial.doctor_profile_id, locked: locked !== undefined };
    }
}
