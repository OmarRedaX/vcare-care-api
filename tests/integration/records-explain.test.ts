import "reflect-metadata";
import type { Knex } from "knex";
import { listByRecordIds, listByRecordIdsQuery } from "../../src/app/records/repository/medical-record-amendments.repo";
import {
    findAccessRow, findById, findByIdForNoKeyUpdate, findLiveIdByConsultationId, isFollowUpTarget, listConsultationIdsWithRecord, listTimelineQuery,
} from "../../src/app/records/repository/medical-records.repo";
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
        await ownerDb.raw("ANALYZE consultations");
        await ownerDb.raw("ANALYZE medical_records");
        await ownerDb.raw("ANALYZE medical_record_amendments");
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

        it("should issue exactly the documented statements for a timeline page: page, amendments, profile, audit", async () => {
            const service = container.resolve<RecordQueriesService>(TOKENS.RecordQueriesService);
            const statements: string[] = [];
            const listener = (data: { sql: string }): void => { statements.push(data.sql); };
            db.on("query", listener);
            try { await service.timeline(patient, PATIENT_USER, { cursor: undefined, limit: 20 }); } finally { db.removeListener("query", listener); }
            const relevant = statements.filter((sql) => !/^(begin|commit|rollback)/i.test(sql));
            expect(relevant.map((sql) => /medical_record_amendments/.test(sql) ? "amendments" : /patient_profiles/.test(sql) ? "profile" : /audit_logs/.test(sql) ? "audit" : /medical_records/.test(sql) ? "page" : "other"))
                .toEqual(["page", "amendments", "profile", "audit"]);
        });
    });
});
