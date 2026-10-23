/**
 * availability discovery query plans (slice S2) — real Postgres with a seeded 20,000-profile table (2,500 bookable). The statements are the exact
 * exported `...Query` builders of `doctor-discovery.repo.ts` (what runs in production), planned with EXPLAIN after ANALYZE; the plans are written to
 * stderr as the evidence the spec asks for (the slot EXPLAIN suite does not write a file, so neither does this one).
 *
 * Rule map: AV-R14 (the candidate statement), AV-R15 (specialty and language filters use their indexes), AV-R17 (path A keyset: no Sort node),
 * spec 2.1 / 2.2 / 8 (partial bookable indexes, the EXISTS term on idx_consultation_types_doctor_profile_id_active, no Seq Scan beyond the bookable subset).
 */
import {
    listBookableForIndexQuery, listCandidatesQuery, listLanguagesForProfilesQuery, listLinksForProfilesQuery, listProfilesByUserIdsQuery, pageCandidatesQuery,
} from "../../src/app/doctors/repository/doctor-discovery.repo";
import { CandidateOrder } from "../../src/app/doctors/enums";
import type { CandidateFilters } from "../../src/app/doctors/types";
import { db } from "../../src/lib/knex/knex";
import { seedBulkDoctors, seedBulkSpecialties } from "../helpers/availability-seed";
import { closeDb, ownerDb, truncateAll } from "../helpers/db";

jest.setTimeout(300_000);

const TOTAL = 20_000;
const BOOKABLE_EVERY = 8; // 2,500 bookable
const FIRST_USER_ID = 1_000_000;
const CHUNK = 4_000;

async function plan(query: { toQuery(): string }, label: string): Promise<string> {
    const result = await db.raw<{ rows: Array<{ "QUERY PLAN": string }> }>(`EXPLAIN ${query.toQuery()}`);
    const text = result.rows.map((row) => row["QUERY PLAN"]).join("\n");
    process.stderr.write(`\n--- EXPLAIN ${label} ---\n${text}\n`);
    return text;
}

describe("availability discovery query plans (integration: real Postgres, 20k profiles, 2.5k bookable)", () => {
    beforeAll(async () => {
        await truncateAll();
        await seedBulkSpecialties();
        for (let offset = 0; offset < TOTAL; offset += CHUNK) {
            await seedBulkDoctors({ count: CHUNK, firstUserId: FIRST_USER_ID + offset, bookableEvery: BOOKABLE_EVERY, withHours: false });
        }
        // The bulk generator gives every doctor a second, inactive type so the EXISTS term has a realistic mix on a larger table.
        await ownerDb.raw(`INSERT INTO consultation_types (doctor_profile_id, name, duration_minutes, price, currency, is_active)
            SELECT id, 'Synthetic retired visit', 15, consultation_fee, 'EGP', false FROM doctor_profiles WHERE id % 2 = 0`);
        for (const table of ["doctor_profiles", "consultation_types", "doctor_languages", "doctor_specialties", "specialties"]) await ownerDb.raw(`ANALYZE ${table}`);
    });
    afterAll(async () => {
        await truncateAll();
        await closeDb();
    });

    it("should seed 20,000 profiles of which exactly 2,500 satisfy Domain rule 6", async () => {
        const counts = await ownerDb.raw<{ rows: Array<{ total: string; bookable: string }> }>(`SELECT count(*) AS total,
            count(*) FILTER (WHERE verification_status = 'approved' AND identity_sync_status = 'synced' AND suspended_at IS NULL AND is_accepting_patients AND deleted_at IS NULL
                AND EXISTS (SELECT 1 FROM consultation_types ct WHERE ct.doctor_profile_id = doctor_profiles.id AND ct.is_active AND ct.deleted_at IS NULL)) AS bookable
            FROM doctor_profiles`);
        expect(Number(counts.rows[0]!.total)).toBe(TOTAL);
        expect(Number(counts.rows[0]!.bookable)).toBe(TOTAL / BOOKABLE_EVERY);
    });

    describe("path A keyset pages", () => {
        it("should walk idx_doctor_profiles_bookable_fee_id with no Sort node for the first price page", async () => {
            const text = await plan(pageCandidatesQuery({}, { order: CandidateOrder.Price, after: null, fetch: 21 }, db), "price page 1");
            expect(text).toContain("idx_doctor_profiles_bookable_fee_id");
            expect(text).not.toMatch(/\bSort\b/);
            expect(text).not.toMatch(/Seq Scan on doctor_profiles/);
        });

        it("should walk idx_doctor_profiles_bookable_fee_id with no Sort node for a later price page", async () => {
            const text = await plan(pageCandidatesQuery({}, { order: CandidateOrder.Price, after: { value: 500, id: 8_000 }, fetch: 21 }, db), "price page n");
            expect(text).toContain("idx_doctor_profiles_bookable_fee_id");
            expect(text).not.toMatch(/\bSort\b/);
            expect(text).not.toMatch(/Seq Scan on doctor_profiles/);
        });

        it("should walk idx_doctor_profiles_bookable_experience_id with no Sort node for experience pages", async () => {
            for (const after of [null, { value: 20, id: 8_000 }]) {
                const text = await plan(pageCandidatesQuery({}, { order: CandidateOrder.Experience, after, fetch: 21 }, db), `experience page ${after === null ? "1" : "n"}`);
                expect(text).toContain("idx_doctor_profiles_bookable_experience_id");
                expect(text).not.toMatch(/\bSort\b/);
                expect(text).not.toMatch(/Seq Scan on doctor_profiles/);
            }
        });

        it("should keep the keyset index and no Sort node when a fee range and a language filter are added", async () => {
            const text = await plan(pageCandidatesQuery({ minFee: 200, maxFee: 900, language: "en" }, { order: CandidateOrder.Price, after: { value: 300, id: 10 }, fetch: 21 }, db), "price page with fee range and language");
            expect(text).toContain("idx_doctor_profiles_bookable_fee_id");
            expect(text).not.toMatch(/\bSort\b/);
            expect(text).not.toMatch(/Seq Scan on doctor_profiles/);
        });
    });

    describe("path B candidate scans", () => {
        it("should read the unfiltered candidate set from a bookable partial index and never scan the whole table", async () => {
            const text = await plan(listCandidatesQuery({}, db), "candidates (unfiltered)");
            expect(text).toMatch(/idx_doctor_profiles_bookable_(fee_id|experience_id)/);
            expect(text).not.toMatch(/Seq Scan on doctor_profiles/);
        });

        it("should use idx_consultation_types_doctor_profile_id_active for the active type term whenever the planner probes per doctor", async () => {
            // Keyset pages and selective filters probe per candidate: the partial index answers the EXISTS term with an index-only scan.
            for (const [label, query] of [
                ["price page", pageCandidatesQuery({}, { order: CandidateOrder.Price, after: null, fetch: 21 }, db)],
                ["experience page", pageCandidatesQuery({}, { order: CandidateOrder.Experience, after: null, fetch: 21 }, db)],
                ["language fr", listCandidatesQuery({ language: "fr" }, db)],
                ["specialty", listCandidatesQuery({ specialty: "spec-3" }, db)],
            ] as const) {
                const text = await plan(query, `active type term (${label})`);
                expect(text).toContain("idx_consultation_types_doctor_profile_id_active");
                expect(text).not.toMatch(/Seq Scan on consultation_types/);
            }
        });

        it("should run the unfiltered candidate scan in a few milliseconds even though the planner hashes the whole active-type set", async () => {
            // Planner choice, not an index miss: with ~87 % of the 20k types active (and ~7.7k estimated candidates for LIMIT 10001) a single scan of the
            // partial set plus a hash semi join is cheaper than thousands of probes, so the EXISTS term does not use the index here. Recorded as evidence.
            const result = await db.raw<{ rows: Array<{ "QUERY PLAN": string }> }>(`EXPLAIN (ANALYZE, BUFFERS) ${listCandidatesQuery({}, db).toQuery()}`);
            const text = result.rows.map((row) => row["QUERY PLAN"]).join("\n");
            process.stderr.write(`\n--- EXPLAIN ANALYZE candidates (unfiltered) ---\n${text}\n`);
            expect(text).not.toMatch(/Seq Scan on doctor_profiles/);
            const execution = Number(/Execution Time: ([\d.]+) ms/.exec(text)?.[1]);
            expect(execution).toBeLessThan(250);
        });

        it("should use idx_doctor_languages_language_code_doctor_profile_id for a selective language filter", async () => {
            const text = await plan(listCandidatesQuery({ language: "fr" }, db), "candidates (language fr)");
            expect(text).toContain("idx_doctor_languages_language_code_doctor_profile_id");
            expect(text).not.toMatch(/Seq Scan on doctor_profiles/);
            expect(text).not.toMatch(/Seq Scan on doctor_languages/);
        });

        it("should use the specialty indexes for a specialty filter", async () => {
            const text = await plan(listCandidatesQuery({ specialty: "spec-3" }, db), "candidates (specialty spec-3)");
            // The slug lookup reads the 10-row specialties table directly (uq_specialties_slug is the index for a larger catalog).
            expect(text).toContain("idx_doctor_specialties_specialty_id_doctor_profile_id");
            expect(text).not.toMatch(/Seq Scan on doctor_specialties/);
            expect(text).not.toMatch(/Seq Scan on doctor_profiles/);
        });

        it("should keep every filter combination out of a doctor_profiles Seq Scan", async () => {
            const combos: CandidateFilters[] = [{ minFee: 300, maxFee: 400 }, { specialty: "spec-1", language: "en" }, { specialty: "spec-1", maxFee: 300 }, { language: "ar", minFee: 800 }, { namePrefix: "synthetic bulk doctor 1" }];
            for (const filters of combos) {
                const text = await plan(listCandidatesQuery(filters, db), `candidates ${JSON.stringify(filters)}`);
                expect(text).not.toMatch(/Seq Scan on doctor_profiles/);
            }
        });
    });

    describe("sweep, refresh and page views", () => {
        it("should list the bookable doctors from a bookable partial index for the sweep", async () => {
            const text = await plan(listBookableForIndexQuery(undefined, db), "sweep list");
            expect(text).not.toMatch(/Seq Scan on doctor_profiles/);
        });

        it("should look doctors up by user id through uq_doctor_profiles_user_id for refresh and inline computation", async () => {
            const ids = Array.from({ length: 50 }, (_, i) => FIRST_USER_ID + i * 8);
            const refresh = await plan(listBookableForIndexQuery(ids, db), "refresh batch (ANY user_id)");
            expect(refresh).toContain("uq_doctor_profiles_user_id");
            const views = await plan(listProfilesByUserIdsQuery(ids.slice(0, 20), db), "page view profiles");
            expect(views).toContain("uq_doctor_profiles_user_id");
        });

        it("should load page languages and specialty links through their indexes", async () => {
            const profileIds = Array.from({ length: 20 }, (_, i) => 1 + i * 8);
            const languages = await plan(listLanguagesForProfilesQuery(profileIds, db), "page view languages");
            expect(languages).not.toMatch(/Seq Scan on doctor_languages/);
            const links = await plan(listLinksForProfilesQuery(profileIds, db), "page view specialty links");
            expect(links).not.toMatch(/Seq Scan on doctor_specialties/);
        });
    });
});
