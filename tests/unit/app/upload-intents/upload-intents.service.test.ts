/* eslint-disable @typescript-eslint/unbound-method */
import type { Knex } from "knex";
import * as repo from "../../../../src/app/upload-intents/repository/upload-intents.repo";
import * as locks from "../../../../src/lib/knex/session-advisory-lock";
import { INTENT_PURGE_BATCH, INTENT_PURGE_LOCK_NAMESPACE, INTENT_PURGE_LOOP_NAME, INTENT_RETENTION_MS, MAX_UPLOAD_BYTES, QUARANTINE_KEY_PREFIX, UPLOAD_INTENT_LOCK_NAMESPACE } from "../../../../src/app/upload-intents/constants";
import { UploadIntentKind } from "../../../../src/app/upload-intents/enums";
import { UploadIntentsService } from "../../../../src/app/upload-intents/service/upload-intents.service";
import type { CompleteRequest, UploadIntentRow } from "../../../../src/app/upload-intents/types";
import { IDENTITY_SYNC_LOCK_NAMESPACE } from "../../../../src/app/identity-sync/constants";
import { getEnv } from "../../../../src/lib/config/env";
import { logger } from "../../../../src/lib/logger/logger";
import type { ObjectStorage } from "../../../../src/lib/storage/types";

const OWNER = 202;
const PDF = Buffer.from("%PDF-1.7 synthetic");
type Row = { id: number };

const intentRow = (kind: UploadIntentKind, changes: Partial<UploadIntentRow> = {}): UploadIntentRow => ({
    id: 3, kind, target_id: 1, owner_user_id: OWNER, document_type: kind === UploadIntentKind.VerificationDocument ? "license" : null, description: null,
    quarantine_key: "quarantine/synthetic", max_bytes: MAX_UPLOAD_BYTES, expires_at: new Date(Date.now() + 60_000), consumed_at: null, result_id: null, created_at: new Date(), ...changes,
});

describe("upload-intents constants", () => {
    it("should keep the lock namespaces and the purge loop name stable", () => {
        expect([UPLOAD_INTENT_LOCK_NAMESPACE, IDENTITY_SYNC_LOCK_NAMESPACE, INTENT_PURGE_LOCK_NAMESPACE]).toEqual([1101, 1102, 1103]);
        expect(INTENT_PURGE_LOOP_NAME).toBe("upload-intent-purge");
        expect([INTENT_PURGE_BATCH, MAX_UPLOAD_BYTES, QUARANTINE_KEY_PREFIX, INTENT_RETENTION_MS]).toEqual([500, 10_485_760, "quarantine/", 7 * 24 * 60 * 60 * 1000]);
    });
});

describe.each([UploadIntentKind.VerificationDocument, UploadIntentKind.RecordAttachment])("UploadIntentsService (kind %s)", (kind) => {
    const storage = { createUploadPolicy: jest.fn(), delete: jest.fn(), headObject: jest.fn(), readHead: jest.fn(), promote: jest.fn(), presignDownload: jest.fn() } as unknown as jest.Mocked<ObjectStorage>;
    const trx = { fn: { now: () => new Date() } } as unknown as Knex.Transaction;
    const db = { transaction: jest.fn(async (work: (t: Knex.Transaction) => Promise<unknown>) => work(trx)) } as unknown as Knex;
    const service = new UploadIntentsService(db, storage, getEnv());
    const created: Row = { id: 77 };
    const authorizeTarget = jest.fn();
    const findResult = jest.fn();
    const precheck = jest.fn();
    const insertResult = jest.fn();
    const request = (): CompleteRequest<Row, string> => ({ uploadId: 3, kind, ownerUserId: OWNER, finalKeyPrefix: "final-prefix/", authorizeTarget, findResult, precheck, insertResult });
    let close: jest.SpiedFunction<typeof repo.closeIntent>;
    let metric: jest.SpiedFunction<typeof logger.metric>;
    let errorLog: jest.SpiedFunction<typeof logger.error>;

    beforeEach(() => {
        jest.restoreAllMocks(); jest.clearAllMocks();
        (db.transaction as jest.Mock).mockImplementation(async (work: (t: Knex.Transaction) => Promise<unknown>) => work(trx));
        jest.spyOn(locks, "withSessionAdvisoryLock").mockImplementation(async (_db, _namespace, _id, work) => work());
        authorizeTarget.mockResolvedValue("target"); precheck.mockResolvedValue(undefined); findResult.mockResolvedValue(created);
        insertResult.mockResolvedValue({ row: created, id: created.id });
        storage.delete.mockResolvedValue(undefined); storage.promote.mockResolvedValue(undefined);
        storage.createUploadPolicy.mockResolvedValue({ url: "https://storage.test/upload", fields: { key: "k" } });
        storage.headObject.mockResolvedValue({ sizeBytes: PDF.length, etag: "\"etag-1\"" });
        storage.readHead.mockResolvedValue(PDF);
        close = jest.spyOn(repo, "closeIntent").mockResolvedValue(undefined);
        metric = jest.spyOn(logger, "metric").mockImplementation(() => undefined);
        errorLog = jest.spyOn(logger, "error").mockImplementation(() => undefined);
        jest.spyOn(repo, "findIntent").mockResolvedValue(intentRow(kind));
        jest.spyOn(repo, "findIntentForUpdate").mockResolvedValue(intentRow(kind));
    });

    it("should insert the intent row and return the upload policy when an intent is created", async () => {
        const insert = jest.spyOn(repo, "insertIntent").mockResolvedValue(intentRow(kind, { id: 9 }));
        const result = await service.create({ kind, targetId: 1, ownerUserId: OWNER, documentType: kind === UploadIntentKind.VerificationDocument ? "license" : null, description: kind === UploadIntentKind.RecordAttachment ? "SYNTHETIC-DESC" : null });
        const key = storage.createUploadPolicy.mock.calls[0]?.[0] ?? "";
        expect(key).toMatch(/^quarantine\/[0-9a-f-]{36}$/);
        expect(storage.createUploadPolicy).toHaveBeenCalledWith(key, MAX_UPLOAD_BYTES, getEnv().UPLOAD_POLICY_TTL_SECONDS);
        expect(insert).toHaveBeenCalledWith(expect.objectContaining({ kind, target_id: 1, owner_user_id: OWNER, quarantine_key: key, max_bytes: MAX_UPLOAD_BYTES }), db);
        expect(result).toEqual({ uploadId: 9, url: "https://storage.test/upload", fields: { key: "k" }, expiresAt: expect.any(String), maxBytes: MAX_UPLOAD_BYTES });
    });

    it.each([
        ["absent", undefined],
        ["another owner", intentRow(UploadIntentKind.VerificationDocument, { owner_user_id: 999 })],
        ["another kind", intentRow(kind === UploadIntentKind.VerificationDocument ? UploadIntentKind.RecordAttachment : UploadIntentKind.VerificationDocument)],
    ])("should answer NotFound before any target or storage call when the intent is %s", async (_label, row) => {
        jest.spyOn(repo, "findIntent").mockResolvedValue(row);
        await expect(service.complete(request())).rejects.toMatchObject({ code: "NotFound" });
        expect(authorizeTarget).not.toHaveBeenCalled();
        expect(storage.headObject).not.toHaveBeenCalled();
    });

    it("should let the target authorization fail before the replay lookup", async () => {
        authorizeTarget.mockRejectedValue(Object.assign(new Error("denied"), { code: "NotFound" }));
        await expect(service.complete(request())).rejects.toMatchObject({ code: "NotFound" });
        expect(findResult).not.toHaveBeenCalled();
        expect(storage.headObject).not.toHaveBeenCalled();
    });

    it("should replay the created row without inserting or touching storage when the intent already has a result", async () => {
        jest.spyOn(repo, "findIntent").mockResolvedValue(intentRow(kind, { result_id: 77, consumed_at: new Date() }));
        await expect(service.complete(request())).resolves.toEqual({ row: created, replay: true });
        expect(findResult).toHaveBeenCalledWith(77, db);
        expect(insertResult).not.toHaveBeenCalled();
        expect(precheck).not.toHaveBeenCalled();
        expect(storage.headObject).not.toHaveBeenCalled();
    });

    it("should answer Conflict when the replayed row is no longer live", async () => {
        jest.spyOn(repo, "findIntent").mockResolvedValue(intentRow(kind, { result_id: 77, consumed_at: new Date() }));
        findResult.mockResolvedValue(undefined);
        await expect(service.complete(request())).rejects.toMatchObject({ code: "Conflict" });
    });

    it("should answer Conflict when the intent was consumed without a result", async () => {
        jest.spyOn(repo, "findIntent").mockResolvedValue(intentRow(kind, { consumed_at: new Date() }));
        await expect(service.complete(request())).rejects.toMatchObject({ code: "Conflict" });
        expect(storage.headObject).not.toHaveBeenCalled();
    });

    it("should delete the quarantine object, close the intent and answer UploadIntentExpired when the intent expired", async () => {
        jest.spyOn(repo, "findIntent").mockResolvedValue(intentRow(kind, { expires_at: new Date(Date.now() - 1000) }));
        await expect(service.complete(request())).rejects.toMatchObject({ code: "UploadIntentExpired", status: 410 });
        expect(storage.delete).toHaveBeenCalledWith("quarantine/synthetic");
        expect(close).toHaveBeenCalledWith(3, null, trx);
        expect(precheck).not.toHaveBeenCalled();
        expect(storage.headObject).not.toHaveBeenCalled();
    });

    it("should run the precheck after the expiry check and before any storage inspection", async () => {
        precheck.mockRejectedValue(Object.assign(new Error("full"), { code: "AttachmentLimitReached" }));
        await expect(service.complete(request())).rejects.toMatchObject({ code: "AttachmentLimitReached" });
        expect(precheck).toHaveBeenCalledWith("target", db);
        expect(storage.headObject).not.toHaveBeenCalled();
        expect(storage.delete).not.toHaveBeenCalled();
    });

    it.each([
        ["a missing object", null, null, false],
        ["an empty object", { sizeBytes: 0, etag: "\"e\"" }, null, false],
        ["an oversized object", { sizeBytes: MAX_UPLOAD_BYTES + 1, etag: "\"e\"" }, null, false],
        ["false bytes behind a pdf name", { sizeBytes: 18, etag: "\"e\"" }, Buffer.from("synthetic false PDF"), true],
    ])("should delete, close, count and reject with ValidationFailed on the file field when the stored object is %s", async (_label, head, bytes, readsHead) => {
        storage.headObject.mockResolvedValue(head);
        storage.readHead.mockResolvedValue(bytes);
        await expect(service.complete(request())).rejects.toMatchObject({ code: "ValidationFailed", details: [{ field: "file", issue: "stored file is invalid" }] });
        expect(storage.readHead).toHaveBeenCalledTimes(readsHead ? 1 : 0);
        if (readsHead) expect(storage.readHead).toHaveBeenCalledWith("quarantine/synthetic", 16);
        expect(storage.delete).toHaveBeenCalledWith("quarantine/synthetic");
        expect(close).toHaveBeenCalledWith(3, null, trx);
        expect(metric).toHaveBeenCalledWith("upload_verification_failed", 1, { reason: "invalid_file", kind });
        expect(storage.promote).not.toHaveBeenCalled();
        expect(insertResult).not.toHaveBeenCalled();
    });

    it("should pass the inspected ETag and detected type to promote and insert inside the transaction", async () => {
        const order: string[] = [];
        storage.promote.mockImplementation(() => { order.push("promote"); return Promise.resolve(); });
        (db.transaction as jest.Mock).mockImplementation(async (work: (t: Knex.Transaction) => Promise<unknown>) => {
            const result = await work(trx);
            order.push("transaction committed");
            return result;
        });
        storage.delete.mockImplementation(() => { order.push("delete quarantine"); return Promise.resolve(); });
        await expect(service.complete(request())).resolves.toEqual({ row: created, replay: false });
        expect(order).toEqual(["promote", "transaction committed", "delete quarantine"]);
        const finalKey = storage.promote.mock.calls[0]?.[1] ?? "";
        expect(finalKey).toMatch(/^final-prefix\/[0-9a-f-]{36}$/);
        expect(storage.promote).toHaveBeenCalledWith("quarantine/synthetic", finalKey, { etag: "\"etag-1\"", contentType: "application/pdf" });
        expect(storage.delete).toHaveBeenCalledWith("quarantine/synthetic");
        expect(storage.readHead).toHaveBeenCalledTimes(1);
        expect(insertResult).toHaveBeenCalledWith({ intent: expect.objectContaining({ id: 3, kind }), finalKey, fileType: "application/pdf", sizeBytes: PDF.length }, trx);
        expect(close).toHaveBeenCalledWith(3, 77, trx);
    });

    it("should keep the intent open and create no row when the quarantine object changed before the copy", async () => {
        storage.promote.mockRejectedValue(new Error("synthetic precondition failure"));
        await expect(service.complete(request())).rejects.toThrow("synthetic precondition failure");
        expect(insertResult).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
    });

    it.each([
        ["locked intent absent", undefined],
        ["locked intent consumed", intentRow(UploadIntentKind.VerificationDocument, { consumed_at: new Date() })],
        ["locked intent expired meanwhile", intentRow(UploadIntentKind.VerificationDocument, { expires_at: new Date(Date.now() - 1) })],
        ["locked intent owned by another user", intentRow(UploadIntentKind.VerificationDocument, { owner_user_id: 999 })],
    ])("should answer Conflict, insert nothing and delete the promoted object when the %s", async (_label, locked) => {
        jest.spyOn(repo, "findIntentForUpdate").mockResolvedValue(locked);
        await expect(service.complete(request())).rejects.toMatchObject({ code: "Conflict" });
        expect(insertResult).not.toHaveBeenCalled();
        expect(storage.delete).toHaveBeenLastCalledWith(storage.promote.mock.calls[0]?.[1]);
    });

    it("should delete the promoted object and rethrow when the module insert fails", async () => {
        insertResult.mockRejectedValue(new Error("synthetic insert failure"));
        await expect(service.complete(request())).rejects.toThrow("synthetic insert failure");
        expect(storage.delete).toHaveBeenCalledTimes(1);
        expect(storage.delete).toHaveBeenCalledWith(storage.promote.mock.calls[0]?.[1]);
        expect(storage.delete).not.toHaveBeenCalledWith("quarantine/synthetic");
        expect(close).not.toHaveBeenCalled();
        expect(errorLog).not.toHaveBeenCalled();
    });

    it("should log upload_orphan_cleanup_failed with the kind when deleting the promoted object also fails", async () => {
        insertResult.mockRejectedValue(new Error("synthetic insert failure"));
        storage.delete.mockRejectedValueOnce(new Error("synthetic delete failure"));
        await expect(service.complete(request())).rejects.toThrow("synthetic insert failure");
        expect(errorLog).toHaveBeenCalledWith("upload_orphan_cleanup_failed", { kind });
    });

    it("should succeed and log when post-commit quarantine cleanup fails", async () => {
        storage.delete.mockRejectedValueOnce(new Error("synthetic delete failure"));
        await expect(service.complete(request())).resolves.toEqual({ row: created, replay: false });
        expect(storage.delete).toHaveBeenCalledTimes(1);
        expect(storage.delete).toHaveBeenCalledWith("quarantine/synthetic");
        expect(errorLog).toHaveBeenCalledWith("upload_orphan_cleanup_failed", { kind });
    });

    it("should answer Conflict with Retry-After 1 when another request holds the intent lock", async () => {
        jest.spyOn(locks, "withSessionAdvisoryLock").mockResolvedValue(undefined);
        await expect(service.complete(request())).rejects.toMatchObject({ code: "Conflict", extra: { retryAfter: 1 } });
        expect(authorizeTarget).not.toHaveBeenCalled();
    });

    it("should take the per-intent advisory lock in namespace 1101 keyed by the upload id", async () => {
        const lock = jest.spyOn(locks, "withSessionAdvisoryLock").mockImplementation(async (_db, _namespace, _id, work) => work());
        await service.complete(request());
        expect(lock).toHaveBeenCalledWith(db, 1101, 3, expect.any(Function));
        await service.withIntentLock(5, () => Promise.resolve("ok"));
        expect(lock).toHaveBeenLastCalledWith(db, 1101, 5, expect.any(Function));
    });

    describe("purge primitives", () => {
        it("should list expired open intents of every kind as id and quarantine key", async () => {
            const list = jest.spyOn(repo, "listExpiredOpenIntents").mockResolvedValue([intentRow(kind, { id: 1, quarantine_key: "quarantine/a" })]);
            await expect(service.listExpiredIntents(10)).resolves.toEqual([{ id: 1, quarantineKey: "quarantine/a" }]);
            expect(list).toHaveBeenCalledWith(10, db);
        });

        it("should delete the object outside the transaction and close only an open expired intent", async () => {
            jest.spyOn(repo, "findIntentForUpdate").mockResolvedValue(intentRow(kind, { expires_at: new Date(Date.now() - 1000) }));
            await service.purgeExpiredIntent(3, "quarantine/synthetic");
            expect(storage.delete).toHaveBeenCalledWith("quarantine/synthetic");
            expect(storage.delete.mock.invocationCallOrder[0]).toBeLessThan((db.transaction as jest.Mock).mock.invocationCallOrder[0] ?? 0);
            expect(close).toHaveBeenCalledWith(3, null, trx);
        });

        it.each([
            ["consumed", intentRow(UploadIntentKind.VerificationDocument, { expires_at: new Date(Date.now() - 1000), consumed_at: new Date() })],
            ["not yet expired", intentRow(UploadIntentKind.VerificationDocument)],
            ["absent", undefined],
        ])("should not close an intent that is %s", async (_label, row) => {
            jest.spyOn(repo, "findIntentForUpdate").mockResolvedValue(row);
            await service.purgeExpiredIntent(3, "quarantine/synthetic");
            expect(close).not.toHaveBeenCalled();
        });

        it("should leave the intent open when the storage delete fails", async () => {
            storage.delete.mockRejectedValue(new Error("synthetic storage failure"));
            await expect(service.purgeExpiredIntent(3, "quarantine/synthetic")).rejects.toThrow("synthetic storage failure");
            expect(close).not.toHaveBeenCalled();
        });

        it("should delegate the retention delete with the cutoff and limit", async () => {
            const del = jest.spyOn(repo, "deleteIntentsOlderThan").mockResolvedValue(4);
            const cutoff = new Date("2026-10-01T00:00:00Z");
            await expect(service.deleteIntentsOlderThan(cutoff, 25)).resolves.toBe(4);
            expect(del).toHaveBeenCalledWith(cutoff, 25, db);
        });
    });
});
