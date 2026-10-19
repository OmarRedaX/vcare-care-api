/* eslint-disable @typescript-eslint/unbound-method */
import "reflect-metadata";
import type { Knex } from "knex";
import { RECORD_ATTACHMENT_ENTITY_TYPE, RECORD_ATTACHMENT_KEY_PREFIX, RECORD_ATTACHMENT_MAX_PER_RECORD, TRG_RECORD_ATTACHMENTS_FORBID_DELETE_AFTER_LOCK } from "../../../../src/app/record-attachments/constants";
import type { RecordAttachment } from "../../../../src/app/record-attachments/entity/record-attachment.entity";
import { RecordAttachmentAuditAction } from "../../../../src/app/record-attachments/enums";
import * as repo from "../../../../src/app/record-attachments/repository/record-attachments.repo";
import { RecordAttachmentsService } from "../../../../src/app/record-attachments/service/record-attachments.service";
import { UploadIntentKind } from "../../../../src/app/upload-intents/enums";
import type { CompleteRequest, UploadIntentRow } from "../../../../src/app/upload-intents/types";
import type { AuditRecorder } from "../../../../src/lib/audit/audit";
import type { AppError } from "../../../../src/lib/error/AppError";
import type { ObjectStorage } from "../../../../src/lib/storage/types";
import { admin, ATTACH_DESC, attachmentEntity, author, OBJECT_KEY, otherDoctor, patient, pgError } from "./record-attachments.fixtures";

const trx = { id: "trx", isTransaction: true } as unknown as Knex.Transaction;
const db = { id: "db" } as unknown as Knex;
const EXPECTED_TTL = 60;

interface Target { id: number; patientUserId: number; doctorUserId: number }
type Completion = CompleteRequest<RecordAttachment, Target>;
const TARGET: Target = { id: 9, patientUserId: 101, doctorUserId: 202 };

function setup() {
    const events: string[] = [];
    const transaction = jest.fn(async (callback: (conn: Knex.Transaction) => Promise<unknown>) => {
        events.push("begin");
        const result = await callback(trx);
        events.push("commit");
        return result;
    });
    const conn = { id: "db", transaction } as unknown as Knex;
    const record = jest.fn().mockImplementation(() => { events.push("audit"); return Promise.resolve(); });
    const links = {
        findAccessRow: jest.fn().mockResolvedValue({ ...TARGET }),
        lockForNoKeyUpdate: jest.fn().mockImplementation(() => { events.push("lock"); return Promise.resolve({ ...TARGET, isLocked: false }); }),
    };
    const intents = { create: jest.fn().mockResolvedValue({ uploadId: 5, url: "https://storage.test/u", fields: {}, expiresAt: "2030-01-01T10:15:00.000Z", maxBytes: 10_485_760 }), complete: jest.fn() };
    const storage = { createUploadPolicy: jest.fn(), delete: jest.fn(), headObject: jest.fn(), readHead: jest.fn(), promote: jest.fn(),
        presignDownload: jest.fn().mockImplementation(() => { events.push("presign"); return Promise.resolve({ url: "https://storage.test/d", expiresAt: "2030-01-01T10:01:00.000Z" }); }) } as unknown as jest.Mocked<ObjectStorage>;
    const service = new RecordAttachmentsService(conn, { record } as unknown as AuditRecorder, links as never, intents as never, storage, { DOWNLOAD_URL_TTL_SECONDS: EXPECTED_TTL } as never);
    const spies = {
        count: jest.spyOn(repo, "countLiveByRecord").mockImplementation(() => { events.push("count"); return Promise.resolve(0); }),
        insert: jest.spyOn(repo, "insertAttachment").mockImplementation((input) => { events.push("insert"); return Promise.resolve(attachmentEntity({ id: 41, recordId: input.recordId, objectKey: input.objectKey, fileType: input.fileType,
            sizeBytes: input.sizeBytes, attachmentDescription: input.attachmentDescription })); }),
        findLive: jest.spyOn(repo, "findLive").mockImplementation(() => { events.push("findLive"); return Promise.resolve(attachmentEntity()); }),
        findLiveById: jest.spyOn(repo, "findLiveById").mockResolvedValue(attachmentEntity()),
        softDelete: jest.spyOn(repo, "softDelete").mockImplementation(() => { events.push("softDelete"); return Promise.resolve(1); }),
    };
    return { service, events, record, links, intents, storage, spies, transaction };
}

type Ctx = ReturnType<typeof setup>;

const rejection = async (run: () => Promise<unknown>): Promise<AppError> => {
    try { await run(); } catch (error) { return error as AppError; }
    throw new Error("expected a rejection");
};

/** Runs `service.complete` against a stand-in for the shared flow and hands back the callbacks it supplied. */
async function captureCompletion(ctx: Ctx, recordId = 9, uploadId = 5): Promise<Completion> {
    let request: Completion | undefined;
    ctx.intents.complete.mockImplementation((req: Completion) => { request = req; return Promise.resolve({ row: attachmentEntity(), replay: false }); });
    await ctx.service.complete(author, recordId, uploadId);
    if (request === undefined) throw new Error("complete was not delegated");
    return request;
}
const intentRow = (changes: Partial<UploadIntentRow> = {}): UploadIntentRow => ({ id: 5, kind: UploadIntentKind.RecordAttachment, target_id: 9, owner_user_id: 202,
    document_type: null, description: ATTACH_DESC, quarantine_key: "quarantine/synthetic", max_bytes: 10_485_760, expires_at: new Date(Date.now() + 60_000), consumed_at: null, result_id: null, created_at: new Date(), ...changes });
const verified = { intent: intentRow(), finalKey: `${RECORD_ATTACHMENT_KEY_PREFIX}final-uuid`, fileType: "image/png" as const, sizeBytes: 777 };

afterEach(() => { jest.restoreAllMocks(); });

describe("record-attachments constants", () => {
    it("should keep the cap, the entity type, the key prefix, the trigger name and the audit actions stable", () => {
        expect(RECORD_ATTACHMENT_MAX_PER_RECORD).toBe(20);
        expect(RECORD_ATTACHMENT_ENTITY_TYPE).toBe("record_attachment");
        expect(RECORD_ATTACHMENT_KEY_PREFIX).toBe("record-attachments/");
        expect(TRG_RECORD_ATTACHMENTS_FORBID_DELETE_AFTER_LOCK).toBe("trg_record_attachments_forbid_delete_after_lock");
        expect(Object.values(RecordAttachmentAuditAction)).toEqual(["attachment.added", "attachment.removed", "attachment.url_issued"]);
    });
});

describe("RecordAttachmentsService.createIntent", () => {
    it("should answer NotFound before any count when the record is absent", async () => {
        const { service, links, spies, intents } = setup();
        links.findAccessRow.mockResolvedValue(undefined);
        expect((await rejection(() => service.createIntent(author, 9, { attachmentDescription: null }))).code).toBe("NotFound");
        expect(spies.count).not.toHaveBeenCalled();
        expect(intents.create).not.toHaveBeenCalled();
    });

    it("should answer NotFound before any count when the caller is not the record's author", async () => {
        const { service, spies, intents } = setup();
        const err = await rejection(() => service.createIntent(otherDoctor, 9, { attachmentDescription: null }));
        expect([err.code, err.status]).toEqual(["NotFound", 404]);
        expect(spies.count).not.toHaveBeenCalled();
        expect(intents.create).not.toHaveBeenCalled();
    });

    it("should answer AttachmentLimitReached when the record already holds 20 live attachments and create no intent", async () => {
        const { service, spies, intents } = setup();
        spies.count.mockResolvedValue(20);
        const err = await rejection(() => service.createIntent(author, 9, { attachmentDescription: null }));
        expect([err.code, err.status]).toEqual(["AttachmentLimitReached", 409]);
        expect(intents.create).not.toHaveBeenCalled();
    });

    it("should create the intent when the record holds 19 live attachments, counting on the pool and not in a transaction", async () => {
        const { service, spies, intents, transaction } = setup();
        spies.count.mockResolvedValue(19);
        const result = await service.createIntent(author, 9, { attachmentDescription: null });
        expect(result.uploadId).toBe(5);
        expect(spies.count).toHaveBeenCalledWith(9, expect.objectContaining({ id: "db" }));
        expect(transaction).not.toHaveBeenCalled();
        expect(intents.create).toHaveBeenCalledTimes(1);
    });

    it("should hand the shared module the attachment kind, the record as target, the caller as owner, no document type and the description, and write no audit row", async () => {
        const { service, intents, record } = setup();
        await service.createIntent(author, 9, { attachmentDescription: ATTACH_DESC });
        expect(intents.create).toHaveBeenCalledWith({ kind: UploadIntentKind.RecordAttachment, targetId: 9, ownerUserId: 202, documentType: null, description: ATTACH_DESC });
        expect(record).not.toHaveBeenCalled();
    });

    it("should pass a null description through when the body had none", async () => {
        const { service, intents } = setup();
        await service.createIntent(author, 9, { attachmentDescription: null });
        expect((intents.create.mock.calls[0]?.[0] as { description: unknown }).description).toBeNull();
    });
});

describe("RecordAttachmentsService.complete", () => {
    it("should delegate to the shared flow with the attachment kind, the caller as owner and the attachment key prefix", async () => {
        const request = await captureCompletion(setup());
        expect(request).toMatchObject({ uploadId: 5, kind: UploadIntentKind.RecordAttachment, ownerUserId: 202, finalKeyPrefix: "record-attachments/" });
    });

    it.each([[false], [true]])("should surface replay=%s from the shared flow unchanged", async (replay) => {
        const ctx = setup();
        const row = attachmentEntity({ id: 77 });
        ctx.intents.complete.mockResolvedValue({ row, replay });
        expect(await ctx.service.complete(author, 9, 5)).toEqual({ attachment: row, replay });
    });

    describe("authorizeTarget", () => {
        it("should answer NotFound when the intent targets another record, before any record read", async () => {
            const ctx = setup();
            const request = await captureCompletion(ctx);
            expect((await rejection(() => request.authorizeTarget(intentRow({ target_id: 10 }), db))).code).toBe("NotFound");
            expect(ctx.links.findAccessRow).not.toHaveBeenCalled();
        });

        it("should answer NotFound when the record is gone", async () => {
            const ctx = setup();
            const request = await captureCompletion(ctx);
            ctx.links.findAccessRow.mockResolvedValue(undefined);
            expect((await rejection(() => request.authorizeTarget(intentRow(), db))).code).toBe("NotFound");
        });

        it("should answer NotFound when the intent owner is no longer the record's author", async () => {
            const ctx = setup();
            const request = await captureCompletion(ctx);
            ctx.links.findAccessRow.mockResolvedValue({ ...TARGET, doctorUserId: 999 });
            expect((await rejection(() => request.authorizeTarget(intentRow(), db))).code).toBe("NotFound");
        });

        it("should return the access row, read on the connection it is given, for the author", async () => {
            const ctx = setup();
            const request = await captureCompletion(ctx);
            expect(await request.authorizeTarget(intentRow(), trx)).toEqual(TARGET);
            expect(ctx.links.findAccessRow).toHaveBeenCalledWith(9, trx);
        });
    });

    describe("findResult", () => {
        it("should look the replayed row up by id on the connection it is given", async () => {
            const ctx = setup();
            const request = await captureCompletion(ctx);
            expect((await request.findResult(41, trx))?.id).toBe(41);
            expect(ctx.spies.findLiveById).toHaveBeenCalledWith(41, trx);
        });

        it("should return undefined when the replayed attachment is no longer live", async () => {
            const ctx = setup();
            const request = await captureCompletion(ctx);
            ctx.spies.findLiveById.mockResolvedValue(undefined);
            expect(await request.findResult(41, db)).toBeUndefined();
        });
    });

    describe("precheck", () => {
        it("should throw AttachmentLimitReached at 20 live attachments, counting on the given connection", async () => {
            const ctx = setup();
            const request = await captureCompletion(ctx);
            ctx.spies.count.mockResolvedValue(20);
            const err = await rejection(() => request.precheck(TARGET, db));
            expect([err.code, err.status]).toEqual(["AttachmentLimitReached", 409]);
            expect(ctx.spies.count).toHaveBeenCalledWith(9, db);
        });

        it("should pass at 19 live attachments and never look at the lock", async () => {
            const ctx = setup();
            const request = await captureCompletion(ctx);
            ctx.spies.count.mockResolvedValue(19);
            await expect(request.precheck(TARGET, db)).resolves.toBeUndefined();
            expect(ctx.links.lockForNoKeyUpdate).not.toHaveBeenCalled();
        });
    });

    describe("insertResult", () => {
        it("should lock the record, count, insert and audit in that order inside the given transaction", async () => {
            const ctx = setup();
            const request = await captureCompletion(ctx);
            ctx.events.length = 0;
            const inserted = await request.insertResult(verified, trx);
            expect(ctx.events).toEqual(["lock", "count", "insert", "audit"]);
            expect(ctx.links.lockForNoKeyUpdate).toHaveBeenCalledWith(9, trx);
            expect(ctx.spies.count).toHaveBeenCalledWith(9, trx);
            expect(inserted).toEqual({ row: expect.objectContaining({ id: 41 }), id: 41 });
        });

        it("should insert the verified key, detected type and size with the description copied from the intent and the author as uploader", async () => {
            const ctx = setup();
            const request = await captureCompletion(ctx);
            await request.insertResult(verified, trx);
            expect(ctx.spies.insert).toHaveBeenCalledWith({ recordId: 9, uploadedByUserId: 202, objectKey: verified.finalKey, fileType: "image/png", sizeBytes: 777, attachmentDescription: ATTACH_DESC }, trx);
        });

        it("should insert a null description when the intent had none", async () => {
            const ctx = setup();
            const request = await captureCompletion(ctx);
            await request.insertResult({ ...verified, intent: intentRow({ description: null }) }, trx);
            expect(ctx.spies.insert.mock.calls[0]?.[0].attachmentDescription).toBeNull();
        });

        it.each([[false], [true]])("should audit attachment.added with the flat metadata and afterLock=%s taken from the database lock verdict", async (isLocked) => {
            const ctx = setup();
            const request = await captureCompletion(ctx);
            ctx.links.lockForNoKeyUpdate.mockResolvedValue({ ...TARGET, isLocked });
            await request.insertResult(verified, trx);
            expect(ctx.record).toHaveBeenCalledTimes(1);
            expect(ctx.record).toHaveBeenCalledWith(trx, { actor: { kind: "user", userId: 202, role: "doctor" }, action: "attachment.added", entityType: "record_attachment", entityId: 41,
                metadata: { recordId: 9, fileType: "image/png", sizeBytes: 777, afterLock: isLocked } });
        });

        it("should keep the description, the object key and any URL out of the audit entry", async () => {
            const ctx = setup();
            const request = await captureCompletion(ctx);
            await request.insertResult(verified, trx);
            const logged = JSON.stringify(ctx.record.mock.calls);
            for (const text of [ATTACH_DESC, OBJECT_KEY, verified.finalKey, "quarantine/", "http"]) expect(logged).not.toContain(text);
        });

        it("should add the attachment on a locked record without any reason or refusal (append-only)", async () => {
            const ctx = setup();
            const request = await captureCompletion(ctx);
            ctx.links.lockForNoKeyUpdate.mockResolvedValue({ ...TARGET, isLocked: true });
            await expect(request.insertResult(verified, trx)).resolves.toBeDefined();
            expect(ctx.spies.insert).toHaveBeenCalledTimes(1);
        });

        it("should answer NotFound and write nothing when the record vanished under the lock", async () => {
            const ctx = setup();
            const request = await captureCompletion(ctx);
            ctx.links.lockForNoKeyUpdate.mockResolvedValue(undefined);
            expect((await rejection(() => request.insertResult(verified, trx))).code).toBe("NotFound");
            expect(ctx.spies.count).not.toHaveBeenCalled();
            expect(ctx.spies.insert).not.toHaveBeenCalled();
            expect(ctx.record).not.toHaveBeenCalled();
        });

        it("should answer NotFound and write nothing when the locked record belongs to another author", async () => {
            const ctx = setup();
            const request = await captureCompletion(ctx);
            ctx.links.lockForNoKeyUpdate.mockResolvedValue({ ...TARGET, doctorUserId: 999, isLocked: false });
            expect((await rejection(() => request.insertResult(verified, trx))).code).toBe("NotFound");
            expect(ctx.spies.insert).not.toHaveBeenCalled();
            expect(ctx.record).not.toHaveBeenCalled();
        });

        it("should answer AttachmentLimitReached with no insert and no audit when the count under the lock is 20", async () => {
            const ctx = setup();
            const request = await captureCompletion(ctx);
            ctx.spies.count.mockResolvedValue(20);
            const err = await rejection(() => request.insertResult(verified, trx));
            expect([err.code, err.status]).toEqual(["AttachmentLimitReached", 409]);
            expect(ctx.spies.insert).not.toHaveBeenCalled();
            expect(ctx.record).not.toHaveBeenCalled();
        });

        it("should insert when the count under the lock is 19", async () => {
            const ctx = setup();
            const request = await captureCompletion(ctx);
            ctx.spies.count.mockResolvedValue(19);
            await request.insertResult(verified, trx);
            expect(ctx.spies.insert).toHaveBeenCalledTimes(1);
        });

        it("should let an audit failure propagate so the shared transaction rolls the insert back", async () => {
            const ctx = setup();
            const request = await captureCompletion(ctx);
            ctx.record.mockRejectedValue(new Error("audit down"));
            await expect(request.insertResult(verified, trx)).rejects.toThrow("audit down");
            expect(ctx.spies.insert).toHaveBeenCalledTimes(1);
        });

        it("should make no storage call and read no record through the access row", async () => {
            const ctx = setup();
            const request = await captureCompletion(ctx);
            await request.insertResult(verified, trx);
            for (const fn of Object.values(ctx.storage)) expect(fn).not.toHaveBeenCalled();
            expect(ctx.links.findAccessRow).not.toHaveBeenCalled();
        });
    });
});

describe("RecordAttachmentsService.downloadUrl", () => {
    it("should commit the audit row before the URL is signed", async () => {
        const { service, events } = setup();
        await service.downloadUrl(patient, 9, 41);
        expect(events).toEqual(["begin", "findLive", "audit", "commit", "presign"]);
    });

    it("should sign the stored key with its verified type and the configured TTL, and return only url and expiresAt", async () => {
        const { service, storage } = setup();
        const result = await service.downloadUrl(patient, 9, 41);
        expect(storage.presignDownload).toHaveBeenCalledWith(OBJECT_KEY, "application/pdf", EXPECTED_TTL);
        expect(result).toEqual({ url: "https://storage.test/d", expiresAt: "2030-01-01T10:01:00.000Z" });
    });

    it("should read the attachment inside the transaction, scoped to the record in the path", async () => {
        const { service, spies } = setup();
        await service.downloadUrl(patient, 9, 41);
        expect(spies.findLive).toHaveBeenCalledWith(41, 9, trx);
    });

    it("should write exactly one attachment.url_issued row per issued URL", async () => {
        const { service, record } = setup();
        await service.downloadUrl(patient, 9, 41);
        expect(record).toHaveBeenCalledTimes(1);
        expect(record).toHaveBeenCalledWith(trx, { actor: { kind: "user", userId: 101, role: "patient" }, action: "attachment.url_issued", entityType: "record_attachment", entityId: 41,
            metadata: { recordId: 9, viewerRole: "patient", viewerIsAuthor: false } });
    });

    it.each([[author, true], [otherDoctor, false]])("should record viewerIsAuthor correctly for a doctor viewer (%#)", async (viewer, isAuthor) => {
        const { service, record } = setup();
        await service.downloadUrl(viewer, 9, 41);
        expect((record.mock.calls[0]?.[1] as { metadata: unknown }).metadata).toEqual({ recordId: 9, viewerRole: "doctor", viewerIsAuthor: isAuthor });
    });

    it("should fail closed and issue no URL when the audit insert fails", async () => {
        const { service, record, storage, events } = setup();
        record.mockRejectedValue(new Error("audit down"));
        await expect(service.downloadUrl(patient, 9, 41)).rejects.toThrow("audit down");
        expect(storage.presignDownload).not.toHaveBeenCalled();
        expect(events).not.toContain("presign");
        expect(events).not.toContain("commit");
    });

    it("should answer NotFound with no audit row and no presign when the attachment is absent, foreign or deleted", async () => {
        const { service, record, storage, spies } = setup();
        spies.findLive.mockResolvedValue(undefined);
        const err = await rejection(() => service.downloadUrl(patient, 9, 41));
        expect([err.code, err.status]).toEqual(["NotFound", 404]);
        expect(record).not.toHaveBeenCalled();
        expect(storage.presignDownload).not.toHaveBeenCalled();
    });

    it("should answer Forbidden for an admin before any read, audit or presign", async () => {
        const { service, record, storage, spies, transaction } = setup();
        const err = await rejection(() => service.downloadUrl(admin, 9, 41));
        expect([err.code, err.status]).toEqual(["Forbidden", 403]);
        expect(transaction).not.toHaveBeenCalled();
        expect(spies.findLive).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
        expect(storage.presignDownload).not.toHaveBeenCalled();
    });

    it("should keep the object key, the description and the URL out of the audit entry", async () => {
        const { service, record } = setup();
        await service.downloadUrl(patient, 9, 41);
        const logged = JSON.stringify(record.mock.calls);
        for (const text of [OBJECT_KEY, ATTACH_DESC, "https://"]) expect(logged).not.toContain(text);
    });
});

describe("RecordAttachmentsService.remove", () => {
    it("should lock the record, read the attachment, soft delete and audit in that order in one transaction", async () => {
        const { service, events, transaction } = setup();
        await service.remove(author, 9, 41);
        expect(events).toEqual(["begin", "lock", "findLive", "softDelete", "audit", "commit"]);
        expect(transaction).toHaveBeenCalledTimes(1);
    });

    it("should soft delete the attachment on the transaction and audit attachment.removed with the record id only", async () => {
        const { service, record, spies, links } = setup();
        expect(await service.remove(author, 9, 41)).toBeUndefined();
        expect(links.lockForNoKeyUpdate).toHaveBeenCalledWith(9, trx);
        expect(spies.findLive).toHaveBeenCalledWith(41, 9, trx);
        expect(spies.softDelete).toHaveBeenCalledWith(41, trx);
        expect(record).toHaveBeenCalledWith(trx, { actor: { kind: "user", userId: 202, role: "doctor" }, action: "attachment.removed", entityType: "record_attachment", entityId: 41, metadata: { recordId: 9 } });
    });

    it("should answer NotFound before reading the attachment when the record is absent", async () => {
        const { service, links, spies, record } = setup();
        links.lockForNoKeyUpdate.mockResolvedValue(undefined);
        expect((await rejection(() => service.remove(author, 9, 41))).code).toBe("NotFound");
        expect(spies.findLive).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
    });

    it("should answer NotFound when the locked record has another author, even when it is locked", async () => {
        const { service, links, spies } = setup();
        links.lockForNoKeyUpdate.mockResolvedValue({ ...TARGET, doctorUserId: 999, isLocked: true });
        expect((await rejection(() => service.remove(author, 9, 41))).code).toBe("NotFound");
        expect(spies.findLive).not.toHaveBeenCalled();
        expect(spies.softDelete).not.toHaveBeenCalled();
    });

    it("should answer NotFound, not RecordLocked, when the attachment is absent and the record is locked (order one)", async () => {
        const { service, links, spies, record } = setup();
        links.lockForNoKeyUpdate.mockResolvedValue({ ...TARGET, isLocked: true });
        spies.findLive.mockResolvedValue(undefined);
        const err = await rejection(() => service.remove(author, 9, 41));
        expect([err.code, err.status]).toEqual(["NotFound", 404]);
        expect(spies.softDelete).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
    });

    it("should answer RecordLocked with no update and no audit when the attachment exists and the record is locked (order two)", async () => {
        const { service, links, spies, record } = setup();
        links.lockForNoKeyUpdate.mockResolvedValue({ ...TARGET, isLocked: true });
        const err = await rejection(() => service.remove(author, 9, 41));
        expect([err.code, err.status]).toEqual(["RecordLocked", 409]);
        expect(spies.softDelete).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
    });

    it("should answer NotFound and not audit when the soft delete touches no row (a concurrent delete)", async () => {
        const { service, spies, record } = setup();
        spies.softDelete.mockResolvedValue(0);
        expect((await rejection(() => service.remove(author, 9, 41))).code).toBe("NotFound");
        expect(record).not.toHaveBeenCalled();
    });

    it("should map the after-lock trigger's check_violation to RecordLocked", async () => {
        const { service, spies } = setup();
        spies.softDelete.mockRejectedValue(pgError("23514", TRG_RECORD_ATTACHMENTS_FORBID_DELETE_AFTER_LOCK));
        const err = await rejection(() => service.remove(author, 9, 41));
        expect([err.code, err.status]).toEqual(["RecordLocked", 409]);
    });

    it("should rethrow another check_violation unchanged", async () => {
        const { service, spies } = setup();
        const other = pgError("23514", "chk_record_attachments_size");
        spies.softDelete.mockRejectedValue(other);
        await expect(service.remove(author, 9, 41)).rejects.toBe(other);
    });

    it("should rethrow a check_violation without a constraint name and another SQLSTATE that carries the trigger name", async () => {
        const { service, spies } = setup();
        const bare = pgError("23514");
        spies.softDelete.mockRejectedValueOnce(bare);
        await expect(service.remove(author, 9, 41)).rejects.toBe(bare);
        const wrongState = pgError("23505", TRG_RECORD_ATTACHMENTS_FORBID_DELETE_AFTER_LOCK);
        spies.softDelete.mockRejectedValueOnce(wrongState);
        await expect(service.remove(author, 9, 41)).rejects.toBe(wrongState);
    });

    it("should rethrow a non-database error unchanged", async () => {
        const { service, links } = setup();
        const boom = new Error("connection reset");
        links.lockForNoKeyUpdate.mockRejectedValue(boom);
        await expect(service.remove(author, 9, 41)).rejects.toBe(boom);
    });

    it("should let an audit failure propagate so the soft delete rolls back", async () => {
        const { service, record, events } = setup();
        record.mockRejectedValue(new Error("audit down"));
        await expect(service.remove(author, 9, 41)).rejects.toThrow("audit down");
        expect(events).not.toContain("commit");
    });

    it("should make no storage call, keeping the stored object (RA-D4)", async () => {
        const { service, storage, intents } = setup();
        await service.remove(author, 9, 41);
        for (const fn of Object.values(storage)) expect(fn).not.toHaveBeenCalled();
        expect(intents.complete).not.toHaveBeenCalled();
        expect(intents.create).not.toHaveBeenCalled();
    });
});
