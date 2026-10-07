import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { actorFromAuth, AuditRecorder } from "../../../lib/audit/audit";
import { backoffMs } from "../../../lib/async/backoff";
import type { Env } from "../../../lib/config/types";
import { TOKENS } from "../../../lib/di/tokens";
import { Conflict, Forbidden, NotFound, ValidationFailed } from "../../../lib/error/errors";
import { IdentityClient } from "../../../lib/identity-client/identity-client";
import { withSessionAdvisoryLock } from "../../../lib/knex/session-advisory-lock";
import { logger } from "../../../lib/logger/logger";
import { currentRequestId } from "../../../lib/logger/request-context";
import type { ObjectStorage } from "../../../lib/storage/types";
import type { AuthContext } from "../../../lib/types/types";
import { detectFileType } from "../../../pkg/utils/detect-file-type";
import { IdentitySyncStatus, VerificationStatus } from "../../doctors/enums";
import type { DoctorProfile } from "../../doctors/entity/doctor-profile.entity";
import { ApplicationNotEditable, ApplicationNotReviewable, UploadIntentExpired } from "../errors";
import { IdentitySyncJobKind, IdentitySyncJobStatus, UploadIntentKind, VerificationAuditAction, VerificationDocumentStatus, VerificationDocumentType } from "../enums";
import { claimDuePendingJobs, closeIntent, deleteIntentsOlderThan, findDocument, findDocumentForUpdate, findIntent, findIntentForUpdate, findPendingSyncJob, findProfileById, findProfileByUserId, findSyncJob, insertDocument, insertIntent, insertSyncJob, listDocuments, listDocumentsBatch, listExpiredOpenIntents, listQueue, softDeleteDocument, supersedePendingSyncJob, touchProfile, updateSyncJob } from "../repository/verification.repo";
import type { DecisionResult, DocumentCompletion, QueueCursorPayload, QueuePage, QueueQuery, SubmitTransition, VerificationApplicationView } from "../types";

export const VERIFICATION_INTENT_LOCK_NAMESPACE = 1101;
export const VERIFICATION_SYNC_LOCK_NAMESPACE = 1102;
const MAX_UPLOAD_BYTES = 10_485_760;
const PROFILE_ENTITY = "doctor_profile";
const DOCUMENT_ENTITY = "verification_document";

@injectable()
export class VerificationService {
    constructor(
        @inject(TOKENS.Db) private readonly db: Knex,
        @inject(TOKENS.AuditRecorder) private readonly audit: AuditRecorder,
        @inject(TOKENS.STORAGE) private readonly storage: ObjectStorage,
        @inject(TOKENS.IDENTITY_CLIENT) private readonly identity: IdentityClient,
        @inject(TOKENS.Env) private readonly env: Env,
    ) {}

    private requestId(): string { return currentRequestId() ?? randomUUID(); }
    private assertEditable(profile: DoctorProfile): void {
        if (profile.suspendedAt !== null) throw Forbidden;
        if (profile.verificationStatus !== VerificationStatus.Draft && profile.verificationStatus !== VerificationStatus.Rejected) throw ApplicationNotEditable;
    }
    private async assertRequiredDocuments(profileId: number, conn: Knex): Promise<void> {
        const docs = await listDocuments(profileId, conn);
        if (!docs.some((doc) => doc.type === VerificationDocumentType.License) || !docs.some((doc) => doc.type === VerificationDocumentType.Id))
            throw ValidationFailed.withDetails([{ field: "documents", issue: "license and id documents are required" }]);
    }
    private async auditAction(trx: Knex.Transaction, actor: AuthContext, action: VerificationAuditAction, entityType: string, entityId: number, metadata: Record<string, string | number | boolean | null>): Promise<void> {
        await this.audit.record(trx, { actor: actorFromAuth(actor), action, entityType, entityId, metadata });
    }
    private async view(profile: DoctorProfile, viewer: "doctor" | "admin", requestId: string, documents?: Awaited<ReturnType<typeof listDocuments>>): Promise<VerificationApplicationView> {
        const docs = documents ?? await listDocuments(profile.id, this.db);
        const { users } = await this.identity.getUsersBatch([profile.userId], requestId);
        const user = users.get(profile.userId);
        return { profile, documents: docs, doctor: { displayName: user?.displayName ?? null, avatarUrl: user?.avatarUrl ?? null, profileHydrated: user !== undefined },
            ...(viewer === "doctor" ? { missingRequirements: [!docs.some((doc) => doc.type === VerificationDocumentType.License) ? "license_document" : null, !docs.some((doc) => doc.type === VerificationDocumentType.Id) ? "id_document" : null].filter((value): value is string => value !== null) } : {}) };
    }
    async getOwnApplication(actor: AuthContext): Promise<VerificationApplicationView> { const profile = await findProfileByUserId(actor.userId, this.db); if (!profile) throw NotFound; return this.view(profile, "doctor", this.requestId()); }
    async getApplication(actor: AuthContext, id: number): Promise<VerificationApplicationView> { const profile = await findProfileById(id, this.db); if (!profile) throw NotFound; await this.db.transaction(async (trx) => this.auditAction(trx, actor, VerificationAuditAction.DocumentsViewed, PROFILE_ENTITY, id, {})); return this.view(profile, "admin", this.requestId()); }

    /** Called inside the doctors service's existing profile-write transaction. */
    async submitInTransaction(actor: AuthContext, profile: DoctorProfile, trx: Knex.Transaction): Promise<SubmitTransition> {
        this.assertEditable(profile);
        await this.assertRequiredDocuments(profile.id, trx);
        await supersedePendingSyncJob(profile.id, trx);
        const resubmit = profile.verificationStatus === VerificationStatus.Rejected;
        await trx("doctor_profiles").where({ id: profile.id }).whereNull("deleted_at").update({ verification_status: VerificationStatus.Submitted, submitted_at: trx.fn.now(), reviewed_by: null, review_note: null, decided_at: null,
            identity_sync_status: resubmit ? IdentitySyncStatus.Pending : IdentitySyncStatus.NotRequired, updated_at: trx.fn.now() });
        let jobId: number | null = null;
        if (resubmit) {
            const job = await insertSyncJob({ doctor_profile_id: profile.id, doctor_user_id: profile.userId, kind: IdentitySyncJobKind.Verification, target_status: "pending", reason: "verification resubmitted", actor_user_id: actor.userId, request_id: this.requestId(), status: IdentitySyncJobStatus.Pending, next_attempt_at: new Date() }, trx);
            jobId = job.id;
        }
        await this.auditAction(trx, actor, VerificationAuditAction.Submitted, PROFILE_ENTITY, profile.id, { fromStatus: profile.verificationStatus, toStatus: VerificationStatus.Submitted });
        return { jobId };
    }
    async finishSubmit(actor: AuthContext, transition: SubmitTransition): Promise<DecisionResult | null> { if (transition.jobId === null) return null; return this.syncJob(transition.jobId, actor, 3); }

    async createIntent(actor: AuthContext, type: VerificationDocumentType): Promise<{ uploadId: number; url: string; fields: Record<string, string>; expiresAt: string; maxBytes: number }> {
        const profile = await findProfileByUserId(actor.userId, this.db); if (!profile) throw NotFound; this.assertEditable(profile);
        const key = `quarantine/${randomUUID()}`;
        const policy = await this.storage.createUploadPolicy(key, MAX_UPLOAD_BYTES, this.env.UPLOAD_POLICY_TTL_SECONDS);
        const expiresAt = new Date(Date.now() + this.env.UPLOAD_INTENT_TTL_SECONDS * 1000);
        const intent = await insertIntent({ kind: UploadIntentKind.VerificationDocument, target_id: profile.id, owner_user_id: actor.userId, document_type: type, description: null, quarantine_key: key, max_bytes: MAX_UPLOAD_BYTES, expires_at: expiresAt }, this.db);
        return { uploadId: intent.id, url: policy.url, fields: policy.fields, expiresAt: expiresAt.toISOString(), maxBytes: MAX_UPLOAD_BYTES };
    }
    async complete(actor: AuthContext, uploadId: number): Promise<DocumentCompletion> {
        const result = await withSessionAdvisoryLock(this.db, VERIFICATION_INTENT_LOCK_NAMESPACE, uploadId, async (): Promise<DocumentCompletion> => {
            const intent = await findIntent(uploadId, this.db);
            if (!intent || intent.kind !== "verification_document" || intent.owner_user_id !== actor.userId) throw NotFound;
            const profile = await findProfileById(intent.target_id, this.db);
            if (!profile || profile.userId !== actor.userId) throw NotFound;
            if (intent.result_id !== null) { const document = await findDocument(intent.result_id, this.db); if (!document) throw Conflict; return { document, replay: true }; }
            if (intent.consumed_at !== null) throw Conflict;
            if (intent.expires_at.getTime() <= Date.now()) { await this.storage.delete(intent.quarantine_key); await this.db.transaction(async (trx) => closeIntent(intent.id, null, trx)); throw UploadIntentExpired; }
            this.assertEditable(profile);
            const head = await this.storage.headObject(intent.quarantine_key);
            const bytes = head && head.sizeBytes >= 1 && head.sizeBytes <= intent.max_bytes ? await this.storage.readHead(intent.quarantine_key, 16) : null;
            const fileType = bytes ? detectFileType(bytes) : null;
            if (!head || !fileType || head.sizeBytes < 1 || head.sizeBytes > intent.max_bytes) {
                await this.storage.delete(intent.quarantine_key);
                await this.db.transaction(async (trx) => closeIntent(intent.id, null, trx));
                logger.metric("upload_verification_failed", 1, { reason: "invalid_file" });
                throw ValidationFailed.withDetails([{ field: "file", issue: "stored file is invalid" }]);
            }
            const finalKey = `verification-documents/${randomUUID()}`;
            await this.storage.promote(intent.quarantine_key, finalKey);
            await this.storage.delete(intent.quarantine_key);
            try {
                const document = await this.db.transaction(async (trx) => {
                    const locked = await findIntentForUpdate(intent.id, trx);
                    const current = await findProfileById(intent.target_id, trx, true);
                    if (!locked || locked.owner_user_id !== actor.userId || locked.consumed_at !== null || locked.expires_at.getTime() <= Date.now() || !current) throw Conflict;
                    this.assertEditable(current);
                    if (!locked.document_type) throw Conflict;
                    const inserted = await insertDocument({ doctor_profile_id: current.id, type: locked.document_type, object_key: finalKey, file_type: fileType, size_bytes: head.sizeBytes, status: VerificationDocumentStatus.Uploaded }, trx);
                    await this.auditAction(trx, actor, VerificationAuditAction.DocumentUploaded, DOCUMENT_ENTITY, inserted.id, { profileId: current.id });
                    await closeIntent(intent.id, inserted.id, trx);
                    return inserted;
                });
                return { document, replay: false };
            } catch (error) { try { await this.storage.delete(finalKey); } catch { logger.error("verification_orphan_cleanup_failed"); } throw error; }
        });
        if (!result) throw Conflict.withExtra({ retryAfter: 1 });
        return result;
    }
    async download(actor: AuthContext, documentId: number, applicationId?: number): Promise<{ url: string; expiresAt: string }> {
        const document = await findDocument(documentId, this.db); if (!document) throw NotFound;
        const profile = await findProfileById(document.doctorProfileId, this.db);
        if (!profile || (applicationId === undefined ? profile.userId !== actor.userId : profile.id !== applicationId)) throw NotFound;
        await this.db.transaction(async (trx) => this.auditAction(trx, actor, VerificationAuditAction.DocumentUrlIssued, DOCUMENT_ENTITY, document.id, { profileId: profile.id }));
        return this.storage.presignDownload(document.objectKey, document.fileType, this.env.DOWNLOAD_URL_TTL_SECONDS);
    }
    async deleteDocument(actor: AuthContext, documentId: number): Promise<void> {
        await this.db.transaction(async (trx) => {
            const profile = await findProfileByUserId(actor.userId, trx, true); if (!profile) throw NotFound; this.assertEditable(profile);
            const document = await findDocumentForUpdate(documentId, trx); if (!document || document.doctorProfileId !== profile.id) throw NotFound;
            await softDeleteDocument(document.id, trx);
            await touchProfile(profile.id, trx);
            await this.auditAction(trx, actor, VerificationAuditAction.DocumentDeleted, DOCUMENT_ENTITY, document.id, { profileId: profile.id });
        });
    }
    async decide(actor: AuthContext, id: number, action: "approve" | "reject" | "reopen", note: string | undefined): Promise<DecisionResult> {
        const jobId = await this.db.transaction(async (trx) => {
            const profile = await findProfileById(id, trx, true); if (!profile) throw NotFound;
            if (action === "reopen" ? profile.verificationStatus !== VerificationStatus.Rejected : profile.verificationStatus !== VerificationStatus.Submitted) throw ApplicationNotReviewable;
            if (action === "approve") await this.assertRequiredDocuments(id, trx);
            await supersedePendingSyncJob(id, trx);
            const status = action === "approve" ? VerificationStatus.Approved : action === "reject" ? VerificationStatus.Rejected : VerificationStatus.Submitted;
            const target = action === "approve" ? "active" : action === "reject" ? "rejected" : "pending";
            await trx("doctor_profiles").where({ id }).whereNull("deleted_at").update({ verification_status: status, identity_sync_status: IdentitySyncStatus.Pending,
                reviewed_by: action === "reopen" ? null : actor.userId, review_note: action === "reopen" ? null : note ?? null,
                decided_at: action === "reopen" ? null : trx.fn.now(), submitted_at: action === "reopen" ? trx.fn.now() : profile.submittedAt, updated_at: trx.fn.now() });
            const job = await insertSyncJob({ doctor_profile_id: id, doctor_user_id: profile.userId, kind: IdentitySyncJobKind.Verification, target_status: target,
                reason: note ?? `verification ${action}`, actor_user_id: actor.userId, request_id: this.requestId(), status: IdentitySyncJobStatus.Pending, next_attempt_at: new Date() }, trx);
            const auditAction = action === "approve" ? VerificationAuditAction.Approved : action === "reject" ? VerificationAuditAction.Rejected : VerificationAuditAction.Reopened;
            await this.auditAction(trx, actor, auditAction, PROFILE_ENTITY, id, { fromStatus: profile.verificationStatus, toStatus: status });
            return job.id;
        });
        return this.syncJob(jobId, actor, 3);
    }
    async listDueSyncJobIds(limit = 50): Promise<number[]> { return (await claimDuePendingJobs(limit, this.db)).map((job) => job.id); }
    async listExpiredIntents(limit = 500): Promise<{ id: number; quarantineKey: string }[]> { return (await listExpiredOpenIntents(limit, this.db)).map((intent) => ({ id: intent.id, quarantineKey: intent.quarantine_key })); }
    async purgeExpiredIntent(id: number, quarantineKey: string): Promise<void> { await this.storage.delete(quarantineKey); await this.closeExpiredIntent(id); }
    async processDueSyncJob(jobId: number): Promise<void> { const job = await findSyncJob(jobId, this.db); if (!job || job.kind !== IdentitySyncJobKind.Verification || job.status !== IdentitySyncJobStatus.Pending) return; await this.attemptSync(jobId, null, 1); }
    /** Runs the guarded Identity call + local transition. Builds no view, so worker retries never hydrate. */
    private async attemptSync(jobId: number, actor: AuthContext | null, attempts: number): Promise<{ profileId: number; locked: boolean }> {
        const initial = await findSyncJob(jobId, this.db); if (!initial) throw NotFound;
        const locked = await withSessionAdvisoryLock(this.db, VERIFICATION_SYNC_LOCK_NAMESPACE, initial.doctor_profile_id, async () => {
            const job = await findSyncJob(jobId, this.db);
            const pending = await findPendingSyncJob(initial.doctor_profile_id, this.db);
            if (!job || job.status !== IdentitySyncJobStatus.Pending || pending?.id !== jobId) {
                if (job?.status === IdentitySyncJobStatus.Pending) await updateSyncJob(jobId, { status: IdentitySyncJobStatus.Superseded }, this.db);
                return;
            }
            const outcome = await this.identity.setUserStatus(job.doctor_user_id, job.target_status, job.reason ?? "verification", job.actor_user_id, job.request_id ?? this.requestId(), attempts);
            await this.db.transaction(async (trx) => {
                const current = await findProfileById(job.doctor_profile_id, trx, true);
                const currentJob = await findSyncJob(jobId, trx);
                if (!current || !currentJob || currentJob.status !== IdentitySyncJobStatus.Pending) return;
                const currentPending = await findPendingSyncJob(current.id, trx);
                if (currentPending?.id !== jobId) { await updateSyncJob(jobId, { status: IdentitySyncJobStatus.Superseded }, trx); return; }
                if (outcome.outcome === "applied") {
                    await updateSyncJob(jobId, { status: IdentitySyncJobStatus.Succeeded, succeeded_at: new Date(), attempts: currentJob.attempts + attempts, consecutive_failures: 0 }, trx);
                    await trx("doctor_profiles").where({ id: current.id }).update({ identity_sync_status: IdentitySyncStatus.Synced, updated_at: trx.fn.now() });
                    await this.audit.record(trx, { actor: actor ? actorFromAuth(actor) : { kind: "system" }, action: VerificationAuditAction.SyncSynced, entityType: PROFILE_ENTITY, entityId: current.id, metadata: { jobId } });
                } else if (outcome.outcome === "rejected-transition") {
                    await updateSyncJob(jobId, { status: IdentitySyncJobStatus.Failed, attempts: currentJob.attempts + attempts, last_error_code: "InvalidStatusTransition" }, trx);
                    await trx("doctor_profiles").where({ id: current.id }).update({ identity_sync_status: IdentitySyncStatus.Failed, updated_at: trx.fn.now() });
                    await this.audit.record(trx, { actor: actor ? actorFromAuth(actor) : { kind: "system" }, action: VerificationAuditAction.SyncFailed, entityType: PROFILE_ENTITY, entityId: current.id, metadata: { jobId } });
                    logger.error("IdentitySyncTransitionRejected", { code: "InvalidStatusTransition" });
                } else {
                    const delay = backoffMs(currentJob.attempts, Math.random, this.env.IDENTITY_SYNC_RETRY_CAP_SECONDS * 1000);
                    await updateSyncJob(jobId, { attempts: currentJob.attempts + attempts, consecutive_failures: currentJob.consecutive_failures + 1, last_error_code: outcome.errorCode,
                        next_attempt_at: new Date(Date.now() + delay) }, trx);
                    if (currentJob.attempts === 0) await this.audit.record(trx, { actor: actor ? actorFromAuth(actor) : { kind: "system" }, action: VerificationAuditAction.SyncPending, entityType: PROFILE_ENTITY, entityId: current.id, metadata: { jobId } });
                    const alertAt = currentJob.created_at.getTime() + this.env.IDENTITY_SYNC_ALERT_AFTER_SECONDS * 1000;
                    if (currentJob.updated_at.getTime() < alertAt && Date.now() >= alertAt) logger.error("IdentityApprovalSyncPending");
                }
            });
            return true;
        });
        return { profileId: initial.doctor_profile_id, locked: locked !== undefined };
    }
    private async syncJob(jobId: number, actor: AuthContext | null, attempts: number): Promise<DecisionResult> {
        const { profileId, locked } = await this.attemptSync(jobId, actor, attempts);
        const profile = await findProfileById(profileId, this.db); if (!profile) throw NotFound;
        const view = await this.view(profile, actor?.role === "doctor" ? "doctor" : "admin", this.requestId());
        if (!locked) return { view, status: 202, identitySync: "pending" };
        return profile.identitySyncStatus === IdentitySyncStatus.Synced ? { view, status: 200 } : { view, status: 202, identitySync: profile.identitySyncStatus === IdentitySyncStatus.Failed ? "failed" : "pending" };
    }
    private encodeCursor(payload: QueueCursorPayload): string { const body = Buffer.from(JSON.stringify(payload)).toString("base64url"); const mac = createHmac("sha256", this.env.SERVICE_CLIENT_SECRET).update(body).digest("base64url"); return `${body}.${mac}`; }
    private decodeCursor(cursor: string, status: string): QueueCursorPayload {
        const [body, mac] = cursor.split("."); if (!body || !mac) throw ValidationFailed.withDetails([{ field: "cursor", issue: "is invalid" }]);
        const expected = createHmac("sha256", this.env.SERVICE_CLIENT_SECRET).update(body).digest();
        let supplied: Buffer; try { supplied = Buffer.from(mac, "base64url"); } catch { throw ValidationFailed.withDetails([{ field: "cursor", issue: "is invalid" }]); }
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw ValidationFailed.withDetails([{ field: "cursor", issue: "is invalid" }]);
        let payload: unknown; try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { throw ValidationFailed.withDetails([{ field: "cursor", issue: "is invalid" }]); }
        if (!payload || typeof payload !== "object" || !("status" in payload) || !("timestamp" in payload) || !("id" in payload) || payload.status !== status || typeof payload.timestamp !== "string" || (payload.timestamp !== "9999-12-31T23:59:59.999999Z" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(payload.timestamp)) || typeof payload.id !== "number" || !Number.isSafeInteger(payload.id) || payload.id < 1) throw ValidationFailed.withDetails([{ field: "cursor", issue: "is invalid" }]);
        return payload as QueueCursorPayload;
    }
    async queue(query: QueueQuery): Promise<QueuePage> {
        const position = query.cursor ? this.decodeCursor(query.cursor, query.status) : undefined;
        const rows = await listQueue(query, position, this.db);
        const hasMore = rows.length > query.limit;
        const page = rows.slice(0, query.limit);
        const docs = await listDocumentsBatch(page.map((row) => row.profile.id), this.db);
        const { users } = await this.identity.getUsersBatch(page.map((row) => row.profile.userId), this.requestId());
        const items = page.map(({ profile }) => { const user = users.get(profile.userId); return { profile, documents: docs.get(profile.id) ?? [], doctor: { displayName: user?.displayName ?? null, avatarUrl: user?.avatarUrl ?? null, profileHydrated: user !== undefined } }; });
        const last = page[page.length - 1];
        return { items, meta: { nextCursor: hasMore && last ? this.encodeCursor({ status: query.status, timestamp: last.cursorTimestamp, id: last.profile.id }) : null, hasMore, count: items.length } };
    }
    /** Worker-facing purge primitives; loops own scheduling and singleton locking. */
    listExpiredOpenIntents(limit = 500): ReturnType<typeof listExpiredOpenIntents> { return listExpiredOpenIntents(limit, this.db); }
    async closeExpiredIntent(id: number): Promise<void> { await this.db.transaction(async (trx) => { const intent = await findIntentForUpdate(id, trx); if (intent?.kind === "verification_document" && intent.consumed_at === null && intent.expires_at.getTime() <= Date.now()) await closeIntent(id, null, trx); }); }
    withIntentLock<T>(id: number, work: () => Promise<T>): Promise<T | undefined> { return withSessionAdvisoryLock(this.db, VERIFICATION_INTENT_LOCK_NAMESPACE, id, work); }
    deleteIntentsOlderThan(cutoff: Date, limit = 500): Promise<number> { return deleteIntentsOlderThan(cutoff, limit, this.db); }
}
