import "reflect-metadata";
import knex from "knex";
import type { Knex } from "knex";
import { insertAmendment, listByRecordIds, listByRecordIdsQuery } from "../../../../src/app/records/repository/medical-record-amendments.repo";
import {
    findAccessRow, findById, findByIdForNoKeyUpdate, findLiveIdByConsultationId, insertRecord, isFollowUpTarget, listConsultationIdsWithRecord, listTimelineQuery,
    MEDICAL_RECORD_COLUMNS, updateRecordFields,
} from "../../../../src/app/records/repository/medical-records.repo";
import { CHIEF, NOTES, PLAN, REASON } from "./records.fixtures";

const dry = knex({ client: "pg" });
afterAll(async () => { await dry.destroy(); });

type Call = [string, unknown[]];
/** A chainable query-builder stand-in: records every builder call and resolves, when awaited, to `result`. */
function stub(result: unknown) {
    const calls: Call[] = [];
    const tables: string[] = [];
    const builder: unknown = new Proxy(() => undefined, {
        get(_target, prop) {
            if (prop === "then") return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
            return (...args: unknown[]) => { calls.push([String(prop), args]); return builder; };
        },
    });
    const conn = Object.assign((table: string) => { tables.push(table); return builder; }, { raw: (sql: string) => ({ raw: sql }), fn: { now: () => ({ now: true }) } });
    return { conn: conn as unknown as Knex.Transaction, calls, tables, called: (name: string) => calls.filter(([method]) => method === name) };
}

const ROW = { id: 9, consultation_id: 7, patient_user_id: 101, doctor_user_id: 202, chief_complaint: CHIEF, examination_notes: null, diagnosis_text: null, diagnosis_code: null,
    treatment_plan: null, follow_up_in_days: null, locked_at: new Date(0), is_locked: false, created_at: new Date(0), updated_at: new Date(0) };

describe("medical-records.repo", () => {
    it("should select explicit columns plus the database-clock lock flag on every read and never select *", async () => {
        const reads = [stub(ROW), stub(ROW), stub(undefined)];
        await findById(9, reads[0]?.conn);
        await findByIdForNoKeyUpdate(9, reads[1]?.conn as Knex.Transaction);
        await findLiveIdByConsultationId(7, reads[2]?.conn);
        for (const read of reads.slice(0, 2)) {
            const list = (read.called("select")[0]?.[1][0] ?? []) as Array<string | { raw: string }>;
            expect(list.filter((entry): entry is string => typeof entry === "string")).toEqual([...MEDICAL_RECORD_COLUMNS]);
            expect(list.find((entry) => typeof entry !== "string")).toEqual({ raw: "(locked_at <= NOW()) AS is_locked" });
            expect(read.called("whereNull")).toEqual([["whereNull", ["deleted_at"]]]);
            expect(JSON.stringify(read.calls)).not.toContain("*");
        }
        expect(reads[2]?.called("whereNull")).toEqual([["whereNull", ["deleted_at"]]]);
    });

    it("should lock the row FOR NO KEY UPDATE only in the locked read", async () => {
        const plain = stub(ROW); const locking = stub(ROW);
        await findById(9, plain.conn);
        await findByIdForNoKeyUpdate(9, locking.conn);
        expect(plain.called("forNoKeyUpdate")).toHaveLength(0);
        expect(plain.called("forUpdate")).toHaveLength(0);
        expect(locking.called("forNoKeyUpdate")).toHaveLength(1);
        expect(locking.called("forUpdate")).toHaveLength(0);
    });

    it("should insert with locked_at computed in SQL from database time and never send created_at, updated_at or an id", async () => {
        const insert = stub([ROW]);
        await insertRecord({ consultationId: 7, patientUserId: 101, doctorUserId: 202, input: { chiefComplaint: CHIEF, examinationNotes: NOTES, followUpInDays: 4 } }, insert.conn);
        const [row] = insert.called("insert")[0]?.[1] ?? [];
        expect(row).toEqual({ consultation_id: 7, patient_user_id: 101, doctor_user_id: 202, chief_complaint: CHIEF, examination_notes: NOTES, diagnosis_text: null,
            diagnosis_code: null, treatment_plan: null, follow_up_in_days: 4, locked_at: { raw: "NOW() + interval '24 hours'" } });
        expect(Object.keys(row as object)).not.toEqual(expect.arrayContaining(["created_at"]));
        expect(Object.keys(row as object)).not.toEqual(expect.arrayContaining(["id"]));
    });

    it("should update only the changed columns plus updated_at and filter on the live row", async () => {
        const update = stub([ROW]);
        await updateRecordFields(9, { treatment_plan: PLAN }, update.conn);
        expect(update.called("update")[0]?.[1]).toEqual([{ treatment_plan: PLAN, updated_at: { now: true } }]);
        expect(update.called("where")[0]?.[1]).toEqual(["id", 9]);
        expect(update.called("whereNull")[0]?.[1]).toEqual(["deleted_at"]);
    });

    it("should fail loudly rather than return undefined when an insert or an update returns no row", async () => {
        await expect(insertRecord({ consultationId: 7, patientUserId: 101, doctorUserId: 202, input: { chiefComplaint: CHIEF } }, stub([]).conn)).rejects.toThrow("medical_record_insert_returned_no_row");
        await expect(updateRecordFields(9, { treatment_plan: PLAN }, stub([]).conn)).rejects.toThrow("medical_record_update_returned_no_row");
    });

    it("should read the access row and the follow-up target without clinical columns", async () => {
        const access = stub({ id: 9, patient_user_id: 101, doctor_user_id: 202 });
        expect(await findAccessRow(9, access.conn)).toEqual({ id: 9, patientUserId: 101, doctorUserId: 202 });
        expect(access.called("select")[0]?.[1]).toEqual(["id", "patient_user_id", "doctor_user_id"]);
        const target = stub({ id: 9 });
        expect(await isFollowUpTarget(9, 101, 202, target.conn)).toBe(true);
        expect(target.called("where").map(([, args]) => args)).toEqual([["id", 9], ["patient_user_id", 101], ["doctor_user_id", 202]]);
        expect(target.called("whereNull")[0]?.[1]).toEqual(["deleted_at"]);
        expect(await isFollowUpTarget(9, 101, 202, stub(undefined).conn)).toBe(false);
        expect(await findAccessRow(9, stub(undefined).conn)).toBeUndefined();
    });

    it("should not query for an empty hasRecord batch and use one = ANY query otherwise", async () => {
        const none = stub([]);
        expect(await listConsultationIdsWithRecord([], none.conn)).toEqual([]);
        expect(none.tables).toEqual([]);
        const some = stub([{ consultation_id: 3 }, { consultation_id: 8 }]);
        expect(await listConsultationIdsWithRecord([3, 5, 8], some.conn)).toEqual([3, 8]);
        expect(some.tables).toEqual(["medical_records"]);
        expect(some.called("whereRaw")[0]?.[1]).toEqual(["consultation_id = ANY(?::bigint[])", [[3, 5, 8]]]);
        expect(some.called("whereNull")[0]?.[1]).toEqual(["deleted_at"]);
    });

    it("should build the timeline page newest first on the keyset (created_at, id) with limit fetch, no clinical text beyond the record columns and no select *", () => {
        const first = listTimelineQuery({ patientUserId: 101, after: null, fetch: 21 }, dry).toSQL().toNative();
        expect(first.sql).toContain('"patient_user_id" = $2');
        expect(first.sql).toContain('"deleted_at" is null');
        expect(first.sql).toContain("order by created_at DESC, id DESC");
        expect(first.sql).toMatch(/limit \$3$/);
        expect(first.sql).toContain("(locked_at <= NOW()) AS is_locked");
        expect(first.sql).not.toMatch(/select \*/i);
        expect(first.sql).not.toContain("(created_at, id) <");
        expect(first.bindings.slice(1)).toEqual([101, 21]);
        const next = listTimelineQuery({ patientUserId: 101, after: { sortValue: "2030-01-01T09:00:00.123456Z", id: 77 }, fetch: 6 }, dry).toSQL().toNative();
        expect(next.sql).toContain("(created_at, id) < ($3::timestamptz, $4::bigint)");
        expect(next.bindings.slice(1)).toEqual([101, "2030-01-01T09:00:00.123456Z", 77, 6]);
    });
});

describe("medical-record-amendments.repo", () => {
    it("should insert exactly the nine granted columns, null for what was not amended, and never id or created_at", async () => {
        const insert = stub([{ id: 31, medical_record_id: 9, author_user_id: 202, chief_complaint: null, examination_notes: null, diagnosis_text: null, diagnosis_code: null,
            treatment_plan: PLAN, follow_up_in_days: null, reason: REASON, created_at: new Date(0) }]);
        const result = await insertAmendment({ recordId: 9, authorUserId: 202, changes: { treatmentPlan: PLAN }, reason: REASON }, insert.conn);
        const [row] = insert.called("insert")[0]?.[1] ?? [];
        expect(Object.keys(row as object).sort()).toEqual(["author_user_id", "chief_complaint", "diagnosis_code", "diagnosis_text", "examination_notes", "follow_up_in_days",
            "medical_record_id", "reason", "treatment_plan"]);
        expect(row).toEqual({ medical_record_id: 9, author_user_id: 202, chief_complaint: null, examination_notes: null, diagnosis_text: null, diagnosis_code: null,
            treatment_plan: PLAN, follow_up_in_days: null, reason: REASON });
        expect(result).toMatchObject({ id: 31, recordId: 9, authorUserId: 202, treatmentPlan: PLAN, reason: REASON, diagnosisText: null });
    });

    it("should load the amendments of many records with one = ANY query ordered oldest first", () => {
        const { sql, bindings } = listByRecordIdsQuery([9, 10, 11], dry).toSQL().toNative();
        expect(sql).toContain("medical_record_id = ANY($1::bigint[])");
        expect(sql).toContain("order by created_at, id");
        expect(sql).not.toMatch(/select \*/i);
        expect(bindings).toEqual([[9, 10, 11]]);
    });

    it("should group the rows by record id in the order read and issue one table access for the whole batch", async () => {
        const rows = [
            { id: 1, medical_record_id: 9, author_user_id: 202, chief_complaint: null, examination_notes: null, diagnosis_text: null, diagnosis_code: null, treatment_plan: null, follow_up_in_days: 5, reason: REASON, created_at: new Date(1) },
            { id: 2, medical_record_id: 10, author_user_id: 202, chief_complaint: null, examination_notes: null, diagnosis_text: null, diagnosis_code: null, treatment_plan: null, follow_up_in_days: 6, reason: REASON, created_at: new Date(2) },
            { id: 3, medical_record_id: 9, author_user_id: 202, chief_complaint: null, examination_notes: null, diagnosis_text: null, diagnosis_code: null, treatment_plan: null, follow_up_in_days: 7, reason: REASON, created_at: new Date(3) },
        ];
        const conn = stub(rows);
        const grouped = await listByRecordIds([9, 10, 11], conn.conn);
        expect(conn.tables).toEqual(["medical_record_amendments"]);
        expect([...grouped.keys()]).toEqual([9, 10]);
        expect(grouped.get(9)?.map((amendment) => amendment.id)).toEqual([1, 3]);
        expect(grouped.get(11)).toBeUndefined();
    });
});
