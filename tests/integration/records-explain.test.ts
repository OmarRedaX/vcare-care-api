import "reflect-metadata";
import type { Knex } from "knex";
import {
    countLiveByRecord, findLive, findLiveById, listByRecordIds as listAttachmentsByRecordIds, listByRecordIdsQuery as listAttachmentsQuery,
} from "../../src/app/record-attachments/repository/record-attachments.repo";
import { listByRecordIds, listByRecordIdsQuery } from "../../src/app/records/repository/medical-record-amendments.repo";
import {
    findAccessRow, findById, findByIdForNoKeyUpdate, findLiveIdByConsultationId, findLockRowForNoKeyUpdate, isFollowUpTarget, listConsultationIdsWithRecord, listTimelineQuery,
} from "../../src/app/records/repository/medical-records.repo";
import { listExpiredOpenIntents } from "../../src/app/upload-intents/repository/upload-intents.repo";
import type { RecordQueriesService } from "../../src/app/records/service/record-queries.service";
import { container } from "../../src/lib/di/container";
import { TOKENS } from "../../src/lib/di/tokens";
import { db } from "../../src/lib/knex/knex";
import type { AuthContext } from "../../src/lib/types/types";
import { closeDb, ownerDb, truncateAll } from "../helpers/db";
import { closeRedis } from "../helpers/redis";

jest.setTimeout(180_000);

const PATIENT_USER = 105;
const TIMELINE_INDEX = "idx_medical_records_patient_user_id_created_at_id";
const AMENDMENTS_INDEX = "idx_medical_record_amendments_medical_record_id_id";
const ATTACHMENTS_INDEX = "idx_record_attachments_medical_record_id";
const INTENTS_OPEN_INDEX = "idx_upload_intents_expires_at_open";
/** Every hundredth record carries 15 live attachments (the cap-count seed); every even record carries one; every tenth also a soft-deleted one. */
const BUSY_RECORD = 400;
const UNIQUE_INDEX = "uq_medical_records_consultation_id";
const DAY_MS = 86_400_000;
/** The seeded rows start 60 days before now and run one hour per 200 consultations. */
const BASE = Date.now() - 60 * DAY_MS;

/** Plans of every records statement on tables big enough that the planner has a real choice (12 000 records, 4 000 amendments, ANALYZEd). */
describe("records query plans and budgets (integration: real Postgres)", () => {
    beforeAll(async () => {
        await truncateAll();
        const [profile] = await ownerDb("doctor_profiles").insert({ user_id: 999, headline: "Synthetic", years_experience: 5, consultation_fee: 15000, currency: "EGP", default_slot_minutes: 30,
            timezone: "UTC", is_accepting_patients: true, verification_status: "approved", identity_sync_status: "synced", decided_at: new Date() }).returning("id");
        await ownerDb("consultation_types").insert({ doctor_profile_id: (profile as { id: number }).id, name: "Synthetic Visit", duration_minutes: 30, price: 15000, currency: "EGP", is_active: true });
        // 12 000 completed consultations in chunks (the owner pool has a 5 s statement timeout): 200 doctors x 60 hourly slots, 40 patients (300 records each).
        for (let first = 0; first < 12_000; first += 3000) {
            await ownerDb.raw(`INSERT INTO consultations (doctor_user_id, patient_user_id, consultation_type_id, starts_at, ends_at, status, complaint_text, patient_timezone,
                    price, currency, idempotency_key, request_hash)
                SELECT 1000 + (i % 200), 100 + (i % 40), 1, ?::timestamptz + (i / 200) * interval '1 hour', ?::timestamptz + (i / 200) * interval '1 hour' + interval '30 minutes',
                    'completed', 'SYNTHETIC', 'UTC', 100, 'EGP', gen_random_uuid(), repeat('a', 64)
                FROM generate_series(?::int, ?::int) AS i`, [new Date(BASE).toISOString(), new Date(BASE).toISOString(), first, first + 2999]);
        }
        for (let first = 1; first <= 12_000; first += 3000) {
            await ownerDb.raw(`INSERT INTO medical_records (consultation_id, patient_user_id, doctor_user_id, chief_complaint, created_at, updated_at, locked_at)
                SELECT id, patient_user_id, doctor_user_id, 'SYNTHETIC', ends_at, ends_at, ends_at + interval '24 hours' FROM consultations WHERE id BETWEEN ? AND ?`, [first, first + 2999]);
        }
        await ownerDb.raw(`INSERT INTO medical_record_amendments (medical_record_id, author_user_id, diagnosis_text, reason, created_at)
            SELECT id, doctor_user_id, 'SYNTHETIC', 'SYNTHETIC', locked_at + interval '1 hour' FROM medical_records WHERE id % 3 = 0`);
        // Attachments (record-attachments): one live row per even record, a soft-deleted row per tenth record, 14 more live rows on every hundredth record.
        await ownerDb.raw(`INSERT INTO record_attachments (medical_record_id, uploaded_by_user_id, object_key, file_type, size_bytes, description, created_at)
            SELECT id, doctor_user_id, 'record-attachments/explain-live-' || id, 'application/pdf', 1000, NULL, locked_at FROM medical_records WHERE id % 2 = 0`);
        await ownerDb.raw(`INSERT INTO record_attachments (medical_record_id, uploaded_by_user_id, object_key, file_type, size_bytes, description, created_at, deleted_at)
            SELECT id, doctor_user_id, 'record-attachments/explain-deleted-' || id, 'image/png', 1000, NULL, locked_at, locked_at + interval '1 hour' FROM medical_records WHERE id % 10 = 0`);
        await ownerDb.raw(`INSERT INTO record_attachments (medical_record_id, uploaded_by_user_id, object_key, file_type, size_bytes, description, created_at)
            SELECT m.id, m.doctor_user_id, 'record-attachments/explain-busy-' || m.id || '-' || n, 'image/jpeg', 1000, NULL, m.locked_at
            FROM medical_records m CROSS JOIN generate_series(1, 14) AS n WHERE m.id % 100 = 0`);
        // Upload intents of both kinds: mostly consumed three days ago; i % 250 in (0, 125) is open and expired (80 rows of both kinds: the purge listing), i % 250 = 1 open and fresh.
        await ownerDb.raw(`INSERT INTO upload_intents (kind, target_id, owner_user_id, document_type, description, quarantine_key, max_bytes, expires_at, consumed_at, result_id, created_at)
            SELECT CASE WHEN i % 2 = 0 THEN 'record_attachment' ELSE 'verification_document' END, 1 + i % 50, 1000 + i % 200,
                   CASE WHEN i % 2 = 0 THEN NULL ELSE 'license' END, NULL, 'quarantine/explain-' || i, 10485760,
                   NOW() + CASE WHEN i % 250 IN (0, 125) THEN interval '-1 hour' WHEN i % 250 = 1 THEN interval '1 hour' ELSE interval '-3 days' END,
                   CASE WHEN i % 250 IN (0, 125, 1) THEN NULL ELSE NOW() - interval '3 days' END, CASE WHEN i % 250 IN (0, 125, 1) THEN NULL ELSE i END, NOW() - interval '3 days'
            FROM generate_series(1, 10000) AS i`);
        await ownerDb.raw("ANALYZE consultations");
        await ownerDb.raw("ANALYZE medical_records");
        await ownerDb.raw("ANALYZE medical_record_amendments");
        await ownerDb.raw("ANALYZE record_attachments");
        await ownerDb.raw("ANALYZE upload_intents");
    });
    afterAll(async () => {
        await truncateAll();
        await closeDb();
        await closeRedis();
    });

    async function plan(sql: string, bindings: Knex.RawBinding[] = []): Promise<string> {
        return db.transaction(async (trx) => {
            const result = await trx.raw<{ rows: Array<{ "QUERY PLAN": string }> }>(`EXPLAIN ${sql}`, bindings);
            return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
        });
    }

    /** Runs the repository function for real, captures the first statement it issues and EXPLAINs exactly that. */
    async function planOf(run: (trx: Knex.Transaction) => Promise<unknown>): Promise<string> {
        return db.transaction(async (trx) => {
            const captured: Array<{ sql: string; bindings: unknown[] }> = [];
            trx.on("query", (data: { sql: string; bindings: unknown[] }) => { captured.push(data); });
            await run(trx);
            const statement = captured[0];
            expect(statement).toBeDefined();
            const result = await trx.raw<{ rows: Array<{ "QUERY PLAN": string }> }>(`EXPLAIN ${statement?.sql.replace(/\$\d+/g, "?") ?? ""}`, (statement?.bindings ?? []) as Knex.RawBinding[]);
            return result.rows.map((entry) => entry["QUERY PLAN"]).join("\n");
        });
    }

    const noSeqScan = (text: string, table: string): void => expect(text).not.toMatch(new RegExp(`Seq Scan on ${table}`));

    it("should plan the first timeline page on the patient timeline index with no sequential scan and no sort", async () => {
        const text = await plan(listTimelineQuery({ patientUserId: PATIENT_USER, after: null, fetch: 21 }, db).toQuery());
        expect(text).toContain(TIMELINE_INDEX);
        noSeqScan(text, "medical_records");
        expect(text).not.toMatch(/Sort/);
    });

    it("should plan the keyset continuation on the same index with no sequential scan", async () => {
        const middle = await ownerDb("medical_records").where({ patient_user_id: PATIENT_USER }).orderBy("created_at", "desc").orderBy("id", "desc").offset(100).first("id", "created_at");
        const text = await plan(listTimelineQuery({ patientUserId: PATIENT_USER, after: { sortValue: (middle.created_at as Date).toISOString().replace("Z", "000Z"), id: middle.id as number }, fetch: 21 }, db).toQuery());
        expect(text).toContain(TIMELINE_INDEX);
        noSeqScan(text, "medical_records");
    });

    it("should plan the amendments of a whole page on the amendments index with no sequential scan", async () => {
        const ids = (await ownerDb("medical_records").where({ patient_user_id: PATIENT_USER }).orderBy("id").limit(20).pluck("id")) as number[];
        const text = await plan(listByRecordIdsQuery(ids, db).toQuery());
        expect(text).toContain(AMENDMENTS_INDEX);
        noSeqScan(text, "medical_record_amendments");
    });

    it("should plan the duplicate check and the hasRecord batch on the one-live-record unique index", async () => {
        const duplicate = await planOf((trx) => findLiveIdByConsultationId(777, trx));
        expect(duplicate).toContain(UNIQUE_INDEX);
        noSeqScan(duplicate, "medical_records");
        const batch = await planOf((trx) => listConsultationIdsWithRecord([5, 17, 33, 4001, 4002, 9000, 9001, 11999], trx));
        expect(batch).toContain(UNIQUE_INDEX);
        noSeqScan(batch, "medical_records");
    });

    it("should plan the by-id reads, the locked read, the resolver access row and the follow-up target as primary-key accesses", async () => {
        for (const run of [(trx: Knex.Transaction) => findById(777, trx), (trx: Knex.Transaction) => findByIdForNoKeyUpdate(777, trx), (trx: Knex.Transaction) => findAccessRow(777, trx),
            (trx: Knex.Transaction) => isFollowUpTarget(777, 100 + (776 % 40), 1000 + (776 % 200), trx)]) {
            const text = await planOf(run);
            expect(text).toMatch(/Index (Only )?Scan using medical_records_pkey/);
            noSeqScan(text, "medical_records");
        }
    });

    it("should plan the amendments read of one record on the amendments index", async () => {
        const text = await planOf((trx) => listByRecordIds([4, 8, 12], trx));
        expect(text).toContain(AMENDMENTS_INDEX);
        noSeqScan(text, "medical_record_amendments");
    });

    describe("record attachments (about 6 000 live rows, soft-deleted rows, 15-row records; ANALYZEd)", () => {
        it("should plan the attachments of a whole page on the partial record index with no sequential scan", async () => {
            const ids = (await ownerDb("medical_records").where({ patient_user_id: PATIENT_USER }).orderBy("id").limit(20).pluck("id")) as number[];
            const text = await plan(listAttachmentsQuery(ids, db).toQuery());
            expect(text).toContain(ATTACHMENTS_INDEX);
            noSeqScan(text, "record_attachments");
            const rows = await db.transaction((trx) => listAttachmentsByRecordIds(ids, trx));
            expect([...rows.values()].flat().length).toBeGreaterThan(0);
        });

        it("should plan the cap count of one record, and the three-record read, on the partial record index", async () => {
            const count = await planOf((trx) => countLiveByRecord(BUSY_RECORD, trx));
            expect(count).toContain(ATTACHMENTS_INDEX);
            noSeqScan(count, "record_attachments");
            await expect(db.transaction((trx) => countLiveByRecord(BUSY_RECORD, trx))).resolves.toBe(15);
            const few = await planOf((trx) => listAttachmentsByRecordIds([4, 8, BUSY_RECORD], trx));
            expect(few).toContain(ATTACHMENTS_INDEX);
            noSeqScan(few, "record_attachments");
        });

        it("should plan findLive on an index with both equality columns and findLiveById on the primary key, with no sequential scan", async () => {
            const target = await ownerDb("record_attachments").where({ medical_record_id: 8 }).whereNull("deleted_at").first("id");
            // (id, medical_record_id) are both equalities: the planner may use the primary key or the narrower partial record index; either is a one-row index access.
            const byRecord = await planOf((trx) => findLive(target.id as number, 8, trx));
            expect(byRecord).toMatch(/Index (Only )?Scan using (record_attachments_pkey|idx_record_attachments_medical_record_id)/);
            noSeqScan(byRecord, "record_attachments");
            const byId = await planOf((trx) => findLiveById(target.id as number, trx));
            expect(byId).toMatch(/Index (Only )?Scan using record_attachments_pkey/);
            noSeqScan(byId, "record_attachments");
        });

        it("should plan the lock read of the write path as a primary-key access on medical_records", async () => {
            const text = await planOf((trx) => findLockRowForNoKeyUpdate(777, trx));
            expect(text).toMatch(/Index (Only )?Scan using medical_records_pkey/);
            noSeqScan(text, "medical_records");
        });

        it("should plan the purge listing of every kind on the open-intent index with no sequential scan", async () => {
            const text = await planOf((trx) => listExpiredOpenIntents(500, trx));
            expect(text).toContain(INTENTS_OPEN_INDEX);
            noSeqScan(text, "upload_intents");
            const listed = await db.transaction((trx) => listExpiredOpenIntents(500, trx));
            expect(listed.length).toBe(80);
            expect(new Set(listed.map((row) => row.kind))).toEqual(new Set(["record_attachment", "verification_document"]));
        });

        it("should return live rows only, oldest first, for a page that mixes live, deleted and busy records", async () => {
            const rows = await db.transaction((trx) => listAttachmentsByRecordIds([10, 20, BUSY_RECORD, 7], trx));
            expect(rows.get(7)).toBeUndefined();
            expect(rows.get(10)?.length).toBe(1);
            expect(rows.get(BUSY_RECORD)?.length).toBe(15);
            const ids = rows.get(BUSY_RECORD)?.map((item) => item.id) ?? [];
            expect(ids).toEqual([...ids].sort((a, b) => a - b));
            expect(rows.get(10)?.every((item) => item.fileType === "application/pdf")).toBe(true);
        });
    });

    describe("budgets (the real services on the seeded tables; the timeline page carries amendments)", () => {
        const patient: AuthContext = { userId: PATIENT_USER, role: "patient", status: "active", emailVerified: true };
        const p95 = (samples: number[]): number => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1] ?? Infinity;
        const measure = async (run: () => Promise<unknown>, runs = 30): Promise<number[]> => {
            await run();
            const samples: number[] = [];
            for (let index = 0; index < runs; index += 1) {
                const started = performance.now();
                await run();
                samples.push(performance.now() - started);
            }
            return samples;
        };

        it("should serve a timeline page of 20 records with their amendments within 200 ms at p95", async () => {
            const service = container.resolve<RecordQueriesService>(TOKENS.RecordQueriesService);
            const page = await service.timeline(patient, PATIENT_USER, { cursor: undefined, limit: 20 });
            expect(page.items).toHaveLength(20);
            expect(page.meta.hasMore).toBe(true);
            expect(page.items.some((item) => item.amendments.length > 0)).toBe(true);
            expect(p95(await measure(() => service.timeline(patient, PATIENT_USER, { cursor: undefined, limit: 20 })))).toBeLessThan(200);
        });

        it("should serve the read of one record within 150 ms at p95", async () => {
            const service = container.resolve<RecordQueriesService>(TOKENS.RecordQueriesService);
            const row = await ownerDb("medical_records").where({ patient_user_id: PATIENT_USER }).where(ownerDb.raw("id % 3 = 0")).first("id");
            const result = await service.get(patient, row.id as number);
            expect(result.amendments.length).toBeGreaterThan(0);
            expect(p95(await measure(() => service.get(patient, row.id as number)))).toBeLessThan(150);
        });

        it("should issue exactly the documented statements for a timeline page: page, amendments, attachments, profile, audit", async () => {
            const service = container.resolve<RecordQueriesService>(TOKENS.RecordQueriesService);
            const statements: string[] = [];
            const listener = (data: { sql: string }): void => { statements.push(data.sql); };
            db.on("query", listener);
            try { await service.timeline(patient, PATIENT_USER, { cursor: undefined, limit: 20 }); } finally { db.removeListener("query", listener); }
            const relevant = statements.filter((sql) => !/^(begin|commit|rollback)/i.test(sql));
            expect(relevant.map((sql) => /medical_record_amendments/.test(sql) ? "amendments" : /record_attachments/.test(sql) ? "attachments" : /patient_profiles/.test(sql) ? "profile" : /audit_logs/.test(sql) ? "audit" : /medical_records/.test(sql) ? "page" : "other"))
                .toEqual(["page", "amendments", "attachments", "profile", "audit"]);
        });

        it("should serve a timeline page whose records carry attachments within 200 ms at p95", async () => {
            const service = container.resolve<RecordQueriesService>(TOKENS.RecordQueriesService);
            const page = await service.timeline(patient, PATIENT_USER, { cursor: undefined, limit: 20 });
            expect(page.items.some((item) => item.attachments.length > 0)).toBe(true);
            expect(p95(await measure(() => service.timeline(patient, PATIENT_USER, { cursor: undefined, limit: 20 })))).toBeLessThan(200);
        });

        it("should serve the read of one record that carries attachments within 150 ms at p95, issuing record, amendments, attachments, audit", async () => {
            const service = container.resolve<RecordQueriesService>(TOKENS.RecordQueriesService);
            const row = await ownerDb("medical_records").where({ id: BUSY_RECORD }).first("id", "patient_user_id");
            const owner: AuthContext = { userId: row.patient_user_id as number, role: "patient", status: "active", emailVerified: true };
            const result = await service.get(owner, row.id as number);
            expect(result.attachments.length).toBe(15);
            const statements: string[] = [];
            const listener = (data: { sql: string }): void => { statements.push(data.sql); };
            db.on("query", listener);
            try { await service.get(owner, row.id as number); } finally { db.removeListener("query", listener); }
            const relevant = statements.filter((sql) => !/^(begin|commit|rollback)/i.test(sql));
            expect(relevant.map((sql) => /medical_record_amendments/.test(sql) ? "amendments" : /record_attachments/.test(sql) ? "attachments" : /audit_logs/.test(sql) ? "audit" : /medical_records/.test(sql) ? "record" : "other"))
                .toEqual(["record", "amendments", "attachments", "audit"]);
            expect(p95(await measure(() => service.get(owner, row.id as number)))).toBeLessThan(150);
        });
    });
});
