import type { Knex } from "knex";
import { db } from "../../src/lib/knex/knex";
import * as medicalRecordsMigration from "../../src/migrations/20261017120000_create_medical_records";
import * as medicalRecordAmendmentsMigration from "../../src/migrations/20261017120100_create_medical_record_amendments";
import * as followUpFkMigration from "../../src/migrations/20261017120200_add_consultations_follow_up_fk";
import { checkViolationConstraint } from "../../src/lib/knex/pg-errors";
import { DOCTOR, PATIENT, useConsultationsHarness } from "../helpers/consultations-harness";
import { ownerDb } from "../helpers/db";
import { CHIEF, seedCompleted } from "../helpers/records-fixtures";

jest.setTimeout(120_000);

const NINE = ["medical_record_id", "author_user_id", "chief_complaint", "examination_notes", "diagnosis_text", "diagnosis_code", "treatment_plan", "follow_up_in_days", "reason"];
const TRIGGER = "trg_medical_records_forbid_update_after_lock";

/** The three records migrations: structure, CHECKs, trigger, grants and foreign keys (spec 2.5), on the real database as the owner and as care_app. */
describe("records schema (integration: real Postgres, owner care and app login care_app)", () => {
    const h = useConsultationsHarness("records-schema");

    const names = async (table: string, kind: "constraints" | "indexes"): Promise<string[]> => {
        const sql = kind === "constraints"
            ? "SELECT conname AS name FROM pg_constraint WHERE conrelid = ?::regclass AND contype <> 'n' ORDER BY conname"
            : "SELECT indexname AS name FROM pg_indexes WHERE tablename = ? ORDER BY indexname";
        return (await ownerDb.raw(sql, [table])).rows.map((row: { name: string }) => row.name);
    };
    const insertRecord = (consultationId: number, sql = "NOW()", extra: Record<string, unknown> = {}) => ownerDb.raw(
        `INSERT INTO medical_records (consultation_id, patient_user_id, doctor_user_id, chief_complaint, created_at, updated_at, locked_at, diagnosis_code, follow_up_in_days)
         VALUES (?, ?, ?, ?, ${sql}, ${sql}, ${sql} + interval '24 hours', ?, ?) RETURNING id`,
        [consultationId, PATIENT, DOCTOR, CHIEF, extra.diagnosis_code ?? null, extra.follow_up_in_days ?? null] as Knex.RawBinding[]);
    const failure = async (run: () => Promise<unknown>): Promise<{ code?: string; constraint?: string }> => {
        try { await run(); } catch (error) { return error as { code?: string; constraint?: string }; }
        return {};
    };

    describe("structure", () => {
        it("should create the named constraints and indexes, each foreign key ON DELETE RESTRICT, and the lock function and trigger", async () => {
            expect(await names("medical_records", "constraints")).toEqual(["chk_medical_records_diagnosis_code", "chk_medical_records_follow_up", "chk_medical_records_lock",
                "fk_medical_records_consultation_id", "medical_records_pkey"]);
            expect(await names("medical_records", "indexes")).toEqual(["idx_medical_records_patient_user_id_created_at_id", "medical_records_pkey", "uq_medical_records_consultation_id"]);
            expect(await names("medical_record_amendments", "constraints")).toEqual(["chk_medical_record_amendments_diagnosis_code", "chk_medical_record_amendments_follow_up",
                "chk_medical_record_amendments_nonempty", "fk_medical_record_amendments_medical_record_id", "medical_record_amendments_pkey"]);
            expect(await names("medical_record_amendments", "indexes")).toEqual(["idx_medical_record_amendments_medical_record_id_created_at", "medical_record_amendments_pkey"]);
            const fks = await ownerDb.raw("SELECT conname, confdeltype FROM pg_constraint WHERE contype = 'f' AND conname IN (?, ?, ?) ORDER BY conname",
                ["fk_medical_records_consultation_id", "fk_medical_record_amendments_medical_record_id", "fk_consultations_follow_up_of_record_id"]);
            expect(fks.rows).toEqual([{ conname: "fk_consultations_follow_up_of_record_id", confdeltype: "r" }, { conname: "fk_medical_record_amendments_medical_record_id", confdeltype: "r" },
                { conname: "fk_medical_records_consultation_id", confdeltype: "r" }]);
            const trigger = await ownerDb.raw("SELECT tgname, tgtype, tgenabled FROM pg_trigger WHERE tgrelid = 'medical_records'::regclass AND NOT tgisinternal");
            expect(trigger.rows).toEqual([{ tgname: TRIGGER, tgtype: 19, tgenabled: "O" }]); // 19 = ROW | BEFORE | UPDATE
        });

        it("should store the diagnosis code pattern exactly as the contract states it, in both tables", async () => {
            const defs = await ownerDb.raw("SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname IN ('chk_medical_records_diagnosis_code', 'chk_medical_record_amendments_diagnosis_code') ORDER BY conname");
            for (const row of defs.rows as Array<{ def: string }>) expect(row.def).toContain("'^[A-Z][0-9]{2}(\\.[0-9A-Z]{1,4})?$'");
        });

        it("should keep every timestamp TIMESTAMPTZ, give locked_at no default and leave soft delete as a nullable deleted_at", async () => {
            const columns = await ownerDb.raw(`SELECT table_name, column_name, data_type, column_default, is_nullable FROM information_schema.columns
                WHERE table_name IN ('medical_records', 'medical_record_amendments') AND (column_name LIKE '%\\_at') ORDER BY table_name, column_name`);
            expect(columns.rows.every((row: { data_type: string }) => row.data_type === "timestamp with time zone")).toBe(true);
            const byName = Object.fromEntries((columns.rows as Array<{ table_name: string; column_name: string; column_default: string | null; is_nullable: string }>).map((row) => [`${row.table_name}.${row.column_name}`, row]));
            expect(byName["medical_records.locked_at"]).toMatchObject({ column_default: null, is_nullable: "NO" });
            expect(byName["medical_records.deleted_at"]).toMatchObject({ is_nullable: "YES" });
            expect(byName["medical_records.created_at"]?.column_default).toMatch(/now\(\)/i);
            expect(byName["medical_record_amendments.deleted_at"]).toBeUndefined();
        });

        it("should comment the clinical columns as never logged and name Identity user ids", async () => {
            const comment = async (table: string, column: string): Promise<string> =>
                (await ownerDb.raw("SELECT col_description(?::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = ?::regclass AND attname = ?)) AS c", [table, table, column])).rows[0].c as string;
            for (const column of ["chief_complaint", "examination_notes", "diagnosis_text", "diagnosis_code", "treatment_plan"]) expect(await comment("medical_records", column)).toContain("never logged");
            for (const column of ["patient_user_id", "doctor_user_id"]) expect(await comment("medical_records", column)).toContain("Identity user id");
            expect(await comment("medical_record_amendments", "author_user_id")).toContain("Identity user id");
            expect(await comment("medical_record_amendments", "reason")).toContain("never logged");
        });
    });

    describe("CHECK constraints and unique index", () => {
        it("should reject a locked_at that is not created_at + 24 hours, whoever writes it", async () => {
            const id = await seedCompleted(h);
            const bad = await failure(() => ownerDb.raw(`INSERT INTO medical_records (consultation_id, patient_user_id, doctor_user_id, chief_complaint, created_at, updated_at, locked_at)
                VALUES (?, ?, ?, ?, NOW(), NOW(), NOW() + interval '23 hours')`, [id, PATIENT, DOCTOR, CHIEF]));
            expect([bad.code, bad.constraint]).toEqual(["23514", "chk_medical_records_lock"]);
            const appBad = await failure(() => db.raw(`INSERT INTO medical_records (consultation_id, patient_user_id, doctor_user_id, chief_complaint, locked_at)
                VALUES (?, ?, ?, ?, NOW() + interval '24 hours' + interval '1 second')`, [id, PATIENT, DOCTOR, CHIEF]));
            expect([appBad.code, appBad.constraint]).toEqual(["23514", "chk_medical_records_lock"]);
            expect((await insertRecord(id)).rows).toHaveLength(1);
        });

        it.each([[0, false], [1, true], [365, true], [366, false]])("should judge follow_up_in_days %i accepted=%s on both tables", async (days, accepted) => {
            const id = await seedCompleted(h);
            const result = await failure(() => insertRecord(id, "NOW()", { follow_up_in_days: days }));
            expect(result.code === undefined).toBe(accepted);
            if (!accepted) expect(result.constraint).toBe("chk_medical_records_follow_up");
            const recordId = (await insertRecord(await seedCompleted(h))).rows[0].id as number;
            const amend = await failure(() => ownerDb("medical_record_amendments").insert({ medical_record_id: recordId, author_user_id: DOCTOR, follow_up_in_days: days, reason: "SYNTHETIC" }));
            expect(amend.code === undefined).toBe(accepted);
            if (!accepted) expect(amend.constraint).toBe("chk_medical_record_amendments_follow_up");
        });

        it.each([["A00", true], ["A00.1", true], ["J45.9", true], ["A00.12AB", true], ["a00", false], ["A0", false], ["A00.", false], ["A00.12345", false], ["A00 ", false]])(
            "should judge diagnosis_code %j accepted=%s on both tables", async (code, accepted) => {
                const result = await failure(() => insertRecord(0, "NOW()", { diagnosis_code: code }));
                // consultation 0 does not exist: a valid code reaches the foreign key (23503), an invalid one stops at the CHECK first.
                if (accepted) expect(result.code).toBe("23503"); else expect([result.code, result.constraint]).toEqual(["23514", "chk_medical_records_diagnosis_code"]);
                const recordId = (await insertRecord(await seedCompleted(h))).rows[0].id as number;
                const amend = await failure(() => ownerDb("medical_record_amendments").insert({ medical_record_id: recordId, author_user_id: DOCTOR, diagnosis_code: code, reason: "SYNTHETIC" }));
                expect(amend.code === undefined).toBe(accepted);
                if (!accepted) expect(amend.constraint).toBe("chk_medical_record_amendments_diagnosis_code");
            });

        it("should allow one live record per consultation and a second only after the first is soft-deleted", async () => {
            const id = await seedCompleted(h);
            await insertRecord(id);
            const duplicate = await failure(() => insertRecord(id));
            expect([duplicate.code, duplicate.constraint]).toEqual(["23505", "uq_medical_records_consultation_id"]);
            await ownerDb("medical_records").where({ consultation_id: id }).update({ deleted_at: new Date() });
            expect((await insertRecord(id)).rows).toHaveLength(1);
            expect(await ownerDb("medical_records").where({ consultation_id: id })).toHaveLength(2);
        });

        it("should reject a record for a consultation that does not exist and an amendment for a record that does not exist", async () => {
            expect((await failure(() => insertRecord(987654))).code).toBe("23503");
            const orphan = await failure(() => ownerDb("medical_record_amendments").insert({ medical_record_id: 987654, author_user_id: DOCTOR, treatment_plan: "SYNTHETIC", reason: "SYNTHETIC" }));
            expect([orphan.code, orphan.constraint]).toEqual(["23503", "fk_medical_record_amendments_medical_record_id"]);
        });

        it("should reject an amendment that changes nothing, and one without a reason", async () => {
            const recordId = (await insertRecord(await seedCompleted(h))).rows[0].id as number;
            const empty = await failure(() => ownerDb("medical_record_amendments").insert({ medical_record_id: recordId, author_user_id: DOCTOR, reason: "SYNTHETIC" }));
            expect([empty.code, empty.constraint]).toEqual(["23514", "chk_medical_record_amendments_nonempty"]);
            const noReason = await failure(() => ownerDb("medical_record_amendments").insert({ medical_record_id: recordId, author_user_id: DOCTOR, treatment_plan: "SYNTHETIC" }));
            expect(noReason.code).toBe("23502");
            for (const column of ["chief_complaint", "examination_notes", "diagnosis_text", "treatment_plan"]) {
                const accepted = await failure(() => ownerDb("medical_record_amendments").insert({ medical_record_id: recordId, author_user_id: DOCTOR, [column]: "SYNTHETIC", reason: "SYNTHETIC" }));
                expect([column, accepted.code]).toEqual([column, undefined]);
            }
        });
    });

    describe("the lock trigger", () => {
        it("should allow an UPDATE while locked_at is in the future and refuse it once locked_at <= NOW(), naming the trigger", async () => {
            const open = (await insertRecord(await seedCompleted(h))).rows[0].id as number;
            await ownerDb("medical_records").where({ id: open }).update({ treatment_plan: "SYNTHETIC-PLAN" });
            const locked = await seedCompleted(h);
            const lockedId = (await insertRecord(locked, "NOW() - interval '25 hours'")).rows[0].id as number;
            for (const conn of [ownerDb, db]) {
                const refused = await failure(() => conn("medical_records").where({ id: lockedId }).update({ treatment_plan: "SYNTHETIC-PLAN" }));
                expect([refused.code, refused.constraint]).toEqual(["23514", TRIGGER]);
            }
        });

        it("should refuse in the equality case, where locked_at = NOW() in the same transaction", async () => {
            const id = await seedCompleted(h);
            const refused = await failure(() => ownerDb.transaction(async (trx) => {
                await trx.raw(`INSERT INTO medical_records (consultation_id, patient_user_id, doctor_user_id, chief_complaint, created_at, updated_at, locked_at)
                    VALUES (?, ?, ?, ?, NOW() - interval '24 hours', NOW(), NOW())`, [id, PATIENT, DOCTOR, CHIEF]);
                await trx.raw("UPDATE medical_records SET treatment_plan = 'SYNTHETIC-PLAN' WHERE consultation_id = ?", [id]);
            }));
            expect(checkViolationConstraint(refused)).toBe(TRIGGER);
            expect(await ownerDb("medical_records")).toHaveLength(0);
        });

        it("should refuse a soft delete after the lock and any update of a column after the lock, and allow neither a delete nor a truncate for the app role", async () => {
            const id = (await insertRecord(await seedCompleted(h), "NOW() - interval '30 hours'")).rows[0].id as number;
            expect((await failure(() => db("medical_records").where({ id }).update({ deleted_at: new Date() }))).constraint).toBe(TRIGGER);
            expect((await failure(() => db("medical_records").where({ id }).update({ locked_at: new Date(Date.now() + 99_000_000) }))).constraint).toBe(TRIGGER);
            expect((await failure(() => db.raw("DELETE FROM medical_records WHERE id = ?", [id]))).code).toBe("42501");
            expect((await failure(() => db.raw("TRUNCATE medical_records"))).code).toBe("42501");
            expect(await ownerDb("medical_records").where({ id })).toHaveLength(1);
        });

        it("should keep the trigger enabled for the owner role as well (no role bypasses the lock)", async () => {
            const id = (await insertRecord(await seedCompleted(h), "NOW() - interval '30 hours'")).rows[0].id as number;
            const refused = await failure(() => ownerDb("medical_records").where({ id }).update({ deleted_at: new Date() }));
            expect(refused.constraint).toBe(TRIGGER);
        });
    });

    describe("grants for the app login (ADR 0018)", () => {
        const privilege = async (sql: string, ...bindings: string[]): Promise<boolean> => (await ownerDb.raw(`SELECT ${sql} AS ok`, bindings)).rows[0].ok as boolean;

        it("should give care_app select, insert and update on medical_records and no delete or truncate", async () => {
            const flags = [] as boolean[];
            for (const kind of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) flags.push(await privilege("has_table_privilege('care_app', 'medical_records', ?)", kind));
            expect(flags).toEqual([true, true, true, false, false, false, false]);
            expect(await privilege("has_sequence_privilege('care_app', 'medical_records_id_seq', 'USAGE')")).toBe(true);
        });

        it("should make medical_record_amendments append-only for care_app: select and a nine column insert, never update, delete, truncate or the id and created_at columns", async () => {
            expect(await privilege("has_table_privilege('care_app', 'medical_record_amendments', 'SELECT')")).toBe(true);
            for (const kind of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) expect([kind, await privilege("has_table_privilege('care_app', 'medical_record_amendments', ?)", kind)]).toEqual([kind, false]);
            for (const column of NINE) expect([column, await privilege("has_column_privilege('care_app', 'medical_record_amendments', ?, 'INSERT')", column)]).toEqual([column, true]);
            for (const column of ["id", "created_at"]) expect([column, await privilege("has_column_privilege('care_app', 'medical_record_amendments', ?, 'INSERT')", column)]).toEqual([column, false]);
            for (const column of [...NINE, "id", "created_at"]) expect([column, await privilege("has_column_privilege('care_app', 'medical_record_amendments', ?, 'UPDATE')", column)]).toEqual([column, false]);
            expect(await privilege("has_sequence_privilege('care_app', 'medical_record_amendments_id_seq', 'USAGE')")).toBe(true);
        });

        it("should refuse, at statement level, every write to an amendment that the append-only rule forbids", async () => {
            const recordId = (await insertRecord(await seedCompleted(h))).rows[0].id as number;
            const base = { medical_record_id: recordId, author_user_id: DOCTOR, treatment_plan: "SYNTHETIC", reason: "SYNTHETIC" };
            await db("medical_record_amendments").insert(base);
            expect((await failure(() => db("medical_record_amendments").insert({ ...base, id: 1 }))).code).toBe("42501");
            expect((await failure(() => db("medical_record_amendments").insert({ ...base, created_at: new Date(0) }))).code).toBe("42501");
            expect((await failure(() => db("medical_record_amendments").update({ reason: "SYNTHETIC-REWRITTEN" }))).code).toBe("42501");
            expect((await failure(() => db("medical_record_amendments").del())).code).toBe("42501");
            expect((await failure(() => db.raw("TRUNCATE medical_record_amendments"))).code).toBe("42501");
            expect(await ownerDb("medical_record_amendments")).toHaveLength(1);
            expect((await ownerDb("medical_record_amendments"))[0]).toMatchObject({ reason: "SYNTHETIC" });
        });

        it("should let the app role read the amendments and records it needs and nothing about DDL", async () => {
            expect((await failure(() => db.raw("ALTER TABLE medical_records ADD COLUMN probe int"))).code).toBe("42501");
            expect((await failure(() => db.raw("DROP TRIGGER trg_medical_records_forbid_update_after_lock ON medical_records"))).code).toBe("42501");
            expect((await failure(() => db.raw("ALTER TABLE medical_records DISABLE TRIGGER trg_medical_records_forbid_update_after_lock"))).code).toBe("42501");
            expect((await failure(() => db("medical_records").select("id").limit(1))).code).toBeUndefined();
        });
    });

    describe("the follow-up foreign key", () => {
        it("should reject a dangling follow_up_of_record_id and refuse to delete a record a consultation points at", async () => {
            const recordId = (await insertRecord(await seedCompleted(h))).rows[0].id as number;
            const consultation = await h.seedConsultation({ follow_up_of_record_id: recordId, starts_at: new Date(Date.now() + 9 * 86_400_000), ends_at: new Date(Date.now() + 9 * 86_400_000 + 1_800_000) });
            const dangling = await failure(() => h.seedConsultation({ follow_up_of_record_id: 987654, starts_at: new Date(Date.now() + 10 * 86_400_000), ends_at: new Date(Date.now() + 10 * 86_400_000 + 1_800_000) }));
            expect([dangling.code, dangling.constraint]).toEqual(["23503", "fk_consultations_follow_up_of_record_id"]);
            const refused = await failure(() => ownerDb("medical_records").where({ id: recordId }).del());
            expect(["23001", "23503"]).toContain(refused.code);
            expect(refused.constraint).toBe("fk_consultations_follow_up_of_record_id");
            expect((await ownerDb("consultations").where({ id: consultation }).first()).follow_up_of_record_id).toBe(recordId);
        });

        it("should refuse to delete a consultation that has a record or a record that has an amendment (no ON DELETE CASCADE on clinical tables)", async () => {
            const consultationId = await seedCompleted(h);
            const recordId = (await insertRecord(consultationId)).rows[0].id as number;
            await ownerDb("medical_record_amendments").insert({ medical_record_id: recordId, author_user_id: DOCTOR, treatment_plan: "SYNTHETIC", reason: "SYNTHETIC" });
            expect(["23001", "23503"]).toContain((await failure(() => ownerDb("consultations").where({ id: consultationId }).del())).code);
            expect(["23001", "23503"]).toContain((await failure(() => ownerDb("medical_records").where({ id: recordId }).del())).code);
            expect(await ownerDb("medical_record_amendments")).toHaveLength(1);
        });
    });

    describe("rolling the three migrations back and forward", () => {
        it("should drop the records objects on down and recreate them identically on up", async () => {
            const before = { constraints: await names("medical_records", "constraints"), amendments: await names("medical_record_amendments", "constraints"),
                indexes: await names("medical_records", "indexes"), amendmentIndexes: await names("medical_record_amendments", "indexes") };
            const exists = async (): Promise<{ records: boolean; amendments: boolean; fn: boolean; fk: boolean }> => ({
                records: (await ownerDb.raw("SELECT to_regclass('medical_records') IS NOT NULL AS ok")).rows[0].ok,
                amendments: (await ownerDb.raw("SELECT to_regclass('medical_record_amendments') IS NOT NULL AS ok")).rows[0].ok,
                fn: (await ownerDb.raw("SELECT to_regproc('forbid_update_after_lock') IS NOT NULL AS ok")).rows[0].ok,
                fk: (await ownerDb.raw("SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_consultations_follow_up_of_record_id') AS ok")).rows[0].ok,
            });
            expect(await exists()).toEqual({ records: true, amendments: true, fn: true, fk: true });
            await followUpFkMigration.down(ownerDb);
            await medicalRecordAmendmentsMigration.down(ownerDb);
            await medicalRecordsMigration.down(ownerDb);
            try {
                expect(await exists()).toEqual({ records: false, amendments: false, fn: false, fk: false });
            } finally {
                await medicalRecordsMigration.up(ownerDb);
                await medicalRecordAmendmentsMigration.up(ownerDb);
                await followUpFkMigration.up(ownerDb);
            }
            expect(await exists()).toEqual({ records: true, amendments: true, fn: true, fk: true });
            expect({ constraints: await names("medical_records", "constraints"), amendments: await names("medical_record_amendments", "constraints"),
                indexes: await names("medical_records", "indexes"), amendmentIndexes: await names("medical_record_amendments", "indexes") }).toEqual(before);
            // The rebuilt trigger and the rebuilt app grants still hold.
            const id = (await insertRecord(await seedCompleted(h), "NOW() - interval '30 hours'")).rows[0].id as number;
            expect((await failure(() => db("medical_records").where({ id }).update({ treatment_plan: "SYNTHETIC" }))).constraint).toBe(TRIGGER);
            expect((await failure(() => db.raw("DELETE FROM medical_records"))).code).toBe("42501");
        });
    });
});
