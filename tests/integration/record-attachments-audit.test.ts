import type { Response } from "supertest";
import { StorageError } from "../../src/lib/storage/storage-error";
import { expectErrorEnvelope, expectPaginationMeta } from "../helpers/contract";
import { ADMIN, DOCTOR, PATIENT } from "../helpers/consultations-harness";
import { ownerDb } from "../helpers/db";
import {
    ATTACH_DESC, attachmentAudits, attachmentRows, storageCalls, useAttachmentsHarness,
} from "../helpers/record-attachments-fixtures";
import { getRecord, lockNow, provisionOtherDoctor, timeline, withFailingAudit } from "../helpers/records-fixtures";

jest.setTimeout(120_000);

describe("record attachments audit (integration: real routes, Postgres, Redis; storage, Identity and video faked)", () => {
    const { h, storage, newRecord, createIntent, complete, downloadUrl, remove, upload, add, addOk, send } = useAttachmentsHarness("record-attachments-audit");

    // ───────────────────────────────────────────── the three actions
    it("should write attachment.added in the complete transaction with the documented entity, request id and flat clinical-free metadata", async () => {
        const recordId = await newRecord();
        const uploaded = await upload(recordId, { description: ATTACH_DESC });
        const res = await complete(recordId, uploaded.uploadId);
        expect(res.status).toBe(201);
        const rows = await attachmentAudits();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            actor_user_id: DOCTOR, actor_role: "doctor", action: "attachment.added", entity_type: "record_attachment", entity_id: res.body.data.id, request_id: res.headers["x-request-id"],
            metadata: { recordId, fileType: "application/pdf", sizeBytes: res.body.data.sizeBytes, afterLock: false },
        });
        expect(Object.keys(rows[0]?.metadata).sort()).toEqual(["afterLock", "fileType", "recordId", "sizeBytes"]);
    });

    it("should write attachment.removed in the delete transaction with the documented entity, request id and the record id only", async () => {
        const recordId = await newRecord();
        const id = await addOk(recordId, { description: ATTACH_DESC });
        const res = await remove(recordId, id);
        expect(res.status).toBe(204);
        const rows = (await attachmentAudits()).filter((row) => row.action === "attachment.removed");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ actor_user_id: DOCTOR, actor_role: "doctor", entity_type: "record_attachment", entity_id: id, request_id: res.headers["x-request-id"], metadata: { recordId } });
        expect(Object.keys(rows[0]?.metadata)).toEqual(["recordId"]);
    });

    it("should write exactly one attachment.url_issued row per issued URL, with the viewer role and whether the viewer is the author", async () => {
        await provisionOtherDoctor(h);
        const recordId = await newRecord();
        const id = await addOk(recordId);
        const calls: Array<[Parameters<typeof downloadUrl>[2], number, string, boolean]> = [["patient", PATIENT, "patient", false], ["doctor", DOCTOR, "doctor", true], ["otherDoctor", 204, "doctor", false]];
        for (const [caller, userId, role, isAuthor] of calls) {
            const before = (await attachmentAudits()).filter((row) => row.action === "attachment.url_issued").length;
            const res = await downloadUrl(recordId, id, caller);
            expect([caller, res.status]).toEqual([caller, 200]);
            const issued = (await attachmentAudits()).filter((row) => row.action === "attachment.url_issued");
            expect([caller, issued.length]).toEqual([caller, before + 1]);
            expect(issued.at(-1)).toMatchObject({
                actor_user_id: userId, actor_role: role, entity_type: "record_attachment", entity_id: id, request_id: res.headers["x-request-id"],
                metadata: { recordId, viewerRole: role, viewerIsAuthor: isAuthor },
            });
            expect(Object.keys(issued.at(-1)?.metadata).sort()).toEqual(["recordId", "viewerIsAuthor", "viewerRole"]);
        }
        // Repeated calls by the same viewer: one row each, never deduplicated.
        for (let index = 0; index < 3; index += 1) expect((await downloadUrl(recordId, id, "patient")).status).toBe(200);
        expect((await attachmentAudits()).filter((row) => row.action === "attachment.url_issued")).toHaveLength(6);
        expect(storageCalls(storage, "presignDownload")).toHaveLength(6);
    });

    it("should commit the url_issued audit row before the URL is signed, visible to another connection at presign time", async () => {
        const recordId = await newRecord();
        const id = await addOk(recordId);
        let visibleAtPresign = -1;
        const spy = jest.spyOn(storage, "presignDownload").mockImplementationOnce(async () => {
            visibleAtPresign = Number((await ownerDb("audit_logs").where({ action: "attachment.url_issued" }).count({ n: "*" }))[0]?.n);
            return { url: "https://storage.test/download", expiresAt: new Date(Date.now() + 60_000).toISOString() };
        });
        try {
            expect((await downloadUrl(recordId, id, "patient")).status).toBe(200);
        } finally { spy.mockRestore(); }
        expect(visibleAtPresign).toBe(1);
    });

    it("should keep the audit row and answer 500 without a URL when presigning fails after the audit committed", async () => {
        const recordId = await newRecord();
        const id = await addOk(recordId);
        const spy = jest.spyOn(storage, "presignDownload").mockRejectedValueOnce(new StorageError("presign"));
        let res: Response;
        try { res = await downloadUrl(recordId, id, "patient"); } finally { spy.mockRestore(); }
        expect(res.status).toBe(500);
        expectErrorEnvelope(res.body, "InternalError");
        expect(JSON.stringify(res.body)).not.toMatch(/https?:\/\//);
        expect((await attachmentAudits()).filter((row) => row.action === "attachment.url_issued")).toHaveLength(1);
    });

    // ───────────────────────────────────────────── fail closed
    it("should answer 500 with no URL, no presign call and no audit row when the url_issued audit insert fails", async () => {
        const recordId = await newRecord();
        const id = await addOk(recordId);
        storage.calls.length = 0;
        await withFailingAudit("attachment.url_issued", async () => {
            const res = await downloadUrl(recordId, id, "patient");
            expect(res.status).toBe(500);
            expectErrorEnvelope(res.body, "InternalError");
            expect(JSON.stringify(res.body)).not.toMatch(/https?:\/\/|storage\.test|record-attachments\//);
        });
        expect(storageCalls(storage, "presignDownload")).toEqual([]);
        expect((await attachmentAudits()).filter((row) => row.action === "attachment.url_issued")).toEqual([]);
        // Healthy again: the same call now succeeds and writes its row.
        expect((await downloadUrl(recordId, id, "patient")).status).toBe(200);
        expect((await attachmentAudits()).filter((row) => row.action === "attachment.url_issued")).toHaveLength(1);
    });

    it("should leave the attachment live and write no row when the removed audit insert fails", async () => {
        const recordId = await newRecord();
        const id = await addOk(recordId);
        await withFailingAudit("attachment.removed", async () => {
            expect((await remove(recordId, id)).status).toBe(500);
        });
        expect((await attachmentRows())[0]?.deleted_at).toBeNull();
        expect((await attachmentAudits()).filter((row) => row.action === "attachment.removed")).toEqual([]);
        expect((await remove(recordId, id)).status).toBe(204);
    });

    it("should write no audit row for any refused attachment request (401, 403, 404, 400, 409, 410, 429)", async () => {
        const recordId = await newRecord();
        const id = await addOk(recordId);
        const baseline = (await attachmentAudits()).length;
        const refused: Array<[string, Response]> = [
            ["401 download", await downloadUrl(recordId, id, "anonymous")], ["401 remove", await remove(recordId, id, "anonymous")],
            ["403 admin download", await downloadUrl(recordId, id, "admin")], ["403 patient remove", await remove(recordId, id, "patient")],
            ["403 admin complete", await complete(recordId, 1, "admin")], ["403 patient intent", await createIntent(recordId, {}, "patient")],
            ["404 other patient download", await downloadUrl(recordId, id, "otherPatient")], ["404 absent download", await downloadUrl(recordId, 999_999, "patient")],
            ["404 absent remove", await remove(recordId, 999_999)], ["404 absent record", await downloadUrl(999_999, id, "patient")],
            ["400 body on download", await downloadUrl(recordId, id, "patient", { x: 1 })], ["400 body on remove", await remove(recordId, id, "doctor", { x: 1 })],
            ["400 invalid file", await add(recordId, { bytes: Buffer.from("fake PDF bytes") })],
        ];
        const expired = await upload(recordId);
        await ownerDb("upload_intents").where({ id: expired.uploadId }).update({ expires_at: new Date(Date.now() - 1_000) });
        refused.push(["410 expired", await complete(recordId, expired.uploadId)]);
        await lockNow(recordId);
        refused.push(["409 locked", await remove(recordId, id)]);
        for (const [label, res] of refused) expect([label, res.status >= 400]).toEqual([label, true]);
        expect((await attachmentAudits()).length).toBe(baseline);
    });

    it("should write no audit row for a 429 on download-url and keep the count equal to the issued URLs", async () => {
        const recordId = await newRecord();
        const id = await addOk(recordId);
        let issued = 0;
        let limited: Response | undefined;
        for (let index = 0; index < 125 && limited === undefined; index += 1) {
            const res = await downloadUrl(recordId, id, "patient");
            if (res.status === 429) limited = res; else if (res.status === 200) issued += 1;
        }
        expect(limited).toBeDefined();
        expect(issued).toBe(120);
        expect((await attachmentAudits()).filter((row) => row.action === "attachment.url_issued")).toHaveLength(issued);
    });

    // ───────────────────────────────────────────── reads of the record add no attachment audit row
    it("should write only the existing record.read and patient_records.listed rows, with no attachment key, when a record with attachments is read or listed", async () => {
        const recordId = await newRecord();
        await addOk(recordId, { description: ATTACH_DESC });
        const last = Number((await ownerDb("audit_logs").max({ id: "id" }))[0]?.id ?? 0);
        expect((await getRecord(h, recordId, "patient")).status).toBe(200);
        expect((await timeline(h, PATIENT, "patient")).status).toBe(200);
        const rows = await ownerDb("audit_logs").select("action", "metadata").where("id", ">", last).orderBy("id");
        expect(rows.map((row: { action: string }) => row.action)).toEqual(["record.read", "patient_records.listed"]);
        for (const row of rows as Array<{ metadata: Record<string, unknown> }>) expect(JSON.stringify(row.metadata)).not.toMatch(/attachment/i);
    });

    // ───────────────────────────────────────────── the admin audit read
    describe("GET /api/audit-logs as an admin", () => {
        it("should list the attachment rows with the documented entity type, id and metadata and without any clinical content, key or URL", async () => {
            await provisionOtherDoctor(h);
            const recordId = await newRecord();
            const id = await addOk(recordId, { description: ATTACH_DESC });
            expect((await downloadUrl(recordId, id, "patient")).status).toBe(200);
            expect((await downloadUrl(recordId, id, "otherDoctor")).status).toBe(200);
            expect((await remove(recordId, id)).status).toBe(204);

            const res = await send("get", `/api/audit-logs?entityType=record_attachment&entityId=${id}&limit=100`, "admin");
            expect(res.status).toBe(200);
            expectPaginationMeta(res.body.meta);
            const entries = res.body.data as Array<{ actorUserId: number; actorRole: string; action: string; entityType: string; entityId: number; requestId: string; metadata: Record<string, unknown> }>;
            expect(entries.map((entry) => entry.action).sort()).toEqual(["attachment.added", "attachment.removed", "attachment.url_issued", "attachment.url_issued"]);
            expect(entries.every((entry) => entry.entityType === "record_attachment" && entry.entityId === id)).toBe(true);
            expect(entries.find((entry) => entry.action === "attachment.added")).toMatchObject({ actorUserId: DOCTOR, actorRole: "doctor", metadata: { recordId, fileType: "application/pdf", afterLock: false } });
            expect(entries.filter((entry) => entry.action === "attachment.url_issued").map((entry) => entry.metadata.viewerRole).sort()).toEqual(["doctor", "patient"]);
            const text = JSON.stringify(res.body);
            for (const forbidden of [ATTACH_DESC, "record-attachments/", "quarantine/", "http://", "https://", "objectKey", "object_key", "SYNTHETIC-CHIEF"]) expect([forbidden, text.includes(forbidden)]).toEqual([forbidden, false]);

            const byAction = await send("get", "/api/audit-logs?action=attachment.url_issued", "admin");
            expect(byAction.status).toBe(200);
            expect((byAction.body.data as unknown[]).length).toBe(2);
        });

        it("should keep every audit row free of the description, object keys, quarantine keys and URLs", async () => {
            const recordId = await newRecord();
            const first = await addOk(recordId, { description: ATTACH_DESC });
            await downloadUrl(recordId, first, "patient");
            await remove(recordId, first);
            const dump = JSON.stringify(await ownerDb("audit_logs").select("action", "entity_type", "metadata").orderBy("id"));
            for (const forbidden of [ATTACH_DESC, "record-attachments/", "quarantine/", "https://", "storage.test"]) expect([forbidden, dump.includes(forbidden)]).toEqual([forbidden, false]);
        });

        it("should answer an admin's attachment audit read with 200 while every attachment route stays 403 for the same admin", async () => {
            const recordId = await newRecord();
            const id = await addOk(recordId);
            expect((await send("get", "/api/audit-logs", "admin")).status).toBe(200);
            expect((await downloadUrl(recordId, id, "admin")).status).toBe(403);
            expect((await send("get", "/api/audit-logs", "doctor")).status).toBe(403);
            expect((await send("get", "/api/audit-logs", "patient")).status).toBe(403);
            expect(ADMIN).toBe(303);
        });
    });
});
