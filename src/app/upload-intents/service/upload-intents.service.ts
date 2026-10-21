import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import type { Env } from "../../../lib/config/types";
import { TOKENS } from "../../../lib/di/tokens";
import { Conflict, NotFound, ValidationFailed } from "../../../lib/error/errors";
import { withSessionAdvisoryLock } from "../../../lib/knex/session-advisory-lock";
import { logger } from "../../../lib/logger/logger";
import type { ObjectStorage } from "../../../lib/storage/types";
import { detectFileType } from "../../../pkg/utils/detect-file-type";
import { DETECT_HEAD_BYTES, MAX_UPLOAD_BYTES, QUARANTINE_KEY_PREFIX, UPLOAD_INTENT_LOCK_NAMESPACE } from "../constants";
import { UploadIntentExpired } from "../errors";
import { closeIntent, deleteIntentsOlderThan, findIntent, findIntentForUpdate, insertIntent, listExpiredOpenIntents } from "../repository/upload-intents.repo";
import type { CompletedUpload, CompleteRequest, ExpiredIntentRef, InsertedUpload, NewIntent, UploadIntentResult, UploadIntentRow } from "../types";

/**
 * The upload-intent lifecycle shared by every module that takes direct uploads (ADR 0022): intent creation, the
 * per-intent session lock, the verify-and-promote `complete` flow, and the purge primitives. It knows no Care target:
 * each module supplies target authorization, the final key prefix and the row insert as callbacks.
 */
@injectable()
export class UploadIntentsService {
    constructor(
        @inject(TOKENS.Db) private readonly db: Knex,
        @inject(TOKENS.STORAGE) private readonly storage: ObjectStorage,
        @inject(TOKENS.Env) private readonly env: Env,
    ) {}

    /** Authorization of the target is the caller's. */
    async create(input: NewIntent): Promise<UploadIntentResult> {
        const key = `${QUARANTINE_KEY_PREFIX}${randomUUID()}`;
        const policy = await this.storage.createUploadPolicy(key, MAX_UPLOAD_BYTES, this.env.UPLOAD_POLICY_TTL_SECONDS);
        const expiresAt = new Date(Date.now() + this.env.UPLOAD_INTENT_TTL_SECONDS * 1000);
        const intent = await insertIntent({ kind: input.kind, target_id: input.targetId, owner_user_id: input.ownerUserId, document_type: input.documentType, description: input.description, quarantine_key: key, max_bytes: MAX_UPLOAD_BYTES, expires_at: expiresAt }, this.db);
        return { uploadId: intent.id, url: policy.url, fields: policy.fields, expiresAt: expiresAt.toISOString(), maxBytes: MAX_UPLOAD_BYTES };
    }

    async complete<TRow, TTarget>(request: CompleteRequest<TRow, TTarget>): Promise<CompletedUpload<TRow>> {
        const result = await withSessionAdvisoryLock(this.db, UPLOAD_INTENT_LOCK_NAMESPACE, request.uploadId, async (): Promise<CompletedUpload<TRow>> => {
            const intent = await findIntent(request.uploadId, this.db);
            if (!intent || intent.kind !== String(request.kind) || intent.owner_user_id !== request.ownerUserId) throw NotFound;
            const target = await request.authorizeTarget(intent, this.db);
            if (intent.result_id !== null) { const row = await request.findResult(intent.result_id, this.db); if (!row) throw Conflict; return { row, replay: true }; }
            if (intent.consumed_at !== null) throw Conflict;
            if (intent.expires_at.getTime() <= Date.now()) { await this.storage.delete(intent.quarantine_key); await this.db.transaction(async (trx) => closeIntent(intent.id, null, trx)); throw UploadIntentExpired; }
            await request.precheck(target, this.db);
            const head = await this.storage.headObject(intent.quarantine_key);
            const bytes = head && head.sizeBytes >= 1 && head.sizeBytes <= intent.max_bytes ? await this.storage.readHead(intent.quarantine_key, DETECT_HEAD_BYTES) : null;
            const fileType = bytes ? detectFileType(bytes) : null;
            if (!head || !fileType || head.sizeBytes < 1 || head.sizeBytes > intent.max_bytes) {
                await this.storage.delete(intent.quarantine_key);
                await this.db.transaction(async (trx) => closeIntent(intent.id, null, trx));
                logger.metric("upload_verification_failed", 1, { reason: "invalid_file", kind: request.kind });
                throw ValidationFailed.withDetails([{ field: "file", issue: "stored file is invalid" }]);
            }
            const finalKey = `${request.finalKeyPrefix}${randomUUID()}`;
            // Bound to the inspected object: if the quarantine key was re-POSTed after the checks above, the ETag no longer matches and the copy fails.
            await this.storage.promote(intent.quarantine_key, finalKey, { etag: head.etag, contentType: fileType });
            let inserted: InsertedUpload<TRow>;
            try {
                inserted = await this.db.transaction(async (trx) => {
                    const locked = await findIntentForUpdate(intent.id, trx);
                    if (!locked || locked.owner_user_id !== request.ownerUserId || locked.consumed_at !== null || locked.expires_at.getTime() <= Date.now()) throw Conflict;
                    const created = await request.insertResult({ intent: locked, finalKey, fileType, sizeBytes: head.sizeBytes }, trx);
                    await closeIntent(intent.id, created.id, trx);
                    return created;
                });
            } catch (error) { try { await this.storage.delete(finalKey); } catch { logger.error("upload_orphan_cleanup_failed", { kind: request.kind }); } throw error; }
            try { await this.storage.delete(intent.quarantine_key); } catch { logger.error("upload_orphan_cleanup_failed", { kind: request.kind }); }
            return { row: inserted.row, replay: false };
        });
        if (!result) throw Conflict.withExtra({ retryAfter: 1 });
        return result;
    }

    findIntent(id: number, conn: Knex = this.db): Promise<UploadIntentRow | undefined> { return findIntent(id, conn); }
    /** The per-intent session advisory lock (namespace 1101); `undefined` when it is refused. */
    withIntentLock<T>(id: number, work: () => Promise<T>): Promise<T | undefined> { return withSessionAdvisoryLock(this.db, UPLOAD_INTENT_LOCK_NAMESPACE, id, work); }

    /** Worker-facing purge primitives; the loop owns scheduling and singleton locking. */
    async listExpiredIntents(limit = 500): Promise<ExpiredIntentRef[]> { return (await listExpiredOpenIntents(limit, this.db)).map((intent) => ({ id: intent.id, quarantineKey: intent.quarantine_key })); }
    async purgeExpiredIntent(id: number, quarantineKey: string): Promise<void> {
        await this.storage.delete(quarantineKey);
        await this.db.transaction(async (trx) => { const intent = await findIntentForUpdate(id, trx); if (intent && intent.consumed_at === null && intent.expires_at.getTime() <= Date.now()) await closeIntent(id, null, trx); });
    }
    deleteIntentsOlderThan(cutoff: Date, limit = 500): Promise<number> { return deleteIntentsOlderThan(cutoff, limit, this.db); }
}
