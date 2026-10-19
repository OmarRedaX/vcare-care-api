import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { actorFromAuth, AuditRecorder } from "../../../lib/audit/audit";
import type { Env } from "../../../lib/config/types";
import { TOKENS } from "../../../lib/di/tokens";
import { Conflict, Forbidden, NotFound, ValidationFailed } from "../../../lib/error/errors";
import { decodeSignedCursor, encodeSignedCursor } from "../../../lib/http/pagination/signed-cursor";
import { currentRequestIdOrNew } from "../../../lib/logger/request-context";
import { IdentityClient } from "../../../lib/identity-client/identity-client";
import type { ObjectStorage } from "../../../lib/storage/types";
import type { AuthContext } from "../../../lib/types/types";
import { IdentitySyncStatus, VerificationStatus } from "../../doctors/enums";
import { IdentitySyncJobKind } from "../../identity-sync/enums";
import { IdentitySyncService } from "../../identity-sync/service/identity-sync.service";
import type { DoctorProfile } from "../../doctors/entity/doctor-profile.entity";
import { UploadIntentKind } from "../../upload-intents/enums";
import type { UploadIntentsService } from "../../upload-intents/service/upload-intents.service";
import type { UploadIntentResult } from "../../upload-intents/types";
import { VERIFICATION_DOCUMENT_KEY_PREFIX } from "../constants";
import { ApplicationNotEditable, ApplicationNotReviewable } from "../errors";
import { VerificationAuditAction, VerificationDocumentStatus, VerificationDocumentType } from "../enums";
import { applyProfileDecision, findDocument, findDocumentForUpdate, findProfileById, findProfileByUserId, insertDocument, listDocuments, listDocumentsBatch, listQueue, markProfileSubmitted, QUEUE_NULL_TIMESTAMP, softDeleteDocument, touchProfile } from "../repository/verification.repo";
import type { VerificationDocument } from "../entity/verification-document.entity";
import type { DecisionResult, DocumentCompletion, ProfileDecisionChanges, QueueCursorPayload, QueuePage, QueueQuery, SubmitSyncResult, SubmitTransition, VerificationApplicationView } from "../types";

const IDENTITY_SYNC_PENDING_RETRY_AFTER_SECONDS = 5;
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
        @inject(TOKENS.IdentitySyncService) private readonly identitySync: IdentitySyncService,
        @inject(TOKENS.UploadIntentsService) private readonly intents: UploadIntentsService,
    ) {}

    private requestId(): string { return currentRequestIdOrNew(); }
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
        await this.identitySync.supersedeOpen(profile.id, trx);
        const resubmit = profile.verificationStatus === VerificationStatus.Rejected;
        await markProfileSubmitted(profile.id, resubmit, trx);
        let jobId: number | null = null;
        if (resubmit) {
            const job = await this.identitySync.enqueue(trx, { profile, kind: IdentitySyncJobKind.Verification, targetStatus: "pending", reason: "verification resubmitted", actorUserId: actor.userId, requestId: this.requestId() });
            jobId = job.id;
        }
        await this.auditAction(trx, actor, VerificationAuditAction.Submitted, PROFILE_ENTITY, profile.id, { fromStatus: profile.verificationStatus, toStatus: VerificationStatus.Submitted });
        return { jobId };
    }
    /** Runs the inline Case-1 attempt for a resubmit. Returns status only: the doctors service builds its own view, so no Identity hydration here. */
    async finishSubmit(actor: AuthContext, transition: SubmitTransition): Promise<SubmitSyncResult | null> {
        if (transition.jobId === null) return null;
        const { status, identitySync } = await this.identitySync.syncNow(transition.jobId, actor, 3);
        return { status, ...(identitySync ? { identitySync } : {}) };
    }

    async createIntent(actor: AuthContext, type: VerificationDocumentType): Promise<UploadIntentResult> {
        const profile = await findProfileByUserId(actor.userId, this.db); if (!profile) throw NotFound; this.assertEditable(profile);
        return this.intents.create({ kind: UploadIntentKind.VerificationDocument, targetId: profile.id, ownerUserId: actor.userId, documentType: type, description: null });
    }
    async complete(actor: AuthContext, uploadId: number): Promise<DocumentCompletion> {
        const completed = await this.intents.complete<VerificationDocument, DoctorProfile>({
            uploadId, kind: UploadIntentKind.VerificationDocument, ownerUserId: actor.userId, finalKeyPrefix: VERIFICATION_DOCUMENT_KEY_PREFIX,
            authorizeTarget: async (intent, conn) => { const profile = await findProfileById(intent.target_id, conn); if (!profile || profile.userId !== actor.userId) throw NotFound; return profile; },
            findResult: (resultId, conn) => findDocument(resultId, conn),
            precheck: (profile) => { this.assertEditable(profile); return Promise.resolve(); },
            insertResult: async ({ intent, finalKey, fileType, sizeBytes }, trx) => {
                const current = await findProfileById(intent.target_id, trx, true); if (!current) throw Conflict;
                this.assertEditable(current);
                const type = Object.values(VerificationDocumentType).find((candidate) => candidate === intent.document_type); if (!type) throw Conflict;
                const inserted = await insertDocument({ doctor_profile_id: current.id, type, object_key: finalKey, file_type: fileType, size_bytes: sizeBytes, status: VerificationDocumentStatus.Uploaded }, trx);
                await this.auditAction(trx, actor, VerificationAuditAction.DocumentUploaded, DOCUMENT_ENTITY, inserted.id, { profileId: current.id });
                return { row: inserted, id: inserted.id };
            },
        });
        return { document: completed.row, replay: completed.replay };
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
            // The previous status change (resubmit/reopen -> pending) may not have reached Identity yet. Superseding that job would make
            // Identity see e.g. rejected -> active, a transition it refuses. Wait until the account is in sync.
            if (action !== "reopen" && profile.identitySyncStatus === IdentitySyncStatus.Pending) throw Conflict.withExtra({ retryAfter: IDENTITY_SYNC_PENDING_RETRY_AFTER_SECONDS });
            if (action === "approve") await this.assertRequiredDocuments(id, trx);
            await this.identitySync.supersedeOpen(id, trx);
            const status = action === "approve" ? VerificationStatus.Approved : action === "reject" ? VerificationStatus.Rejected : VerificationStatus.Submitted;
            const target = action === "approve" ? "active" : action === "reject" ? "rejected" : "pending";
            const changes: ProfileDecisionChanges = { verificationStatus: status, reviewedBy: action === "reopen" ? null : actor.userId, reviewNote: action === "reopen" ? null : note ?? null,
                stampDecidedAt: action !== "reopen", stampSubmittedAt: action === "reopen" };
            await applyProfileDecision(id, changes, trx);
            const job = await this.identitySync.enqueue(trx, { profile, kind: IdentitySyncJobKind.Verification, targetStatus: target,
                reason: note ?? `verification ${action}`, actorUserId: actor.userId, requestId: this.requestId() });
            const auditAction = action === "approve" ? VerificationAuditAction.Approved : action === "reject" ? VerificationAuditAction.Rejected : VerificationAuditAction.Reopened;
            await this.auditAction(trx, actor, auditAction, PROFILE_ENTITY, id, { fromStatus: profile.verificationStatus, toStatus: status });
            return job.id;
        });
        const report = await this.identitySync.syncNow(jobId, actor, 3);
        const view = await this.view(report.profile, actor.role === "doctor" ? "doctor" : "admin", this.requestId());
        return { view, status: report.status, ...(report.identitySync ? { identitySync: report.identitySync } : {}) };
    }
    private queuePosition(payload: unknown, status: string): QueueCursorPayload | undefined {
        if (!payload || typeof payload !== "object" || !("status" in payload) || !("timestamp" in payload) || !("id" in payload)) return undefined;
        const { status: cursorStatus, timestamp, id } = payload;
        if (cursorStatus !== status || typeof timestamp !== "string" || (timestamp !== QUEUE_NULL_TIMESTAMP && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(timestamp))) return undefined;
        if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return undefined;
        return { status, timestamp, id };
    }
    async queue(query: QueueQuery): Promise<QueuePage> {
        const position = query.cursor ? decodeSignedCursor(query.cursor, this.env.SERVICE_CLIENT_SECRET, (payload) => this.queuePosition(payload, query.status)) : undefined;
        const rows = await listQueue(query, position, this.db);
        const hasMore = rows.length > query.limit;
        const page = rows.slice(0, query.limit);
        const docs = await listDocumentsBatch(page.map((row) => row.profile.id), this.db);
        const { users } = await this.identity.getUsersBatch(page.map((row) => row.profile.userId), this.requestId());
        const items = page.map(({ profile }) => { const user = users.get(profile.userId); return { profile, documents: docs.get(profile.id) ?? [], doctor: { displayName: user?.displayName ?? null, avatarUrl: user?.avatarUrl ?? null, profileHydrated: user !== undefined } }; });
        const last = page[page.length - 1];
        return { items, meta: { nextCursor: hasMore && last ? encodeSignedCursor({ status: query.status, timestamp: last.cursorTimestamp, id: last.profile.id }, this.env.SERVICE_CLIENT_SECRET) : null, hasMore, count: items.length } };
    }
}
