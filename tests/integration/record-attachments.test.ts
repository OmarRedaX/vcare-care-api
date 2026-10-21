import type { Response } from "supertest";
import {
    contractNoStoreValue, contractOperationBlock, contractResponseCodes, expectErrorEnvelope, expectSuccessEnvelope, inlineLists, schemaBlock,
} from "../helpers/contract";
import { ownerDb } from "../helpers/db";
import {
    ATTACH_DESC, attachmentAudits, attachmentRows, FALSE_PDF, intentRows, JPEG, PDF, PNG, storageCalls, useAttachmentsHarness,
} from "../helpers/record-attachments-fixtures";
import { getRecord, lockNow, withFailingAudit } from "../helpers/records-fixtures";

jest.setTimeout(120_000);

type Method = "post" | "delete";
const INTENT = "/api/records/{id}/attachments/uploads";
const COMPLETE = "/api/records/{id}/attachments/uploads/{uploadId}/complete";
const DOWNLOAD = "/api/records/{id}/attachments/{attachmentId}/download-url";
const REMOVE = "/api/records/{id}/attachments/{attachmentId}";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const KEY = /^record-attachments\/[0-9a-f-]{36}$/;

/** Top-level property names of a component schema (children of its `properties:` block). */
function properties(name: string): string[] {
    return [...schemaBlock(name).matchAll(/^ {8}([A-Za-z0-9]+):/gm)].map((match) => match[1] ?? "");
}

describe("record attachments: lifecycle and contract conformance (integration: real routes, Postgres, Redis; storage, Identity and video faked)", () => {
    const { h, storage, newRecord, createIntent, complete, downloadUrl, remove, upload, add, addOk, seedAttachments } = useAttachmentsHarness("record-attachments");
    const seen = new Map<string, Set<string>>();

    /** Every response is checked against the operation's declared status set, the common headers and (for errors) the envelope. */
    function conforms(res: Response, path: string, method: Method, expectedStatus: number, errorCode?: string): void {
        expect(res.status).toBe(expectedStatus);
        expect(contractResponseCodes(path, method)).toContain(String(res.status));
        expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
        expect(res.headers["cache-control"]).toBe(contractNoStoreValue());
        const key = `${method.toUpperCase()} ${path}`;
        seen.set(key, (seen.get(key) ?? new Set<string>()).add(String(res.status)));
        if (errorCode !== undefined) expectErrorEnvelope(res.body, errorCode, res.headers["x-request-id"]);
    }

    /** Every status the contract declares for the operation was produced by this suite. */
    function expectAllDeclared(path: string, method: Method): void {
        expect([...(seen.get(`${method.toUpperCase()} ${path}`) ?? [])].sort()).toEqual([...contractResponseCodes(path, method)].sort());
    }

    function expectAttachment(data: Record<string, unknown>): void {
        const required = inlineLists(schemaBlock("RecordAttachment"), "required")[0] ?? [];
        expect([...required].sort()).toEqual(Object.keys(data).sort());
        for (const key of Object.keys(data)) expect(properties("RecordAttachment")).toContain(key);
        expect(Number.isInteger(data.id) && Number.isInteger(data.recordId) && Number.isInteger(data.sizeBytes)).toBe(true);
        expect(["application/pdf", "image/jpeg", "image/png"]).toContain(data.fileType);
        expect(data.description === null || typeof data.description === "string").toBe(true);
        expect(String(data.createdAt)).toMatch(ISO);
        for (const forbidden of ["downloadUrl", "downloadUrlExpiresAt", "objectKey", "object_key", "uploadedByUserId", "deletedAt", "url"]) expect(Object.keys(data)).not.toContain(forbidden);
    }

    // ───────────────────────────────────────────── happy path
    describe("lifecycle", () => {
        it("should take an attachment from intent through complete, record read, download URL and delete, with metadata only in the reads", async () => {
            const recordId = await newRecord();
            const uploaded = await upload(recordId, { description: ATTACH_DESC });
            const completed = await complete(recordId, uploaded.uploadId);
            expect(completed.status).toBe(201);
            const attachmentId = completed.body.data.id as number;
            expect(completed.body.data).toEqual({ id: attachmentId, recordId, fileType: "application/pdf", sizeBytes: PDF.length, description: ATTACH_DESC, createdAt: completed.body.data.createdAt });

            for (const actor of ["patient", "doctor"] as const) {
                const read = await getRecord(h, recordId, actor);
                expect(read.status).toBe(200);
                expect(read.body.data.attachments).toEqual([completed.body.data]);
                expect(JSON.stringify(read.body)).not.toMatch(/record-attachments\/|quarantine\/|https?:\/\/storage\.test|objectKey|downloadUrl/);
            }

            const url = await downloadUrl(recordId, attachmentId, "patient");
            expect(url.status).toBe(200);
            expect(Object.keys(url.body.data).sort()).toEqual(["expiresAt", "url"]);
            expect(Date.parse(url.body.data.expiresAt)).toBeGreaterThan(Date.now());
            expect(Date.parse(url.body.data.expiresAt)).toBeLessThanOrEqual(Date.now() + 61_000);

            expect((await remove(recordId, attachmentId)).status).toBe(204);
            expect((await getRecord(h, recordId, "patient")).body.data.attachments).toEqual([]);
            expect((await downloadUrl(recordId, attachmentId, "patient")).status).toBe(404);
            expect((await attachmentRows()).map((row) => [row.id, row.deleted_at === null])).toEqual([[attachmentId, false]]);
        });

        it("should return the intent as uploadId, url, fields (the exact quarantine key), a 15 minute expiry and the 10 MB cap", async () => {
            const recordId = await newRecord();
            const before = Date.now();
            const res = await createIntent(recordId);
            expect(res.status).toBe(201);
            const data = res.body.data as { uploadId: number; url: string; fields: Record<string, string>; expiresAt: string; maxBytes: number };
            const required = inlineLists(schemaBlock("UploadIntent"), "required")[0] ?? [];
            expect(Object.keys(data).sort()).toEqual([...required].sort());
            expect(Number.isInteger(data.uploadId)).toBe(true);
            expect(() => new URL(data.url)).not.toThrow();
            expect(Object.values(data.fields).every((value) => typeof value === "string")).toBe(true);
            expect(data.fields.key).toMatch(/^quarantine\/[0-9a-f-]{36}$/);
            expect(data.maxBytes).toBe(10_485_760);
            expect(Date.parse(data.expiresAt)).toBeGreaterThanOrEqual(before + 15 * 60_000 - 2_000);
            expect(Date.parse(data.expiresAt)).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 2_000);
            expect(storageCalls(storage, "createUploadPolicy")).toEqual([[data.fields.key, 10_485_760, expect.any(Number)]]);
        });

        it("should store the intent bound to the record, the author and the kind, carrying the description and no attachment row yet", async () => {
            const recordId = await newRecord();
            const res = await createIntent(recordId, { description: ATTACH_DESC });
            const [row] = await intentRows();
            expect(row).toMatchObject({ kind: "record_attachment", target_id: recordId, owner_user_id: 202, document_type: null, description: ATTACH_DESC, max_bytes: 10_485_760, consumed_at: null, result_id: null });
            expect(String(row?.id)).toBe(String(res.body.data.uploadId));
            expect(row?.quarantine_key).toBe(res.body.data.fields.key);
            expect(await attachmentRows()).toEqual([]);
        });

        it.each([["a PDF", PDF, "application/pdf"], ["a PNG", PNG, "image/png"], ["a JPEG", JPEG, "image/jpeg"]])(
            "should store the detected type as fileType and the HEAD size as sizeBytes when the stored object is %s",
            async (_label, bytes, fileType) => {
                const recordId = await newRecord();
                const uploaded = await upload(recordId, { bytes });
                const res = await complete(recordId, uploaded.uploadId);
                expect(res.status).toBe(201);
                expect(res.body.data).toMatchObject({ fileType, sizeBytes: bytes.length });
                expect((await attachmentRows())[0]).toMatchObject({ file_type: fileType, size_bytes: bytes.length, uploaded_by_user_id: 202, medical_record_id: recordId });
            });

        it("should record the HEAD size, not the bytes read, as sizeBytes", async () => {
            const recordId = await newRecord();
            const uploaded = await upload(recordId);
            storage.setHeadSize(uploaded.quarantineKey, 5_000_000);
            const res = await complete(recordId, uploaded.uploadId);
            expect(res.status).toBe(201);
            expect(res.body.data.sizeBytes).toBe(5_000_000);
        });

        it("should accept the boundary sizes of 1 byte and 10485760 bytes", async () => {
            const recordId = await newRecord();
            for (const size of [1, 10_485_760]) {
                const uploaded = await upload(recordId);
                storage.setHeadSize(uploaded.quarantineKey, size);
                const res = await complete(recordId, uploaded.uploadId);
                expect([size, res.status]).toEqual([size, 201]);
                expect(res.body.data.sizeBytes).toBe(size);
            }
        });

        it("should promote the verified object to record-attachments/<uuid>, delete the quarantine object and never store a name or declared type", async () => {
            const recordId = await newRecord();
            const uploaded = await upload(recordId);
            const res = await complete(recordId, uploaded.uploadId);
            expect(res.status).toBe(201);
            const [row] = await attachmentRows();
            expect(row?.object_key).toMatch(KEY);
            expect(storage.has(row?.object_key as string)).toBe(true);
            expect(storage.has(uploaded.quarantineKey)).toBe(false);
            expect(storageCalls(storage, "promote")).toEqual([[uploaded.quarantineKey, row?.object_key]]);
            expect(storageCalls(storage, "readHead")).toEqual([[uploaded.quarantineKey, 16]]);
            const closed = (await intentRows())[0];
            expect(closed?.consumed_at).not.toBeNull();
            expect(String(closed?.result_id)).toBe(String(row?.id));
        });

        it("should round-trip the description, and answer null when none was given", async () => {
            const recordId = await newRecord();
            const withText = await add(recordId, { description: `${ATTACH_DESC}\nsecond line` });
            const without = await add(recordId);
            expect(withText.body.data.description).toBe(`${ATTACH_DESC}\nsecond line`);
            expect(without.body.data.description).toBeNull();
            const listed = (await getRecord(h, recordId, "patient")).body.data.attachments as Array<{ id: number; description: string | null }>;
            expect(listed.map((item) => item.description)).toEqual([`${ATTACH_DESC}\nsecond line`, null]);
        });

        it("should accept an absent body, an empty object and a 500 code point description on the intent", async () => {
            const recordId = await newRecord();
            expect((await createIntent(recordId)).status).toBe(201);
            expect((await createIntent(recordId, {})).status).toBe(201);
            expect((await createIntent(recordId, { description: "x".repeat(500) })).status).toBe(201);
            expect((await createIntent(recordId, { description: "é".repeat(500) })).status).toBe(201);
        });

        it("should issue a presigned GET for the stored key with the verified content type and a 60 second lifetime", async () => {
            const recordId = await newRecord();
            const id = await addOk(recordId, { bytes: PNG });
            const res = await downloadUrl(recordId, id, "doctor");
            expect(res.status).toBe(200);
            const [row] = await attachmentRows();
            expect(storageCalls(storage, "presignDownload")).toEqual([[row?.object_key, "image/png", 60]]);
        });

        it("should keep the stored object after a delete (soft delete only)", async () => {
            const recordId = await newRecord();
            const id = await addOk(recordId);
            const key = (await attachmentRows())[0]?.object_key as string;
            storage.calls.length = 0;
            expect((await remove(recordId, id)).status).toBe(204);
            expect(storage.has(key)).toBe(true);
            expect(storage.calls).toEqual([]);
            expect((await attachmentRows())[0]?.deleted_at).not.toBeNull();
        });

        it("should list several attachments oldest first and hide a deleted one", async () => {
            const recordId = await newRecord();
            const first = await addOk(recordId, { description: "first" });
            const second = await addOk(recordId, { bytes: PNG });
            const third = await addOk(recordId, { bytes: JPEG });
            expect((await remove(recordId, second)).status).toBe(204);
            const listed = (await getRecord(h, recordId, "patient")).body.data.attachments as Array<{ id: number }>;
            expect(listed.map((item) => item.id)).toEqual([first, third]);
        });
    });

    // ───────────────────────────────────────────── contract conformance, operation by operation
    describe("contract: createRecordAttachmentUploadIntent", () => {
        it("should declare the documented roles, ownership and no Idempotency-Key", () => {
            const block = contractOperationBlock(INTENT, "post");
            expect(block).toContain("x-roles: [doctor]");
            expect(block).toContain("x-ownership: record-author");
            expect(block).not.toContain("parameters/Idempotency");
            expect(block).not.toMatch(/'422'/);
        });

        it("should answer 201, 400, 401, 403, 404, 409, 429 and 500 with the documented shapes and codes", async () => {
            const recordId = await newRecord();
            const created = await createIntent(recordId, { description: ATTACH_DESC });
            conforms(created, INTENT, "post", 201);
            expect(Object.keys(expectSuccessEnvelope(created.body) as object).sort()).toEqual(["expiresAt", "fields", "maxBytes", "uploadId", "url"]);
            conforms(await createIntent(recordId, { description: "   " }), INTENT, "post", 400, "ValidationFailed");
            conforms(await createIntent(recordId, { description: 7 }), INTENT, "post", 400, "ValidationFailed");
            conforms(await createIntent(recordId, { description: null }), INTENT, "post", 400, "ValidationFailed");
            conforms(await createIntent(recordId, { description: "x".repeat(501) }), INTENT, "post", 400, "ValidationFailed");
            conforms(await createIntent(recordId, { description: "a\u0000b" }), INTENT, "post", 400, "ValidationFailed");
            conforms(await createIntent(recordId, { filename: "x.pdf" }), INTENT, "post", 400, "ValidationFailed");
            conforms(await createIntent(recordId, {}, "anonymous"), INTENT, "post", 401, "Unauthorized");
            conforms(await createIntent(recordId, {}, "patient"), INTENT, "post", 403, "Forbidden");
            conforms(await createIntent(recordId, {}, "admin"), INTENT, "post", 403, "Forbidden");
            conforms(await createIntent(999_999), INTENT, "post", 404, "NotFound");
            await seedAttachments(recordId, 20);
            conforms(await createIntent(recordId), INTENT, "post", 409, "AttachmentLimitReached");
            const failing = await newRecord();
            const spy = jest.spyOn(storage, "createUploadPolicy").mockRejectedValueOnce(new Error("synthetic storage outage"));
            try { conforms(await createIntent(failing), INTENT, "post", 500, "InternalError"); } finally { spy.mockRestore(); }
            // 20 attachment intents per hour per user: the 400s above fail validation after the limiter, so they spend budget too; keep calling until the limiter answers.
            let limited: Response | undefined;
            for (let index = 0; index < 25 && limited === undefined; index += 1) {
                const res = await createIntent(failing);
                if (res.status === 429) limited = res;
            }
            expect(limited).toBeDefined();
            conforms(limited as Response, INTENT, "post", 429, "RateLimited");
            expect(Number(limited?.headers["retry-after"])).toBeGreaterThanOrEqual(1);
            expectAllDeclared(INTENT, "post");
        });
    });

    describe("contract: completeRecordAttachmentUpload", () => {
        it("should declare the documented roles, ownership, audit action and no Idempotency-Key", () => {
            const block = contractOperationBlock(COMPLETE, "post");
            expect(block).toContain("x-roles: [doctor]");
            expect(block).toContain("x-ownership: record-author");
            expect(block).toContain("x-audit-actions: [attachment.added]");
            expect(block).not.toContain("parameters/Idempotency");
        });

        it("should answer 201, 200, 400, 401, 403, 404, 409 (both codes), 410, 429 and 500 with the documented shapes and codes", async () => {
            const recordId = await newRecord();
            const uploaded = await upload(recordId, { description: ATTACH_DESC });
            const first = await complete(recordId, uploaded.uploadId);
            conforms(first, COMPLETE, "post", 201);
            expectAttachment(expectSuccessEnvelope(first.body) as Record<string, unknown>);
            const replay = await complete(recordId, uploaded.uploadId);
            conforms(replay, COMPLETE, "post", 200);
            expect(replay.body.data).toEqual(first.body.data);

            const invalid = await upload(recordId, { bytes: FALSE_PDF });
            const rejected = await complete(recordId, invalid.uploadId);
            conforms(rejected, COMPLETE, "post", 400, "ValidationFailed");
            expect(rejected.body.error.details).toEqual([{ field: "file", issue: "stored file is invalid" }]);
            conforms(await complete(recordId, uploaded.uploadId, "anonymous"), COMPLETE, "post", 401, "Unauthorized");
            conforms(await complete(recordId, uploaded.uploadId, "patient"), COMPLETE, "post", 403, "Forbidden");
            conforms(await complete(recordId, uploaded.uploadId, "admin"), COMPLETE, "post", 403, "Forbidden");
            conforms(await complete(recordId, 999_999), COMPLETE, "post", 404, "NotFound");

            // Conflict: the intent was consumed without a result.
            const stale = await upload(recordId);
            await ownerDb("upload_intents").where({ id: stale.uploadId }).update({ consumed_at: new Date() });
            conforms(await complete(recordId, stale.uploadId), COMPLETE, "post", 409, "Conflict");
            // AttachmentLimitReached: a full record.
            const full = await newRecord();
            const blocked = await upload(full);
            await seedAttachments(full, 20);
            conforms(await complete(full, blocked.uploadId), COMPLETE, "post", 409, "AttachmentLimitReached");
            // 410: expired.
            const expired = await upload(recordId);
            await ownerDb("upload_intents").where({ id: expired.uploadId }).update({ expires_at: new Date(Date.now() - 1_000) });
            conforms(await complete(recordId, expired.uploadId), COMPLETE, "post", 410, "UploadIntentExpired");
            // 500: a storage failure leaves the intent open.
            const unlucky = await upload(recordId);
            storage.failNextCopy();
            conforms(await complete(recordId, unlucky.uploadId), COMPLETE, "post", 500, "InternalError");
            // 429: the write bucket (complete + delete, 20/min per user) is spent by removals of an unknown attachment.
            let limited: Response | undefined;
            for (let index = 0; index < 25 && limited === undefined; index += 1) {
                const res = await remove(recordId, 999_999);
                if (res.status === 429) limited = res;
            }
            expect(limited).toBeDefined();
            conforms(await complete(recordId, unlucky.uploadId), COMPLETE, "post", 429, "RateLimited");
            expect(Number(limited?.headers["retry-after"])).toBeGreaterThanOrEqual(1);
            expectAllDeclared(COMPLETE, "post");
        });

        it("should reject a request body on complete with 400", async () => {
            const recordId = await newRecord();
            const uploaded = await upload(recordId);
            const res = await complete(recordId, uploaded.uploadId, "doctor", { description: "late" });
            conforms(res, COMPLETE, "post", 400, "ValidationFailed");
            expect(await attachmentRows()).toEqual([]);
        });
    });

    describe("contract: getRecordAttachmentDownloadUrl", () => {
        it("should declare the documented roles, ownership, audit action and no Idempotency-Key", () => {
            const block = contractOperationBlock(DOWNLOAD, "post");
            expect(block).toContain("x-roles: [patient, doctor]");
            expect(block).toContain("x-ownership: consulted-patient-or-self");
            expect(block).toContain("x-audit-actions: [attachment.url_issued]");
            expect(block).not.toContain("parameters/Idempotency");
        });

        it("should answer 200, 400, 401, 403, 404, 429 and 500 with the documented shapes and codes", async () => {
            const recordId = await newRecord();
            const id = await addOk(recordId);
            const ok = await downloadUrl(recordId, id, "patient");
            conforms(ok, DOWNLOAD, "post", 200);
            const data = expectSuccessEnvelope(ok.body) as { url: string; expiresAt: string };
            expect(Object.keys(data).sort()).toEqual([...(inlineLists(schemaBlock("DownloadUrl"), "required")[0] ?? [])].sort());
            expect(() => new URL(data.url)).not.toThrow();
            expect(data.expiresAt).toMatch(ISO);
            conforms(await downloadUrl(recordId, id, "patient", { x: 1 }), DOWNLOAD, "post", 400, "ValidationFailed");
            conforms(await downloadUrl(recordId, id, "anonymous"), DOWNLOAD, "post", 401, "Unauthorized");
            conforms(await downloadUrl(recordId, id, "admin"), DOWNLOAD, "post", 403, "Forbidden");
            conforms(await downloadUrl(recordId, id, "otherPatient"), DOWNLOAD, "post", 404, "NotFound");
            conforms(await downloadUrl(recordId, 999_999, "patient"), DOWNLOAD, "post", 404, "NotFound");
            await withFailingAudit("attachment.url_issued", async () => { conforms(await downloadUrl(recordId, id, "patient"), DOWNLOAD, "post", 500, "InternalError"); });
            let limited: Response | undefined;
            for (let index = 0; index < 125 && limited === undefined; index += 1) {
                const res = await downloadUrl(recordId, 999_999, "patient");
                if (res.status === 429) limited = res;
            }
            expect(limited).toBeDefined();
            conforms(limited as Response, DOWNLOAD, "post", 429, "RateLimited");
            expect(Number(limited?.headers["retry-after"])).toBeGreaterThanOrEqual(1);
            expectAllDeclared(DOWNLOAD, "post");
        });
    });

    describe("contract: deleteRecordAttachment", () => {
        it("should declare the documented roles, ownership, audit action and no Idempotency-Key", () => {
            const block = contractOperationBlock(REMOVE, "delete");
            expect(block).toContain("x-roles: [doctor]");
            expect(block).toContain("x-ownership: record-author");
            expect(block).toContain("x-audit-actions: [attachment.removed]");
            expect(block).not.toContain("parameters/Idempotency");
        });

        it("should answer 204, 400, 401, 403, 404, 409 RecordLocked, 429 and 500 with the documented shapes and codes", async () => {
            const recordId = await newRecord();
            const [first, second, third] = [await addOk(recordId), await addOk(recordId), await addOk(recordId)];
            const noContent = await remove(recordId, first);
            conforms(noContent, REMOVE, "delete", 204);
            expect(noContent.text).toBe("");
            conforms(await remove(recordId, second, "doctor", { x: 1 }), REMOVE, "delete", 400, "ValidationFailed");
            conforms(await remove(recordId, second, "anonymous"), REMOVE, "delete", 401, "Unauthorized");
            conforms(await remove(recordId, second, "patient"), REMOVE, "delete", 403, "Forbidden");
            conforms(await remove(recordId, second, "admin"), REMOVE, "delete", 403, "Forbidden");
            conforms(await remove(recordId, 999_999), REMOVE, "delete", 404, "NotFound");
            conforms(await remove(recordId, first), REMOVE, "delete", 404, "NotFound");
            await withFailingAudit("attachment.removed", async () => { conforms(await remove(recordId, second), REMOVE, "delete", 500, "InternalError"); });
            expect((await attachmentRows()).find((row) => row.id === second)?.deleted_at).toBeNull();
            await lockNow(recordId);
            conforms(await remove(recordId, third), REMOVE, "delete", 409, "RecordLocked");
            let limited: Response | undefined;
            for (let index = 0; index < 25 && limited === undefined; index += 1) {
                const res = await remove(recordId, 999_999);
                if (res.status === 429) limited = res;
            }
            expect(limited).toBeDefined();
            conforms(limited as Response, REMOVE, "delete", 429, "RateLimited");
            expect(Number(limited?.headers["retry-after"])).toBeGreaterThanOrEqual(1);
            expectAllDeclared(REMOVE, "delete");
        });
    });

    it("should declare no attachment operation anywhere without the AttachmentLimitReached code in the error enum", () => {
        expect(schemaBlock("ErrorCode")).toContain("AttachmentLimitReached");
        expect(properties("RecordAttachment")).not.toContain("downloadUrl");
        expect(properties("MedicalRecord")).toContain("attachments");
    });

    it("should leave one attachment.added audit row per completed attachment and none for a failed or rejected complete", async () => {
        const recordId = await newRecord();
        await addOk(recordId);
        await add(recordId, { bytes: FALSE_PDF });
        const rows = await attachmentAudits();
        expect(rows.map((row) => row.action)).toEqual(["attachment.added"]);
    });
});
