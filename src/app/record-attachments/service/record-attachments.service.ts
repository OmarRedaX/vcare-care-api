import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { actorFromAuth, AuditRecorder } from "../../../lib/audit/audit";
import type { Env } from "../../../lib/config/types";
import { TOKENS } from "../../../lib/di/tokens";
import { Forbidden, NotFound } from "../../../lib/error/errors";
import { checkViolationConstraint } from "../../../lib/knex/pg-errors";
import type { DownloadUrl, ObjectStorage } from "../../../lib/storage/types";
import type { AuthContext } from "../../../lib/types/types";
import type { DoctorsService } from "../../doctors/service/doctors.service";
import { RecordLocked } from "../../records/errors";
import type { RecordLinksService } from "../../records/service/record-links.service";
import type { RecordAccessRow } from "../../records/types";
import { UploadIntentKind } from "../../upload-intents/enums";
import type { UploadIntentsService } from "../../upload-intents/service/upload-intents.service";
import type { UploadIntentResult } from "../../upload-intents/types";
import {
    RECORD_ATTACHMENT_ENTITY_TYPE, RECORD_ATTACHMENT_KEY_PREFIX, RECORD_ATTACHMENT_MAX_PER_RECORD, TRG_RECORD_ATTACHMENTS_FORBID_DELETE_AFTER_LOCK,
} from "../constants";
import type { RecordAttachment } from "../entity/record-attachment.entity";
import { RecordAttachmentAuditAction } from "../enums";
import { AttachmentLimitReached } from "../errors";
import { countLiveByRecord, findLive, findLiveById, insertAttachment, softDelete } from "../repository/record-attachments.repo";
import type { CompletedAttachment, RecordAttachmentIntentInput } from "../types";

/**
 * Write side of `record-attachments` (Domain rules 14, 15 and the cap of CLAUDE.md -> Clinical). Only the record's author writes
 * (RA-D2). The upload lifecycle is `UploadIntentsService` (ADR 0022); this class supplies the record rules as its callbacks.
 * Storage calls happen outside every transaction; every audit row is written inside the transaction of its write, except
 * `attachment.url_issued`, which is committed on its own BEFORE the URL is signed (ADR 0014). The database decides the lock and the
 * cap; the checks here give the precise error.
 */
@injectable()
export class RecordAttachmentsService {
    constructor(
        @inject(TOKENS.Db) private readonly db: Knex,
        @inject(TOKENS.AuditRecorder) private readonly audit: AuditRecorder,
        @inject(TOKENS.RecordLinksService) private readonly links: RecordLinksService,
        @inject(TOKENS.UploadIntentsService) private readonly intents: UploadIntentsService,
        @inject(TOKENS.DoctorsService) private readonly doctors: Pick<DoctorsService, "isLocallySuspended">,
        @inject(TOKENS.STORAGE) private readonly storage: ObjectStorage,
        @inject(TOKENS.Env) private readonly env: Env,
    ) {}

    /** No transaction and no audit row (an intent is not a clinical row). The cap check is a courtesy; `complete` holds the guarantee. */
    async createIntent(actor: AuthContext, recordId: number, input: RecordAttachmentIntentInput): Promise<UploadIntentResult> {
        const access = await this.links.findAccessRow(recordId);
        if (access === undefined || access.doctorUserId !== actor.userId) throw NotFound;
        if (await countLiveByRecord(recordId, this.db) >= RECORD_ATTACHMENT_MAX_PER_RECORD) throw AttachmentLimitReached;
        return this.intents.create({ kind: UploadIntentKind.RecordAttachment, targetId: recordId, ownerUserId: actor.userId, documentType: null, description: input.attachmentDescription });
    }

    /**
     * The shared verify-and-promote flow with the record rules as callbacks. Adding is allowed before and after the lock (append-only) and
     * never updates `medical_records`; the `attachment.added` row carries `afterLock` from database time. The count inside the transaction
     * runs under the record row lock, so two concurrent completes at 19 cannot both pass.
     */
    async complete(actor: AuthContext, recordId: number, uploadId: number): Promise<CompletedAttachment> {
        const completed = await this.intents.complete<RecordAttachment, RecordAccessRow>({
            uploadId, kind: UploadIntentKind.RecordAttachment, ownerUserId: actor.userId, finalKeyPrefix: RECORD_ATTACHMENT_KEY_PREFIX,
            authorizeTarget: async (intent, conn) => {
                if (intent.target_id !== recordId) throw NotFound;
                const access = await this.links.findAccessRow(recordId, conn);
                if (access === undefined || access.doctorUserId !== actor.userId) throw NotFound;
                return access;
            },
            findResult: (resultId, conn) => findLiveById(resultId, conn),
            // Courtesy before any storage call: a full record answers 409 with the quarantine object intact. NOT a lock check.
            precheck: async (_access, conn) => {
                if (await countLiveByRecord(recordId, conn) >= RECORD_ATTACHMENT_MAX_PER_RECORD) throw AttachmentLimitReached;
            },
            insertResult: async ({ intent, finalKey, fileType, sizeBytes }, trx) => {
                const lock = await this.links.lockForNoKeyUpdate(recordId, trx);
                if (lock === undefined || lock.doctorUserId !== actor.userId) throw NotFound;
                // Case 3 step 1: the policy checked suspension before the storage round trip (seconds); re-check it here so a suspension committed
                // meanwhile blocks the write. The throw rolls back; the shared flow deletes the promoted object and the intent stays open.
                if (await this.doctors.isLocallySuspended(actor.userId, trx)) throw Forbidden;
                if (await countLiveByRecord(recordId, trx) >= RECORD_ATTACHMENT_MAX_PER_RECORD) throw AttachmentLimitReached;
                const attachment = await insertAttachment({ recordId, uploadedByUserId: actor.userId, objectKey: finalKey, fileType, sizeBytes, attachmentDescription: intent.description }, trx);
                await this.audit.record(trx, { actor: actorFromAuth(actor), action: RecordAttachmentAuditAction.Added, entityType: RECORD_ATTACHMENT_ENTITY_TYPE,
                    entityId: attachment.id, metadata: { recordId, fileType, sizeBytes, afterLock: lock.isLocked } });
                return { row: attachment, id: attachment.id };
            },
        });
        return { attachment: completed.row, replay: completed.replay };
    }

    /**
     * authorize -> audit (its own committed transaction) -> presign. A failed audit insert fails the request: no URL. A `404` writes no row.
     * One audit row per issued URL. The presign is local signing, outside the transaction.
     */
    async downloadUrl(actor: AuthContext, recordId: number, attachmentId: number): Promise<DownloadUrl> {
        if (actor.role === "admin") throw Forbidden;
        const attachment = await this.db.transaction(async (trx) => {
            const found = await findLive(attachmentId, recordId, trx);
            if (found === undefined) throw NotFound;
            await this.audit.record(trx, { actor: actorFromAuth(actor), action: RecordAttachmentAuditAction.UrlIssued, entityType: RECORD_ATTACHMENT_ENTITY_TYPE,
                entityId: found.id, metadata: { recordId, viewerRole: actor.role, viewerIsAuthor: found.uploadedByUserId === actor.userId } });
            return found;
        });
        return this.storage.presignDownload(attachment.objectKey, attachment.fileType, this.env.DOWNLOAD_URL_TTL_SECONDS);
    }

    /**
     * Soft delete before the lock. The order is part of the contract: record lock `404`, attachment `404`, then the locked verdict `409`.
     * The stored object is kept (RA-D4): there is no storage call.
     */
    async remove(actor: AuthContext, recordId: number, attachmentId: number): Promise<void> {
        try {
            await this.db.transaction(async (trx) => {
                const lock = await this.links.lockForNoKeyUpdate(recordId, trx);
                if (lock === undefined || lock.doctorUserId !== actor.userId) throw NotFound;
                const attachment = await findLive(attachmentId, recordId, trx);
                if (attachment === undefined) throw NotFound;
                if (lock.isLocked) throw RecordLocked;
                if (await softDelete(attachment.id, trx) === 0) throw NotFound;
                await this.audit.record(trx, { actor: actorFromAuth(actor), action: RecordAttachmentAuditAction.Removed, entityType: RECORD_ATTACHMENT_ENTITY_TYPE,
                    entityId: attachment.id, metadata: { recordId } });
            });
        } catch (error) {
            // Defence in depth: the trigger read the same NOW() as the lock flag, so this fires only if the row was altered outside the service.
            if (checkViolationConstraint(error) === TRG_RECORD_ATTACHMENTS_FORBID_DELETE_AFTER_LOCK) throw RecordLocked;
            throw error;
        }
    }
}
