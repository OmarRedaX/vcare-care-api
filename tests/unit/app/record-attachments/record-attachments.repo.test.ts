import "reflect-metadata";
import knex from "knex";
import {
    countLiveByRecord, findLive, findLiveById, insertAttachment, listByRecordIdsQuery, RECORD_ATTACHMENT_COLUMNS, RECORD_ATTACHMENT_SUMMARY_COLUMNS, softDelete,
} from "../../../../src/app/record-attachments/repository/record-attachments.repo";
import { ATTACH_DESC, OBJECT_KEY, stubConn } from "./record-attachments.fixtures";

const dry = knex({ client: "pg" });
afterAll(async () => { await dry.destroy(); });

const FULL_ROW = { id: 41, medical_record_id: 9, uploaded_by_user_id: 202, object_key: OBJECT_KEY, file_type: "application/pdf", size_bytes: 2048, description: ATTACH_DESC, created_at: new Date(0), deleted_at: null };
const NEW_ATTACHMENT = { recordId: 9, uploadedByUserId: 202, objectKey: OBJECT_KEY, fileType: "application/pdf", sizeBytes: 2048, attachmentDescription: ATTACH_DESC };

describe("record-attachments.repo", () => {
    it("should insert exactly the six granted columns, never id, created_at or deleted_at, and map the returned row", async () => {
        const insert = stubConn([FULL_ROW]);
        const entity = await insertAttachment(NEW_ATTACHMENT, insert.conn);
        const [row] = insert.called("insert")[0]?.[1] ?? [];
        expect(Object.keys(row as object).sort()).toEqual(["description", "file_type", "medical_record_id", "object_key", "size_bytes", "uploaded_by_user_id"]);
        expect(row).toEqual({ medical_record_id: 9, uploaded_by_user_id: 202, object_key: OBJECT_KEY, file_type: "application/pdf", size_bytes: 2048, description: ATTACH_DESC });
        expect(insert.called("returning")[0]?.[1][0]).toEqual([...RECORD_ATTACHMENT_COLUMNS]);
        expect(entity).toMatchObject({ id: 41, recordId: 9, uploadedByUserId: 202, objectKey: OBJECT_KEY, fileType: "application/pdf", sizeBytes: 2048, attachmentDescription: ATTACH_DESC, deletedAt: null });
    });

    it("should insert a null description as null", async () => {
        const insert = stubConn([{ ...FULL_ROW, description: null }]);
        await insertAttachment({ ...NEW_ATTACHMENT, attachmentDescription: null }, insert.conn);
        expect((insert.called("insert")[0]?.[1][0] as { description: unknown }).description).toBeNull();
    });

    it("should fail loudly rather than return undefined when the insert returns no row", async () => {
        await expect(insertAttachment(NEW_ATTACHMENT, stubConn([]).conn)).rejects.toThrow("record_attachment_insert_returned_no_row");
    });

    it("should select explicit columns on live rows and scope findLive to the record, never select *", async () => {
        const live = stubConn(FULL_ROW);
        expect((await findLive(41, 9, live.conn))?.id).toBe(41);
        expect(live.tables).toEqual(["record_attachments"]);
        expect(live.called("select")[0]?.[1][0]).toEqual([...RECORD_ATTACHMENT_COLUMNS]);
        expect(live.called("where").map(([, args]) => args)).toEqual([["id", 41], ["medical_record_id", 9]]);
        expect(live.called("whereNull")).toEqual([["whereNull", ["deleted_at"]]]);
        expect(JSON.stringify(live.calls)).not.toContain('"*"');
        expect(await findLive(41, 9, stubConn(undefined).conn)).toBeUndefined();
    });

    it("should look the replay row up by primary key on live rows only", async () => {
        const byId = stubConn(FULL_ROW);
        expect((await findLiveById(41, byId.conn))?.id).toBe(41);
        expect(byId.called("where").map(([, args]) => args)).toEqual([["id", 41]]);
        expect(byId.called("whereNull")).toEqual([["whereNull", ["deleted_at"]]]);
        expect(await findLiveById(41, stubConn(undefined).conn)).toBeUndefined();
    });

    it("should count live rows of one record and treat no row as zero", async () => {
        const count = stubConn({ count: "19" });
        expect(await countLiveByRecord(9, count.conn)).toBe(19);
        expect(count.called("where")[0]?.[1]).toEqual(["medical_record_id", 9]);
        expect(count.called("whereNull")[0]?.[1]).toEqual(["deleted_at"]);
        expect(await countLiveByRecord(9, stubConn(undefined).conn)).toBe(0);
        expect(await countLiveByRecord(9, stubConn({ count: 3 }).conn)).toBe(3);
    });

    it("should soft delete by setting only deleted_at from the database clock on a live row and return the affected count", async () => {
        const update = stubConn(1);
        expect(await softDelete(41, update.conn)).toBe(1);
        expect(update.called("update")[0]?.[1]).toEqual([{ deleted_at: { now: true } }]);
        expect(update.called("where")[0]?.[1]).toEqual(["id", 41]);
        expect(update.called("whereNull")[0]?.[1]).toEqual(["deleted_at"]);
        expect(await softDelete(41, stubConn(0).conn)).toBe(0);
    });

    it("should build the list query as one = ANY on live rows ordered by id with the six summary columns only", () => {
        const { sql, bindings } = listByRecordIdsQuery([9, 10, 11], dry).toSQL().toNative();
        expect(sql).toContain("medical_record_id = ANY($1::bigint[])");
        expect(sql).toContain('"deleted_at" is null');
        expect(sql).toContain("order by id");
        expect(sql).not.toMatch(/select \*/i);
        expect(sql).not.toContain("object_key");
        expect(sql).not.toContain("uploaded_by_user_id");
        expect(bindings).toEqual([[9, 10, 11]]);
        for (const column of RECORD_ATTACHMENT_SUMMARY_COLUMNS) expect(sql).toContain(`"${column}"`);
    });

    it("should keep the summary column list free of the key and the uploader", () => {
        expect([...RECORD_ATTACHMENT_SUMMARY_COLUMNS]).toEqual(["id", "medical_record_id", "file_type", "size_bytes", "description", "created_at"]);
    });
});
