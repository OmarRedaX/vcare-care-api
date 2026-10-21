import "reflect-metadata";
import type { Knex } from "knex";
import { RecordAttachmentLinksService } from "../../../../src/app/record-attachments/service/record-attachment-links.service";
import { ATTACH_DESC, stubConn, summaryRow } from "./record-attachments.fixtures";

describe("RecordAttachmentLinksService.listByRecordIds", () => {
    it("should return an empty map and issue no query when the input is empty", async () => {
        const db = stubConn([]);
        const result = await new RecordAttachmentLinksService(db.conn).listByRecordIds([]);
        expect(result.size).toBe(0);
        expect(db.tables).toEqual([]);
        expect(db.calls).toEqual([]);
    });

    it("should issue exactly one query for the whole page with a single = ANY predicate on live rows", async () => {
        const db = stubConn([]);
        await new RecordAttachmentLinksService(db.conn).listByRecordIds([9, 10, 11]);
        expect(db.tables).toEqual(["record_attachments"]);
        expect(db.called("whereRaw")).toEqual([["whereRaw", ["medical_record_id = ANY(?::bigint[])", [[9, 10, 11]]]]]);
        expect(db.called("whereNull")[0]?.[1]).toEqual(["deleted_at"]);
    });

    it("should group the rows by record id keeping the order read (id order, oldest first) and give a record without attachments no entry", async () => {
        const db = stubConn([summaryRow({ id: 1, medical_record_id: 9 }), summaryRow({ id: 2, medical_record_id: 10 }), summaryRow({ id: 3, medical_record_id: 9 }), summaryRow({ id: 4, medical_record_id: 9 })]);
        const result = await new RecordAttachmentLinksService(db.conn).listByRecordIds([9, 10, 11]);
        expect([...result.keys()]).toEqual([9, 10]);
        expect(result.get(9)?.map((item) => item.id)).toEqual([1, 3, 4]);
        expect(result.get(10)?.map((item) => item.id)).toEqual([2]);
        expect(result.has(11)).toBe(false);
    });

    it("should order the query by id (append order) so the grouped lists are oldest first", async () => {
        const db = stubConn([]);
        await new RecordAttachmentLinksService(db.conn).listByRecordIds([9]);
        expect(db.called("orderByRaw")[0]?.[1]).toEqual(["id"]);
    });

    it("should map each row to the summary members only", async () => {
        const db = stubConn([summaryRow({ id: 7, file_type: "image/png", size_bytes: 555, description: null })]);
        const summary = (await new RecordAttachmentLinksService(db.conn).listByRecordIds([9])).get(9)?.[0];
        expect(summary).toEqual({ id: 7, recordId: 9, fileType: "image/png", sizeBytes: 555, attachmentDescription: null, createdAt: new Date(Date.parse("2030-01-01T10:00:00Z")) });
        expect(Object.keys(summary ?? {}).sort()).toEqual(["attachmentDescription", "createdAt", "fileType", "id", "recordId", "sizeBytes"]);
    });

    it("should select the six summary columns and never object_key, uploaded_by_user_id or *", async () => {
        const db = stubConn([]);
        await new RecordAttachmentLinksService(db.conn).listByRecordIds([9]);
        const selected = db.called("select")[0]?.[1][0] as string[];
        expect(selected).toEqual(["id", "medical_record_id", "file_type", "size_bytes", "description", "created_at"]);
        const shape = JSON.stringify(db.calls);
        expect(shape).not.toContain("object_key");
        expect(shape).not.toContain("uploaded_by_user_id");
        expect(shape).not.toContain('"*"');
    });

    it("should not expose the object key or uploader even when the driver returned them", async () => {
        const db = stubConn([summaryRow({ object_key: "record-attachments/leak", uploaded_by_user_id: 202 })]);
        const summary = (await new RecordAttachmentLinksService(db.conn).listByRecordIds([9])).get(9)?.[0];
        expect(JSON.stringify(summary)).not.toContain("leak");
        expect(summary).not.toHaveProperty("objectKey");
        expect(summary).not.toHaveProperty("uploadedByUserId");
    });

    it("should use the connection it is given (a transaction) in place of its own pool", async () => {
        const pool = stubConn([]);
        const tx = stubConn([summaryRow()]);
        const result = await new RecordAttachmentLinksService(pool.conn).listByRecordIds([9], tx.conn);
        expect(pool.tables).toEqual([]);
        expect(tx.tables).toEqual(["record_attachments"]);
        expect(result.get(9)?.[0]?.attachmentDescription).toBe(ATTACH_DESC);
    });

    it("should let a database error propagate (no degrade for clinical metadata)", async () => {
        const failing = (() => { throw new Error("connection reset"); }) as unknown as Knex;
        await expect(new RecordAttachmentLinksService(failing).listByRecordIds([9])).rejects.toThrow("connection reset");
    });
});
