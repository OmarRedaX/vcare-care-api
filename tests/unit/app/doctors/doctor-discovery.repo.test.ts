// Rules covered: AV-R14 (Domain rule 6 spelled once), AV-R15 (filters bound as parameters), AV-R17 (keyset shapes), spec 2.1/12.2.5 (statement shapes).
import knex from "knex";
import { CandidateOrder } from "../../../../src/app/doctors/enums";
import {
    listBookableForIndexQuery, listCandidates, listCandidatesQuery, listLanguagesForProfiles, listLanguagesForProfilesQuery, listLinksForProfiles,
    listProfilesByUserIds, listProfilesByUserIdsQuery, pageCandidatesQuery,
} from "../../../../src/app/doctors/repository/doctor-discovery.repo";

const dry = knex({ client: "pg" });
afterAll(async () => { await dry.destroy(); });

const BOOKABLE = "dp.verification_status = 'approved' AND dp.identity_sync_status = 'synced' AND dp.suspended_at IS NULL AND dp.is_accepting_patients AND dp.deleted_at IS NULL";
const sqlOf = (query: { toSQL(): { sql: string; bindings: readonly unknown[] } }): { sql: string; bindings: readonly unknown[] } => query.toSQL();

describe("candidate statements", () => {
    it("should spell Domain rule 6 with constants exactly as the partial indexes do, plus the live active type term", () => {
        const { sql, bindings } = sqlOf(listCandidatesQuery({}, dry));
        expect(sql).toContain(BOOKABLE);
        expect(sql).toContain("EXISTS (SELECT 1 FROM consultation_types ct WHERE ct.doctor_profile_id = dp.id AND ct.is_active AND ct.deleted_at IS NULL)");
        expect(sql).toContain('"doctor_profiles" as "dp"');
        expect(bindings).toEqual([10_001]);
    });

    it("should select explicit narrow columns and never use select star", () => {
        const { sql } = sqlOf(listCandidatesQuery({}, dry));
        expect(sql).toMatch(/^select "dp"\."id", "dp"\."user_id", "dp"\."consultation_fee", "dp"\."years_experience" from/);
        expect(sql).not.toContain("*");
    });

    it("should cap the candidate read at 10 001 rows in a deterministic (fee, id) order", () => {
        const { sql, bindings } = sqlOf(listCandidatesQuery({}, dry));
        expect(sql).toContain("limit ?");
        expect(bindings.at(-1)).toBe(10_001);
        expect(sql).toContain('order by "dp"."consultation_fee" asc, "dp"."id" asc limit ?');
    });

    it("should bind every filter as a parameter, never interpolate it", () => {
        const { sql, bindings } = sqlOf(listCandidatesQuery({ specialty: "x'; DROP TABLE a;--", language: "ar", minFee: 10, maxFee: 500, namePrefix: "dr%" }, dry));
        expect(sql).not.toContain("DROP");
        expect(sql).not.toContain("dr%");
        expect(sql).toContain("dp.consultation_fee >= ?");
        expect(sql).toContain("dp.consultation_fee <= ?");
        expect(sql).toContain("s.slug = ?");
        expect(sql).toContain("dl.language_code = ?");
        expect(sql).toContain("starts_with(lower(dp.headline), ?)");
        expect(bindings).toEqual([10, 500, "x'; DROP TABLE a;--", "ar", "dr%", 10_001]);
    });

    it("should add no filter terms when the filters are empty", () => {
        const { sql } = sqlOf(listCandidatesQuery({}, dry));
        for (const term of ["consultation_fee >=", "consultation_fee <=", "slug", "language_code", "starts_with"]) expect(sql).not.toContain(term);
    });

    it("should map rows to candidates and flag truncation only above the hard cap", async () => {
        const rows = Array.from({ length: 10_001 }, (_, position) => ({ id: position + 1, user_id: position + 1001, consultation_fee: 100, years_experience: 3 }));
        const stub = (data: unknown[]) => {
            const builder = { select: () => builder, whereRaw: () => builder, orderBy: () => builder, limit: () => builder, then: (resolve: (value: unknown[]) => void) => resolve(data) };
            return (() => builder) as never;
        };
        expect((await listCandidates({}, stub(rows))).truncated).toBe(true);
        expect((await listCandidates({}, stub(rows))).items).toHaveLength(10_000);
        const small = await listCandidates({}, stub(rows.slice(0, 2)));
        expect(small).toEqual({ items: [{ profileId: 1, userId: 1001, fee: 100, years: 3 }, { profileId: 2, userId: 1002, fee: 100, years: 3 }], truncated: false });
    });
});

describe("keyset page statements (AV-R17)", () => {
    it("should page price order with a row comparison and the matching ORDER BY", () => {
        const { sql, bindings } = sqlOf(pageCandidatesQuery({}, { order: CandidateOrder.Price, after: { value: 200, id: 7 }, fetch: 21 }, dry));
        expect(sql).toContain("(dp.consultation_fee, dp.id) > (?, ?)");
        expect(sql).toContain('order by "dp"."consultation_fee" asc, "dp"."id" asc');
        expect(bindings).toEqual([200, 7, 21]);
    });

    it("should page experience order descending with a row comparison and the matching ORDER BY", () => {
        const { sql, bindings } = sqlOf(pageCandidatesQuery({}, { order: CandidateOrder.Experience, after: { value: 9, id: 7 }, fetch: 21 }, dry));
        expect(sql).toContain("(dp.years_experience, dp.id) < (?, ?)");
        expect(sql).toContain('order by "dp"."years_experience" desc, "dp"."id" desc');
        expect(bindings).toEqual([9, 7, 21]);
    });

    it("should omit the row comparison on the first page and keep the bookable predicate", () => {
        const first = sqlOf(pageCandidatesQuery({ minFee: 5 }, { order: CandidateOrder.Price, after: null, fetch: 21 }, dry));
        expect(first.sql).not.toContain("(dp.consultation_fee, dp.id)");
        expect(first.sql).toContain(BOOKABLE);
        expect(first.bindings).toEqual([5, 21]);
    });
});

describe("index and view statements", () => {
    it("should list every bookable doctor ordered by profile id with the same cap, and filter by user ids with ANY", () => {
        const all = sqlOf(listBookableForIndexQuery(undefined, dry));
        expect(all.sql).toContain(BOOKABLE);
        expect(all.sql).toContain('order by "dp"."id" asc');
        expect(all.sql).not.toContain("ANY");
        expect(all.bindings).toEqual([10_001]);
        const some = sqlOf(listBookableForIndexQuery([1001, 1002], dry));
        expect(some.sql).toContain("dp.user_id = ANY(?::bigint[])");
        expect(some.bindings).toEqual([[1001, 1002], 10_001]);
        expect(all.sql).toContain('"dp"."timezone"');
    });

    it("should load profiles, languages and links with one ANY statement each and soft-delete aware profiles", () => {
        const profiles = sqlOf(listProfilesByUserIdsQuery([1, 2], dry));
        expect(profiles.sql).toContain("user_id = ANY(?::bigint[])");
        expect(profiles.sql).toContain('"deleted_at" is null');
        expect(profiles.sql).not.toContain("*");
        expect(sqlOf(listLanguagesForProfilesQuery([1, 2], dry)).sql).toContain("doctor_profile_id = ANY(?::bigint[])");
    });

    it("should skip the database for an empty id list", async () => {
        const never = (() => { throw new Error("must not query"); }) as never;
        expect(await listProfilesByUserIds([], never)).toEqual([]);
        expect((await listLanguagesForProfiles([], never)).size).toBe(0);
        expect((await listLinksForProfiles([], never)).size).toBe(0);
    });
});
