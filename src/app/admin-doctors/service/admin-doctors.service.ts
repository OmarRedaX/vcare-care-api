import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { actorFromAuth, AuditRecorder } from "../../../lib/audit/audit";
import { TOKENS } from "../../../lib/di/tokens";
import { NotFound } from "../../../lib/error/errors";
import { logger } from "../../../lib/logger/logger";
import { currentRequestId } from "../../../lib/logger/request-context";
import type { AuthContext } from "../../../lib/types/types";
import { IdentitySyncStatus, VerificationStatus } from "../../doctors/enums";
import type { DoctorProfile } from "../../doctors/entity/doctor-profile.entity";
import { IdentitySyncJobKind } from "../../identity-sync/enums";
import { IdentitySyncService } from "../../identity-sync/service/identity-sync.service";
import type { SyncTiming } from "../../identity-sync/types";
import { CONSULTATION_ENTITY, DOCTOR_PROFILE_ENTITY, FOLLOWUP_REASON_DOCTOR_SUSPENDED, REINSTATE_INLINE_ATTEMPTS, SUSPEND_INLINE_ATTEMPTS } from "../constants";
import { AdminDoctorAuditAction } from "../enums";
import { InvalidTransition } from "../errors";
import { applySuspension, clearSuspension, lockProfileByUserId } from "../repository/admin-doctors.repo";
import type { ReinstateDecision, ReinstateOutcome, SuspendDecision, SuspendOutcome, SuspensionImpactProvider } from "../types";

/**
 * Case 3 (suspend, must-not-degrade) and Case 4 (reinstate, retry-report-pending). Each action is a decision transaction
 * (preconditions, profile columns, flag port, job, audit: all or nothing) followed, after commit, by the shared engine's
 * inline Identity attempt. The reason text is stored in the profile and the job, never in audit metadata or logs.
 */
@injectable()
export class AdminDoctorsService {
    constructor(
        @inject(TOKENS.Db) private readonly db: Knex,
        @inject(TOKENS.AuditRecorder) private readonly audit: AuditRecorder,
        @inject(TOKENS.IdentitySyncService) private readonly identitySync: IdentitySyncService,
        @inject(TOKENS.SuspensionImpactProvider) private readonly impact: SuspensionImpactProvider,
        @inject(TOKENS.SyncTiming) private readonly timing: SyncTiming,
    ) {}

    private requestId(): string { return currentRequestId() ?? randomUUID(); }
    private static reasonLength(reason: string): number { return [...reason].length; }

    async suspend(actor: AuthContext, doctorUserId: number, reason: string): Promise<SuspendOutcome> {
        const requestId = this.requestId();
        const decision = await this.db.transaction(async (trx): Promise<SuspendDecision> => {
            const profile = await lockProfileByUserId(doctorUserId, trx); if (!profile) throw NotFound;
            const now = new Date(this.timing.now());
            const context = { doctorProfileId: profile.id, doctorUserId, now };
            if (profile.suspendedAt !== null) {
                const ids = await this.impact.listFlaggedConsultations(context, trx);
                return { kind: "noop", outcome: { view: { doctorUserId, suspendedAt: profile.suspendedAt, identitySyncStatus: profile.identitySyncStatus, flaggedConsultationIds: ids }, confirmed: profile.identitySyncStatus === IdentitySyncStatus.Synced } };
            }
            if (profile.verificationStatus !== VerificationStatus.Approved || profile.identitySyncStatus !== IdentitySyncStatus.Synced) throw InvalidTransition;
            await this.identitySync.supersedeOpen(profile.id, trx);
            const suspendedAt = await applySuspension(profile.id, actor.userId, reason, trx);
            const flagged = await this.impact.flagFutureConsultations(context, trx);
            const job = await this.identitySync.enqueue(trx, { profile, kind: IdentitySyncJobKind.Suspension, targetStatus: "suspended", reason, actorUserId: actor.userId, requestId });
            await this.audit.record(trx, { actor: actorFromAuth(actor), action: AdminDoctorAuditAction.Suspended, entityType: DOCTOR_PROFILE_ENTITY, entityId: profile.id,
                metadata: { doctorUserId, jobId: job.id, flaggedCount: flagged.length, reasonLength: AdminDoctorsService.reasonLength(reason), fromSyncStatus: IdentitySyncStatus.Synced, toSyncStatus: IdentitySyncStatus.Pending } });
            for (const consultationId of flagged)
                await this.audit.record(trx, { actor: actorFromAuth(actor), action: AdminDoctorAuditAction.ConsultationFlagged, entityType: CONSULTATION_ENTITY, entityId: consultationId,
                    metadata: { doctorProfileId: profile.id, followupReason: FOLLOWUP_REASON_DOCTOR_SUSPENDED } });
            return { kind: "applied", jobId: job.id, doctorUserId, suspendedAt, flaggedConsultationIds: flagged };
        });
        if (decision.kind === "noop") {
            logger.metric("doctor_suspension_total", 1, { outcome: "noop" });
            return decision.outcome;
        }
        // A crash after the commit is safe: the pending job already exists and the worker picks it up within one poll.
        const report = await this.identitySync.syncNow(decision.jobId, actor, SUSPEND_INLINE_ATTEMPTS);
        const confirmed = report.profile.identitySyncStatus === IdentitySyncStatus.Synced && report.status === 200;
        logger.metric("doctor_suspension_total", 1, { outcome: confirmed ? "confirmed" : report.profile.identitySyncStatus === IdentitySyncStatus.Failed ? "failed" : "pending" });
        logger.info("doctor_suspension_applied", { doctorProfileId: report.profile.id, jobId: decision.jobId, identitySyncStatus: report.profile.identitySyncStatus });
        return { view: { doctorUserId, suspendedAt: decision.suspendedAt, identitySyncStatus: report.profile.identitySyncStatus, flaggedConsultationIds: decision.flaggedConsultationIds }, confirmed };
    }

    async reinstate(actor: AuthContext, doctorUserId: number, reason: string): Promise<ReinstateOutcome> {
        const requestId = this.requestId();
        const decision = await this.db.transaction(async (trx): Promise<ReinstateDecision> => {
            const profile = await lockProfileByUserId(doctorUserId, trx); if (!profile) throw NotFound;
            if (profile.suspendedAt === null) return { kind: "noop", outcome: await this.reinstateNoop(profile, doctorUserId, trx) };
            if (profile.identitySyncStatus !== IdentitySyncStatus.Synced) throw InvalidTransition;
            await this.identitySync.supersedeOpen(profile.id, trx);
            const reinstatedAt = await clearSuspension(profile.id, trx);
            const job = await this.identitySync.enqueue(trx, { profile, kind: IdentitySyncJobKind.Reinstatement, targetStatus: "active", reason, actorUserId: actor.userId, requestId });
            await this.audit.record(trx, { actor: actorFromAuth(actor), action: AdminDoctorAuditAction.Reinstated, entityType: DOCTOR_PROFILE_ENTITY, entityId: profile.id,
                metadata: { doctorUserId, jobId: job.id, reasonLength: AdminDoctorsService.reasonLength(reason), fromSyncStatus: IdentitySyncStatus.Synced, toSyncStatus: IdentitySyncStatus.Pending } });
            return { kind: "applied", jobId: job.id, doctorUserId, reinstatedAt };
        });
        if (decision.kind === "noop") {
            logger.metric("doctor_reinstatement_total", 1, { outcome: "noop" });
            return decision.outcome;
        }
        const report = await this.identitySync.syncNow(decision.jobId, actor, REINSTATE_INLINE_ATTEMPTS);
        const status = report.profile.identitySyncStatus;
        const synced = status === IdentitySyncStatus.Synced && report.status === 200;
        logger.metric("doctor_reinstatement_total", 1, { outcome: synced ? "confirmed" : status === IdentitySyncStatus.Failed ? "failed" : "pending" });
        logger.info("doctor_reinstatement_applied", { doctorProfileId: report.profile.id, jobId: decision.jobId, identitySyncStatus: status });
        const view = { doctorUserId, reinstatedAt: decision.reinstatedAt, identitySyncStatus: status };
        if (synced) return { view, status: 200 };
        return { view, status: 202, identitySync: status === IdentitySyncStatus.Failed ? "failed" : "pending" };
    }

    /** A doctor who is not suspended: nothing changes, but a blind retry must not read an unsynced reinstatement as confirmation. */
    private async reinstateNoop(profile: DoctorProfile, doctorUserId: number, trx: Knex.Transaction): Promise<ReinstateOutcome> {
        const view = { doctorUserId, reinstatedAt: new Date(this.timing.now()), identitySyncStatus: profile.identitySyncStatus };
        const unsynced = profile.identitySyncStatus === IdentitySyncStatus.Pending || profile.identitySyncStatus === IdentitySyncStatus.Failed;
        if (!unsynced) return { view, status: 200 };
        const latest = await this.identitySync.findLatestJob(profile.id, trx);
        if (latest?.kind !== IdentitySyncJobKind.Reinstatement) return { view, status: 200 };
        return { view, status: 202, identitySync: profile.identitySyncStatus === IdentitySyncStatus.Failed ? "failed" : "pending" };
    }
}
