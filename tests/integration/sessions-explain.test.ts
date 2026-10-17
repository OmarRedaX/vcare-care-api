import type { Knex } from "knex";
import { listCalendarQuery, listWaitingRoomQuery, setRoomIfAbsent } from "../../src/app/consultations/repository/consultations.repo";
import { db } from "../../src/lib/knex/knex";
import { closeDb, ownerDb, truncateAll } from "../helpers/db";

jest.setTimeout(120_000);

const DOCTOR_INDEX = "idx_consultations_doctor_user_id_starts_at_id";
const NOW = Date.parse("2026-10-20T10:00:00Z");
/** The synthetic rows start 20 days before NOW and run one hour per 200 rows, so the queried windows must sit inside that span. */
const DATA_START = NOW - 20 * 24 * 3600_000;

/** Plans of the three session statements on a table big enough that the planner has a real choice (real statistics, ANALYZEd). */
describe("sessions query plans (integration: real Postgres)", () => {
    beforeAll(async () => {
        await truncateAll();
        const [profile] = await ownerDb("doctor_profiles").insert({ user_id: 999, headline: "Synthetic", years_experience: 5, consultation_fee: 15000, currency: "EGP", default_slot_minutes: 30,
            timezone: "UTC", is_accepting_patients: true, verification_status: "approved", identity_sync_status: "synced", decided_at: new Date() }).returning("id");
        await ownerDb("consultation_types").insert({ doctor_profile_id: (profile as { id: number }).id, name: "Synthetic Visit", duration_minutes: 30, price: 15000, currency: "EGP", is_active: true });
        // 24 000 rows in chunks (the owner pool has a 5 s statement timeout): 200 doctors x 120 hourly rows.
        for (let first = 0; first < 24_000; first += 4000) await ownerDb.raw(`INSERT INTO consultations (doctor_user_id, patient_user_id, consultation_type_id, starts_at, ends_at, status, complaint_text, patient_timezone,
                price, currency, idempotency_key, request_hash)
            SELECT 1000 + (i % 200), 100 + (i % 50), 1, ?::timestamptz + (i / 200) * interval '1 hour' - interval '20 days', ?::timestamptz + (i / 200) * interval '1 hour' - interval '20 days' + interval '30 minutes',
                (ARRAY['booked','completed','no_show','waiting'])[1 + ((i / 200) % 4)], 'SYNTHETIC', 'UTC', 100, 'EGP', gen_random_uuid(), repeat('a', 64)
            FROM generate_series(?::int, ?::int) AS i`, [new Date(NOW).toISOString(), new Date(NOW).toISOString(), first, first + 3999]);
        await ownerDb.raw("ANALYZE consultations");
    });
    afterAll(async () => {
        await truncateAll();
        await closeDb();
    });

    async function plan(sql: string, bindings: Knex.RawBinding[] = []): Promise<string> {
        return db.transaction(async (trx) => {
            const result = await trx.raw<{ rows: Array<{ "QUERY PLAN": string }> }>(`EXPLAIN ${sql}`, bindings);
            return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
        });
    }

    it("should plan the waiting-room query on the doctor index with no sequential scan", async () => {
        const text = await plan(listWaitingRoomQuery({ doctorUserId: 1007, nowMs: DATA_START + 50 * 3600_000, openMinutes: 10, overrunMinutes: 15, limit: 100 }, db).toQuery());
        expect(text).toContain(DOCTOR_INDEX);
        expect(text).not.toMatch(/Seq Scan on consultations/);
    });

    it("should plan the calendar query on the doctor index with no sequential scan", async () => {
        const from = DATA_START + 30 * 3600_000;
        const text = await plan(listCalendarQuery({ doctorUserId: 1007, fromMs: from, toMs: from + 7 * 24 * 3600_000, limit: 1000 }, db).toQuery());
        expect(text).toContain(DOCTOR_INDEX);
        expect(text).not.toMatch(/Seq Scan on consultations/);
    });

    it("should plan setRoomIfAbsent as a primary-key access of the single row", async () => {
        const row = await ownerDb("consultations").where({ status: "booked" }).first("id");
        // Capture the statement the repository function really issues, then EXPLAIN exactly that (the row is synthetic and truncated afterwards).
        const text = await db.transaction(async (trx) => {
            const captured: Array<{ sql: string; bindings: unknown[] }> = [];
            trx.on("query", (data: { sql: string; bindings: unknown[] }) => { captured.push(data); });
            expect(await setRoomIfAbsent(row.id as number, "fake-room-plan", trx)).toBe(true);
            const statement = captured[0];
            expect(statement?.sql.toLowerCase().startsWith('update "consultations"')).toBe(true);
            const result = await trx.raw<{ rows: Array<{ "QUERY PLAN": string }> }>(`EXPLAIN ${statement?.sql.replace(/\$\d+/g, "?") ?? ""}`, (statement?.bindings ?? []) as Knex.RawBinding[]);
            return result.rows.map((entry) => entry["QUERY PLAN"]).join(" | ");
        });
        expect(text).toMatch(/Index Scan using consultations_pkey/);
        expect(text).not.toMatch(/Seq Scan/);
    });
});
