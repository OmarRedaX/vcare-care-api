import { listBusyIntervalsQuery } from "../../src/app/consultations/repository/busy-intervals.repo";
import { listShortestTypesQuery, listSlotExceptionsQuery, listSlotHoursQuery } from "../../src/app/schedules/repository/slot-inputs.repo";
import { db } from "../../src/lib/knex/knex";
import { closeDb, ownerDb, truncateAll } from "../helpers/db";

jest.setTimeout(120_000);

const NOW = Date.parse("2026-10-21T10:00:00Z");
const DATA_START = NOW - 20 * 24 * 3_600_000;

describe("availability slots query plans (integration: real Postgres, AV-R4)", () => {
    beforeAll(async () => {
        await truncateAll();
        const [profile] = await ownerDb("doctor_profiles").insert({ user_id: 999, headline: "Synthetic", years_experience: 5,
            consultation_fee: 100, currency: "EGP", default_slot_minutes: 30, timezone: "UTC", is_accepting_patients: true,
            verification_status: "approved", identity_sync_status: "synced", decided_at: new Date() }).returning("id");
        await ownerDb("consultation_types").insert({ doctor_profile_id: Number(profile?.id), name: "Synthetic Visit", duration_minutes: 30,
            price: 100, currency: "EGP", is_active: true });
        for (let first = 0; first < 50_000; first += 4_000) {
            await ownerDb.raw(`INSERT INTO consultations (doctor_user_id, patient_user_id, consultation_type_id, starts_at, ends_at, status, complaint_text,
                    patient_timezone, price, currency, idempotency_key, request_hash)
                SELECT 1000 + (i % 200), 100 + (i % 50), 1,
                    ?::timestamptz + (i / 200) * interval '1 hour',
                    ?::timestamptz + (i / 200) * interval '1 hour' + interval '30 minutes',
                    (ARRAY['booked','completed','no_show','waiting'])[1 + ((i / 200) % 4)],
                    'SYNTHETIC', 'UTC', 100, 'EGP', gen_random_uuid(), repeat('a', 64)
                FROM generate_series(?::int, ?::int) AS i`, [new Date(DATA_START).toISOString(), new Date(DATA_START).toISOString(), first, Math.min(first + 3_999, 49_999)]);
        }
        await ownerDb.raw("ANALYZE consultations");
    });
    afterAll(async () => { await truncateAll(); await closeDb(); });

    it("should use the doctor starts-at index for busy rows on a 50k consultation table", async () => {
        const from = DATA_START + 30 * 3_600_000;
        const statement = listBusyIntervalsQuery([1007], from, from + 14 * 86_400_000, db).toQuery();
        const result = await db.raw<{ rows: Array<{ "QUERY PLAN": string }> }>(`EXPLAIN ${statement}`);
        const plan = result.rows.map((row) => row["QUERY PLAN"]).join("\n");
        expect(plan).toMatch(/(?:Bitmap Index Scan|Index Scan) on idx_consultations_doctor_user_id_/);
        expect(plan).not.toMatch(/Seq Scan on consultations/);
    });

    it("should expose the exact indexed schedule statements without selecting clinical columns", () => {
        const queries = [listSlotHoursQuery([1], db), listSlotExceptionsQuery([1], "2026-10-01", "2026-10-31", db), listShortestTypesQuery([1], db)];
        for (const query of queries) {
            const sql = query.toSQL().sql;
            expect(sql).not.toContain("select *");
            expect(sql).toContain("doctor_profile_id");
            expect(sql).toContain("deleted_at");
        }
    });
});
