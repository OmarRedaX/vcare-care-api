import request from "supertest";
import { decodeTimestampCursor, encodeCursor } from "../../src/lib/http/pagination/cursor";
import { db } from "../../src/lib/knex/knex";
import { buildTestApps } from "../helpers/app";
import { expectErrorEnvelope, expectPaginationMeta, expectSuccessEnvelope } from "../helpers/contract";
import { closeDb } from "../helpers/db";
import { closeRedis } from "../helpers/redis";
import { buildPaginationRouter } from "../helpers/test-routers";

/**
 * Keyset pagination helpers against a real Postgres query (no business table exists yet, so rows come from
 * generate_series with duplicate sort values to exercise the (sortValue, id) tiebreak).
 */
function appWith(total: number, options?: { order?: "asc" | "desc"; step?: "minute" | "microsecond" }) {
    return buildTestApps({ publicRouters: [{ path: "/api", router: buildPaginationRouter(total, options) }] }).publicApp;
}

type PageBody = { data: Array<{ id: number }>; meta: unknown };

async function page(app: ReturnType<typeof appWith>, query = "") {
    const res = await request(app).get(`/api/__test/page${query}`);
    expect(res.status).toBe(200);
    const data = expectSuccessEnvelope(res.body) as PageBody["data"];
    const meta = expectPaginationMeta((res.body as PageBody).meta);
    return { data, meta };
}

describe("cursor pagination helpers (integration: real Postgres)", () => {
    afterAll(async () => {
        await closeRedis();
        await closeDb();
    });

    it("should reach page 2 and the last page on the default sort and limit when more than one page exists", async () => {
        const app = appWith(45);

        const first = await page(app);
        expect(first.data).toHaveLength(20);
        expect(first.meta).toMatchObject({ hasMore: true, count: 20 });
        expect(first.data[0]?.id).toBe(45);

        const second = await page(app, `?cursor=${first.meta.nextCursor ?? ""}`);
        expect(second.data).toHaveLength(20);
        expect(second.meta).toMatchObject({ hasMore: true, count: 20 });

        const third = await page(app, `?cursor=${second.meta.nextCursor ?? ""}`);
        expect(third.meta).toEqual({ nextCursor: null, hasMore: false, count: 5 });

        const ids = [...first.data, ...second.data, ...third.data].map((row) => row.id);
        expect(ids).toEqual(Array.from({ length: 45 }, (_value, index) => 45 - index));
    });

    it("should report hasMore false and a null cursor exactly at the boundary when rows equal limit multiples", async () => {
        const app = appWith(40);
        const first = await page(app);
        expect(first.meta.hasMore).toBe(true);
        const second = await page(app, `?cursor=${first.meta.nextCursor ?? ""}`);
        expect(second.meta).toEqual({ nextCursor: null, hasMore: false, count: 20 });
    });

    it("should honour an explicit limit when provided", async () => {
        const app = appWith(5);
        const first = await page(app, "?limit=2");
        expect(first.data.map((row) => row.id)).toEqual([5, 4]);
        const second = await page(app, `?limit=2&cursor=${first.meta.nextCursor ?? ""}`);
        expect(second.data.map((row) => row.id)).toEqual([3, 2]);
        const third = await page(app, `?limit=2&cursor=${second.meta.nextCursor ?? ""}`);
        expect(third.data.map((row) => row.id)).toEqual([1]);
        expect(third.meta.hasMore).toBe(false);
    });

    it("should return an empty page when there are no rows", async () => {
        const app = appWith(0);
        expect(await page(app)).toEqual({ data: [], meta: { nextCursor: null, hasMore: false, count: 0 } });
    });

    it.each(["desc", "asc"] as const)("should page through rows within one millisecond without skips or repeats when order is %s", async (order) => {
        const app = appWith(30, { order, step: "microsecond" });
        const ids: number[] = [];
        let cursor: string | null = null;
        do {
            const result = await page(app, `?limit=7${cursor === null ? "" : `&cursor=${cursor}`}`);
            ids.push(...result.data.map((row) => row.id));
            cursor = result.meta.nextCursor;
        } while (cursor !== null);
        expect(ids).toEqual(Array.from({ length: 30 }, (_value, index) => order === "desc" ? 30 - index : index + 1));
    });

    it("should carry the stored six-digit timestamp of the last row when building nextCursor", async () => {
        const first = await page(appWith(30, { step: "microsecond" }), "?limit=7");
        const position = decodeTimestampCursor(first.meta.nextCursor ?? "");
        const lastId = first.data[6]?.id;
        expect(lastId).toBe(position.id);
        const result = await db.raw<{ rows: Array<{ stored: string }> }>(
            `SELECT to_char((TIMESTAMPTZ '2026-01-01T00:00:00Z' + (?::integer / 2) * INTERVAL '1 microsecond') AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stored`,
            [position.id],
        );
        expect(position.sortValue).toMatch(/^2026-01-01T00:00:00\.\d{6}Z$/);
        expect(position.sortValue).toBe(result.rows[0]?.stored);
    });

    it("should return 400 ValidationFailed with field cursor when the cursor is tampered", async () => {
        const app = appWith(5);
        for (const cursor of ["garbage!!", encodeCursor("2026-01-01T00:00:00.000Z", 1).slice(0, -3), encodeCursor("2026-01-01T00:00:00.000Z", 1), Buffer.from("[1,-1]").toString("base64url")]) {
            const res = await request(app).get(`/api/__test/page?cursor=${cursor}`);
            expect(res.status).toBe(400);
            expectErrorEnvelope(res.body, "ValidationFailed");
            expect(res.body.error.details).toEqual([{ field: "cursor", issue: "is invalid" }]);
        }
    });

    it.each(["0", "101", "abc"])("should return 400 ValidationFailed when limit is %p", async (limit) => {
        const res = await request(appWith(5)).get(`/api/__test/page?limit=${limit}`);
        expect(res.status).toBe(400);
        expectErrorEnvelope(res.body, "ValidationFailed");
        expect(res.body.error.details[0].field).toBe("limit");
    });

    it("should reject an unknown query filter when it is not whitelisted", async () => {
        const res = await request(appWith(5)).get("/api/__test/page?sort=name");
        expect(res.status).toBe(400);
        expect(res.body.error.details).toEqual([{ field: "sort", issue: "is not allowed" }]);
    });
});
