import { randomUUID } from "node:crypto";
import type { Express } from "express";
import request from "supertest";
import type { Response } from "supertest";
import { AuditController } from "../../src/app/audit/controller/audit.controller";
import { listAuditLogsQuery } from "../../src/app/audit/repository/audit.repo";
import { AuditService } from "../../src/app/audit/service/audit.service";
import type { ListAuditLogsParams } from "../../src/app/audit/types";
import type { AuditRecorder } from "../../src/lib/audit/audit";
import { getEnv } from "../../src/lib/config/env";
import { container } from "../../src/lib/di/container";
import { TOKENS } from "../../src/lib/di/tokens";
import { encodeSignedCursor } from "../../src/lib/http/pagination/signed-cursor";
import { db } from "../../src/lib/knex/knex";
import { logger } from "../../src/lib/logger/logger";
import { buildTestApps } from "../helpers/app";
import {
    contractNoStoreValue, contractOperationBlock, contractResponseCodes, expectErrorEnvelope, expectPaginationMeta, expectSuccessEnvelope,
    inlineLists, schemaBlock,
} from "../helpers/contract";
import { closeDb, ownerDb, truncateAll } from "../helpers/db";
import { FakeClock } from "../helpers/fake-clock";
import { buildFakeJwksWiring, startFakeJwks } from "../helpers/fake-jwks";
import { captureLogs, expectNoSensitiveStrings } from "../helpers/log-capture";
import { closeRedis, ensureRedisReady, flushByPrefix } from "../helpers/redis";
import { signExpiredUserToken, signUserToken, tamperToken } from "../helpers/tokens";
import type { FakeJwks, FakeJwksWiring } from "../helpers/types";

jest.setTimeout(60_000);

const NOW = Date.parse("2026-04-15T12:00:00.000Z");
const ADMIN = 303;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_PATH = "/api/audit-logs";
const SECRET = getEnv().SERVICE_CLIENT_SECRET;

type Actor = "admin" | "admin2" | "adminSuspended" | "adminPending" | "doctor" | "doctorPending" | "patient" | "expired" | "tampered";

/** Months of 2026 the suite owns as partitions: far before the real current month, so the migration-created ones never overlap. */
const TEST_MONTHS = [1, 2, 3, 4, 5];
const pad = (value: number): string => String(value).padStart(2, "0");
const partitionOf = (month: number): string => `audit_logs_y2026m${pad(month)}`;

interface SeedRow {
    id: number;
    at: string;
    actor?: number | null;
    role?: string;
    action?: string;
    entityType?: string;
    entityId?: number;
    requestId?: string | null;
    metadata?: Record<string, unknown>;
}

interface Entry {
    id: number; actorUserId: number | null; actorRole: string; action: string; entityType: string; entityId: number;
    requestId: string | null; metadata: Record<string, unknown>; createdAt: string;
}

/** Seeds as the OWNER: the app role cannot set `created_at` or `id`. */
async function seed(rows: SeedRow[]): Promise<void> {
    for (const row of rows) {
        const actor = row.actor === undefined ? ADMIN : row.actor;
        await ownerDb("audit_logs").insert({
            id: row.id,
            actor_user_id: actor,
            actor_role: row.role ?? (actor === null ? "system" : "admin"),
            action: row.action ?? "test.performed",
            entity_type: row.entityType ?? "test_entity",
            entity_id: row.entityId ?? 1,
            request_id: row.requestId ?? null,
            metadata: ownerDb.raw("?::jsonb", [JSON.stringify(row.metadata ?? {})]),
            created_at: ownerDb.raw("?::timestamptz", [row.at]),
        });
    }
}

/** `n` rows with ids 1..n, one second apart from 2026-04-10 10:00:00Z (all inside the default window). */
async function seedMany(count: number): Promise<void> {
    await ownerDb.raw(
        `INSERT INTO audit_logs (id, actor_user_id, actor_role, action, entity_type, entity_id, request_id, metadata, created_at)
         SELECT g, 303, 'admin', 'test.performed', 'test_entity', 1, NULL, '{}'::jsonb, '2026-04-10 10:00:00+00'::timestamptz + (g * interval '1 second')
         FROM generate_series(1, ?::int) AS g`,
        [count],
    );
}

const ids = (res: Response): number[] => (res.body.data as Entry[]).map((entry) => entry.id);
const decodeCursor = (cursor: string | null): Record<string, unknown> =>
    JSON.parse(Buffer.from((cursor ?? "").split(".")[0] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;

async function auditCount(): Promise<number> {
    return Number((await ownerDb("audit_logs").count<Array<{ count: string }>>("* as count"))[0]?.count);
}

describe("audit read: GET /api/audit-logs (integration: real routes, Postgres as care_app, Redis)", () => {
    let fake: FakeJwks;
    let wiring: FakeJwksWiring;
    let app: Express;
    const clock = new FakeClock(NOW);
    const tokens = {} as Record<Actor, string>;
    const previous: Array<{ token: symbol; value: unknown }> = [];
    const createdPartitions: string[] = [];

    async function get(url: string, actor: Actor | null = "admin", headers: Record<string, string> = {}): Promise<Response> {
        let test = request(app).get(url).set(headers);
        if (actor !== null) test = test.set("Authorization", `Bearer ${tokens[actor]}`);
        return test;
    }

    /** Follows `nextCursor` until `hasMore` is false; asserts the last page ends the chain. */
    async function walk(url: string, actor: Actor = "admin"): Promise<{ all: number[]; pages: Response[] }> {
        const pages: Response[] = [];
        const all: number[] = [];
        let cursor: string | null = null;
        for (let index = 0; index < 60; index += 1) {
            const target: string = cursor === null ? url : `${url}${url.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;
            const res = await get(target, actor);
            expect(res.status).toBe(200);
            pages.push(res);
            all.push(...ids(res));
            if (!res.body.meta.hasMore) {
                expect(res.body.meta.nextCursor).toBeNull();
                return { all, pages };
            }
            cursor = res.body.meta.nextCursor as string;
        }
        throw new Error("pagination did not terminate");
    }

    /** Statements the app pool sends while `fn` runs. */
    async function statements(fn: () => Promise<unknown>): Promise<string[]> {
        const sqls: string[] = [];
        const listener = (query: { sql: string }): void => { sqls.push(query.sql); };
        db.on("query", listener);
        try { await fn(); } finally { db.removeListener("query", listener); }
        return sqls;
    }

    beforeAll(async () => {
        await ensureRedisReady();
        await truncateAll();
        for (const month of TEST_MONTHS) {
            const name = partitionOf(month);
            const exists = await ownerDb.raw<{ rows: Array<{ oid: string | null }> }>("SELECT to_regclass(?)::text AS oid", [`public.${name}`]);
            if (exists.rows[0]?.oid !== null) continue;
            await ownerDb.raw(
                `CREATE TABLE public.${name} PARTITION OF public.audit_logs FOR VALUES FROM ('2026-${pad(month)}-01 00:00:00+00') TO ('${month === 12 ? "2027-01" : `2026-${pad(month + 1)}`}-01 00:00:00+00')`,
            );
            await ownerDb.raw(`GRANT SELECT ON public.${name} TO vcare_app`);
            createdPartitions.push(name);
        }
        fake = await startFakeJwks(["audit-read"]);
        wiring = await buildFakeJwksWiring(fake);
        for (const token of [TOKENS.JwksCache, TOKENS.UserTokenVerifier, TOKENS.AuditClock, TOKENS.AuditService, TOKENS.AuditController]) {
            previous.push({ token, value: container.isRegistered(token) ? container.resolve(token) : undefined });
        }
        container.registerInstance(TOKENS.JwksCache, wiring.cache);
        container.registerInstance(TOKENS.UserTokenVerifier, wiring.verifier);
        container.registerInstance(TOKENS.AuditClock, clock);
        // Singletons created at boot hold the boot-time clock: rebuild them on the injected one.
        container.registerSingleton(TOKENS.AuditService, AuditService);
        container.registerSingleton(TOKENS.AuditController, AuditController);
        app = buildTestApps().publicApp;
        const claims: Array<[Actor, string, "admin" | "doctor" | "patient", "active" | "pending" | "suspended"]> = [
            ["admin", String(ADMIN), "admin", "active"], ["admin2", "304", "admin", "active"], ["adminSuspended", String(ADMIN), "admin", "suspended"],
            ["adminPending", String(ADMIN), "admin", "pending"], ["doctor", "202", "doctor", "active"], ["doctorPending", "202", "doctor", "pending"],
            ["patient", "101", "patient", "active"],
        ];
        for (const [name, sub, role, status] of claims) tokens[name] = await signUserToken(fake.key("audit-read"), { sub, role, status });
        tokens.expired = await signExpiredUserToken(fake.key("audit-read"), { sub: String(ADMIN), role: "admin", status: "active" });
        tokens.tampered = tamperToken(tokens.admin);
    });

    beforeEach(async () => {
        await truncateAll();
        await flushByPrefix(["rl:", "idem:"]);
        clock.set(NOW);
    });

    afterEach(async () => {
        const stray = await ownerDb("audit_logs_default").count<Array<{ count: string }>>("* as count");
        expect(Number(stray[0]?.count)).toBe(0); // no seeded row may land in the catch-all partition
    });

    afterAll(async () => {
        await truncateAll();
        await flushByPrefix(["rl:", "idem:"]);
        for (const name of createdPartitions) await ownerDb.raw(`DROP TABLE IF EXISTS public.${name}`);
        for (const entry of previous) if (entry.value !== undefined) container.registerInstance(entry.token, entry.value);
        wiring.cache.stop();
        await fake.close();
        await closeRedis();
        await closeDb();
    });

    // ------------------------------------------------------------------------------------------------ RBAC
    describe("RBAC", () => {
        it("should return 200 when an active admin calls it", async () => {
            await seed([{ id: 1, at: "2026-04-10 10:00:00+00" }]);
            const res = await get(URL_PATH);
            expect(res.status).toBe(200);
            expect(ids(res)).toEqual([1]);
        });

        it.each([
            ["patient", "patient", 403, "Forbidden"],
            ["active doctor", "doctor", 403, "Forbidden"],
            ["pending doctor", "doctorPending", 403, "Forbidden"],
            ["admin with a suspended token", "adminSuspended", 403, "Forbidden"],
            ["admin with a pending token", "adminPending", 403, "Forbidden"],
            ["expired token", "expired", 401, "TokenExpired"],
            ["tampered token", "tampered", 401, "Unauthorized"],
        ] as const)("should return %s -> %s %s and read no row", async (_label, actor, status, code) => {
            await seed([{ id: 1, at: "2026-04-10 10:00:00+00" }]);
            let res: Response | undefined;
            const sqls = await statements(async () => { res = await get(URL_PATH, actor); });
            expect(res?.status).toBe(status);
            expectErrorEnvelope(res?.body, code);
            expect(JSON.stringify(res?.body)).not.toContain("test.performed");
            expect(sqls.filter((sql) => sql.includes("audit_logs"))).toEqual([]);
        });

        it("should return 401 Unauthorized without a token and read no row", async () => {
            await seed([{ id: 1, at: "2026-04-10 10:00:00+00" }]);
            let res: Response | undefined;
            const sqls = await statements(async () => { res = await get(URL_PATH, null); });
            expect(res?.status).toBe(401);
            expectErrorEnvelope(res?.body, "Unauthorized");
            expect(sqls).toEqual([]);
        });

        it("should deny a non-admin even when it sends valid filters or a valid cursor", async () => {
            await seed([{ id: 1, at: "2026-04-10 10:00:00+00" }, { id: 2, at: "2026-04-10 10:00:01+00" }]);
            const cursor = (await get(`${URL_PATH}?limit=1`)).body.meta.nextCursor as string;
            for (const actor of ["patient", "doctor"] as const) {
                const res = await get(`${URL_PATH}?actorUserId=${ADMIN}&limit=1&cursor=${encodeURIComponent(cursor)}`, actor);
                expect(res.status).toBe(403);
            }
        });
    });

    // ------------------------------------------------------------------------------------------------ rules
    describe("ordering and keyset pagination (R1, R7)", () => {
        it("should return rows newest first and break created_at ties by id descending", async () => {
            await seed([
                { id: 5, at: "2026-04-10 10:00:00.500000+00" },
                { id: 9, at: "2026-04-10 10:00:00.500000+00" },
                { id: 2, at: "2026-04-10 10:00:00.500000+00" },
                { id: 1, at: "2026-04-10 10:00:01+00" },
                { id: 20, at: "2026-04-10 09:59:59+00" },
            ]);
            expect(ids(await get(URL_PATH))).toEqual([1, 9, 5, 2, 20]);
        });

        it("should return the next rows with no duplicate and no gap on page 2 of the default sort when five rows share one created_at", async () => {
            const tie = "2026-04-15 11:59:59.123456+00";
            await seed([
                { id: 4, at: tie }, { id: 7, at: tie }, { id: 9, at: tie }, { id: 2, at: tie }, { id: 5, at: tie },
                { id: 1, at: "2026-04-15 11:59:59.999999+00" }, { id: 20, at: "2026-04-15 11:00:00+00" },
            ]);
            const { all, pages } = await walk(`${URL_PATH}?limit=2`);
            expect(all).toEqual([1, 9, 7, 5, 4, 2, 20]);
            expect(pages.map((page) => ids(page))).toEqual([[1, 9], [7, 5], [4, 2], [20]]);
            expect(pages.map((page) => page.body.meta.hasMore)).toEqual([true, true, true, false]);
            expect(pages.map((page) => page.body.meta.count)).toEqual([2, 2, 2, 1]);
            for (const page of pages) expectPaginationMeta(page.body.meta);
        });

        it("should not skip or repeat rows whose created_at differ only in microseconds", async () => {
            // Ids run opposite to time: a cursor truncated to milliseconds would skip or repeat rows here.
            await seed([
                { id: 30, at: "2026-04-15 11:59:59.123100+00" },
                { id: 20, at: "2026-04-15 11:59:59.123500+00" },
                { id: 10, at: "2026-04-15 11:59:59.123900+00" },
                { id: 40, at: "2026-04-15 11:59:59.122999+00" },
            ]);
            const { all } = await walk(`${URL_PATH}?limit=1`);
            expect(all).toEqual([10, 20, 30, 40]);
            const first = await get(`${URL_PATH}?limit=1`);
            expect(decodeCursor(first.body.meta.nextCursor).t).toBe("2026-04-15T11:59:59.123900Z");
        });

        it("should report hasMore false and no cursor when the row count equals the limit exactly", async () => {
            await seedMany(3);
            const res = await get(`${URL_PATH}?limit=3`);
            expect(res.body.meta).toEqual({ nextCursor: null, hasMore: false, count: 3 });
        });

        it("should report hasMore true with a cursor when one row more than the limit exists, and count never exceeds the limit", async () => {
            await seedMany(4);
            const res = await get(`${URL_PATH}?limit=3`);
            expect(res.body.meta.hasMore).toBe(true);
            expect(typeof res.body.meta.nextCursor).toBe("string");
            expect(res.body.meta.count).toBe(3);
            expect(ids(res)).toEqual([4, 3, 2]);
        });

        it("should return an empty page with data [] when nothing matches", async () => {
            const res = await get(URL_PATH);
            expect(res.status).toBe(200);
            expect(res.body.data).toEqual([]);
            expect(res.body.meta).toEqual({ nextCursor: null, hasMore: false, count: 0 });
        });
    });

    describe("limit bounds (R8)", () => {
        it.each(["0", "101", "-1", "1.5", "abc", "", "1e1", "05"])("should return 400 for limit=%p", async (limit) => {
            const res = await get(`${URL_PATH}?limit=${limit}`);
            expect(res.status).toBe(400);
            expectErrorEnvelope(res.body, "ValidationFailed");
            expect(res.body.error.details.map((detail: { field: string }) => detail.field)).toContain("limit");
        });

        it("should default to 20 and accept 1 and 100", async () => {
            await seedMany(101);
            const dflt = await get(URL_PATH);
            expect(dflt.body.meta).toMatchObject({ count: 20, hasMore: true });
            expect(dflt.body.data).toHaveLength(20);
            expect((await get(`${URL_PATH}?limit=1`)).body.data).toHaveLength(1);
            const max = await get(`${URL_PATH}?limit=100`);
            expect(max.body.data).toHaveLength(100);
            expect(max.body.meta).toMatchObject({ count: 100, hasMore: true });
        });
    });

    describe("window (R2, R3, R6)", () => {
        it("should include a row at exactly from and exclude a row at exactly to", async () => {
            await seed([
                { id: 1, at: "2026-04-10 09:59:59.999999+00" },
                { id: 2, at: "2026-04-10 10:00:00+00" },
                { id: 3, at: "2026-04-10 11:59:59.999999+00" },
                { id: 4, at: "2026-04-10 12:00:00+00" },
            ]);
            const res = await get(`${URL_PATH}?from=2026-04-10T10:00:00Z&to=2026-04-10T12:00:00Z`);
            expect(ids(res)).toEqual([3, 2]);
        });

        it("should default to the last 30 days of the injected clock", async () => {
            await seed([
                { id: 1, at: "2026-03-16 11:59:59.999+00" }, // NOW - 30d - 1ms: out
                { id: 2, at: "2026-03-16 12:00:00+00" }, // NOW - 30d: in (from is inclusive)
                { id: 3, at: "2026-03-16 12:00:00.001+00" }, // NOW - 30d + 1ms: in
                { id: 4, at: "2026-04-15 11:59:59.999+00" }, // NOW - 1ms: in
                { id: 5, at: "2026-04-15 12:00:00+00" }, // NOW: out (to is exclusive)
            ]);
            expect(ids(await get(URL_PATH))).toEqual([4, 3, 2]);
        });

        it("should move the default window with the clock", async () => {
            await seed([{ id: 1, at: "2026-04-10 10:00:00+00" }]);
            expect(ids(await get(URL_PATH))).toEqual([1]);
            clock.set(Date.parse("2026-06-15T12:00:00.000Z"));
            expect(ids(await get(URL_PATH))).toEqual([]);
        });

        it("should apply the 30-day default to from when only to is given", async () => {
            await seed([{ id: 1, at: "2026-03-01 10:00:00+00" }, { id: 2, at: "2026-03-20 10:00:00+00" }, { id: 3, at: "2026-04-10 10:00:00+00" }]);
            expect(ids(await get(`${URL_PATH}?to=2026-04-01T00:00:00Z`))).toEqual([2]);
        });

        it("should return 400 on the field from when from is later than to", async () => {
            await seedMany(2);
            const res = await get(`${URL_PATH}?from=2026-04-02T00:00:00Z&to=2026-04-01T00:00:00Z`);
            expect(res.status).toBe(400);
            expectErrorEnvelope(res.body, "ValidationFailed");
            expect(res.body.error.details).toEqual([{ field: "from", issue: "must not be later than to" }]);
        });

        it("should return 400 on the field from when only from is given and is later than the clock", async () => {
            const res = await get(`${URL_PATH}?from=2026-04-15T12:00:00.001Z`);
            expect(res.status).toBe(400);
            expect(res.body.error.details).toEqual([{ field: "from", issue: "must not be later than to" }]);
        });

        it("should return an empty page and run no SQL when from equals to", async () => {
            await seedMany(3);
            let res: Response | undefined;
            const sqls = await statements(async () => { res = await get(`${URL_PATH}?from=2026-04-10T10:00:00Z&to=2026-04-10T12:00:00%2B02:00`); });
            expect(res?.status).toBe(200);
            expect(res?.body.data).toEqual([]);
            expect(res?.body.meta).toEqual({ nextCursor: null, hasMore: false, count: 0 });
            expect(sqls.filter((sql) => sql.includes("audit_logs"))).toEqual([]);
        });

        it("should treat Z, +02:00, %2B02:00 and -08:00 offsets as the same instants", async () => {
            await seed([{ id: 1, at: "2026-04-10 09:59:59.999+00" }, { id: 2, at: "2026-04-10 10:00:00+00" }, { id: 3, at: "2026-04-10 11:59:59.999+00" }, { id: 4, at: "2026-04-10 12:00:00+00" }]);
            const variants = [
                "from=2026-04-10T10:00:00Z&to=2026-04-10T12:00:00Z",
                "from=2026-04-10T12:00:00%2B02:00&to=2026-04-10T14:00:00%2B02:00",
                "from=2026-04-10T02:00:00-08:00&to=2026-04-10T04:00:00-08:00",
                "from=2026-04-10T10:00:00.0000009Z&to=2026-04-10T12:00:00.000Z",
            ];
            for (const query of variants) {
                const res = await get(`${URL_PATH}?${query}`);
                expect(res.status).toBe(200);
                expect(ids(res)).toEqual([3, 2]);
            }
        });

        it("should return 400 for a raw plus offset because it decodes to a space, without echoing the value", async () => {
            const res = await get(`${URL_PATH}?from=2026-04-10T12:00:00+02:00`);
            expect(res.status).toBe(400);
            expectErrorEnvelope(res.body, "ValidationFailed");
            expect(res.body.error.details).toEqual([{ field: "from", issue: "must be an ISO-8601 date-time with a UTC offset" }]);
            expect(JSON.stringify(res.body)).not.toContain("2026-04-10");
        });

        it.each([
            ["from", "2026-04-10"],
            ["to", "2026-04-10T10:00:00"],
            ["from", "2026-04-10T10:00:00%2B0200"],
            ["to", "2026-04-10t10:00:00z"],
            ["from", "1776254400"],
            ["to", "2026-02-30T00:00:00Z"],
            ["from", "0000-01-01T00:00:00Z"],
            ["to", "10000-01-01T00:00:00Z"],
        ])("should return 400 on the field %s for the value %p", async (field, value) => {
            const res = await get(`${URL_PATH}?${field}=${value}`);
            expect(res.status).toBe(400);
            expect(res.body.error.details).toEqual([{ field, issue: "must be an ISO-8601 date-time with a UTC offset" }]);
        });

        it("should accept an explicit 1970..9999 window and still page correctly (no span cap)", async () => {
            await seed([{ id: 1, at: "2026-02-10 10:00:00+00" }, { id: 2, at: "2026-03-10 10:00:00+00" }, { id: 3, at: "2026-04-10 10:00:00+00" }]);
            const { all, pages } = await walk(`${URL_PATH}?from=1970-01-01T00:00:00Z&to=9999-12-31T23:59:59Z&limit=2`);
            expect(all).toEqual([3, 2, 1]);
            expect(pages).toHaveLength(2);
            expect(decodeCursor(pages[0]?.body.meta.nextCursor).to).toBe("9999-12-31T23:59:59.000Z");
        });
    });

    describe("frozen window (R4)", () => {
        it("should keep page 2 stable when the clock advances and a new row is inserted between the pages", async () => {
            await seed([{ id: 1, at: "2026-04-15 09:00:00+00" }, { id: 2, at: "2026-04-15 10:00:00+00" }, { id: 3, at: "2026-04-15 11:00:00+00" }]);
            const first = await get(`${URL_PATH}?limit=1`);
            expect(ids(first)).toEqual([3]);
            clock.advance(60 * 60 * 1000);
            await seed([{ id: 4, at: "2026-04-15 12:30:00+00" }]); // inside an UNFROZEN window [.., 13:00), outside the frozen [.., 12:00)
            const second = await get(`${URL_PATH}?limit=1&cursor=${encodeURIComponent(first.body.meta.nextCursor)}`);
            expect(ids(second)).toEqual([2]);
            const third = await get(`${URL_PATH}?limit=1&cursor=${encodeURIComponent(second.body.meta.nextCursor)}`);
            expect(ids(third)).toEqual([1]);
            expect(third.body.meta).toEqual({ nextCursor: null, hasMore: false, count: 1 });
            const fresh = await get(URL_PATH);
            expect(ids(fresh)).toEqual([4, 3, 2, 1]);
        });

        it("should put the page-1 effective to into the nextCursor payload", async () => {
            await seedMany(3);
            const res = await get(`${URL_PATH}?limit=1`);
            expect(decodeCursor(res.body.meta.nextCursor)).toEqual({ t: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/), id: 3, from: "2026-03-16T12:00:00.000Z", to: "2026-04-15T12:00:00.000Z" });
            const explicit = await get(`${URL_PATH}?limit=1&to=2026-04-15T14:00:00.9999%2B02:00`);
            expect(decodeCursor(explicit.body.meta.nextCursor).to).toBe("2026-04-15T12:00:00.999Z");
        });

        it("should keep an explicit from (90 days back) on page 2 and 3 when only the cursor is sent", async () => {
            await seed([{ id: 1, at: "2026-02-14 12:00:00+00" }, { id: 2, at: "2026-02-20 12:00:00+00" }, { id: 3, at: "2026-04-10 12:00:00+00" }]);
            const first = await get(`${URL_PATH}?limit=1&from=2026-01-15T12:00:00Z`);
            expect(ids(first)).toEqual([3]);
            const second = await get(`${URL_PATH}?limit=1&cursor=${encodeURIComponent(first.body.meta.nextCursor)}`);
            expect(ids(second)).toEqual([2]);
            const third = await get(`${URL_PATH}?limit=1&cursor=${encodeURIComponent(second.body.meta.nextCursor)}`);
            expect(ids(third)).toEqual([1]); // 60 days old: outside the default 30 days, inside the frozen window
            expect(third.body.meta.hasMore).toBe(false);
        });

        it("should report a bad cursor with the other cross-field problems, sorted by field", async () => {
            const res = await get(`${URL_PATH}?cursor=bad.cursor&entityId=5&from=2026-04-02T00:00:00Z&to=2026-04-01T00:00:00Z`);
            expect(res.status).toBe(400);
            expect(res.body.error.details).toEqual([
                { field: "cursor", issue: "is invalid" }, { field: "entityType", issue: "is required when entityId is given" }, { field: "from", issue: "must not be later than to" }]);
        });

        it("should let an explicit to on a later page override the frozen one", async () => {
            await seed([{ id: 1, at: "2026-04-15 09:00:00+00" }, { id: 2, at: "2026-04-15 10:00:00+00" }, { id: 3, at: "2026-04-15 11:00:00+00" }]);
            const first = await get(`${URL_PATH}?limit=1`);
            const second = await get(`${URL_PATH}?limit=5&to=2026-04-15T09:30:00Z&cursor=${encodeURIComponent(first.body.meta.nextCursor)}`);
            expect(ids(second)).toEqual([1]);
        });
    });

    describe("entityId requires entityType (R5)", () => {
        it("should return 400 on the field entityType for entityId alone", async () => {
            const res = await get(`${URL_PATH}?entityId=5`);
            expect(res.status).toBe(400);
            expectErrorEnvelope(res.body, "ValidationFailed");
            expect(res.body.error.details).toEqual([{ field: "entityType", issue: "is required when entityId is given" }]);
        });

        it("should return 200 for entityType alone", async () => {
            await seed([{ id: 1, at: "2026-04-10 10:00:00+00", entityType: "consultation" }]);
            const res = await get(`${URL_PATH}?entityType=consultation`);
            expect(res.status).toBe(200);
            expect(ids(res)).toEqual([1]);
        });

        // Spec 3.1: both cross-field conditions are reported at once, sorted by field.
        it("should report both the entityType and the from details when entityId lacks entityType and from is later than to", async () => {
            const res = await get(`${URL_PATH}?entityId=5&from=2026-04-02T00:00:00Z&to=2026-04-01T00:00:00Z`);
            expect(res.status).toBe(400);
            expect(res.body.error.details).toEqual([
                { field: "entityType", issue: "is required when entityId is given" },
                { field: "from", issue: "must not be later than to" },
            ]);
        });

        it("should still return 400 (entityType only) for that combination", async () => {
            const res = await get(`${URL_PATH}?entityId=5&from=2026-04-02T00:00:00Z&to=2026-04-01T00:00:00Z`);
            expect(res.status).toBe(400);
            expect(res.body.error.details.map((detail: { field: string }) => detail.field)).toContain("entityType");
        });
    });

    describe("read side effects (R9)", () => {
        it("should leave the audit_logs row count unchanged and write no audit.read row", async () => {
            await seedMany(5);
            const before = await auditCount();
            await get(URL_PATH);
            await get(`${URL_PATH}?limit=2`);
            await get(`${URL_PATH}?entityId=5`); // 400
            await get(URL_PATH, "patient"); // 403
            expect(await auditCount()).toBe(before);
            const reads = await ownerDb("audit_logs").where("action", "like", "audit.%");
            expect(reads).toEqual([]);
        });

        it("should issue exactly one statement per request, against audit_logs only (T-Q1)", async () => {
            await seedMany(3);
            const sqls = await statements(async () => { expect((await get(`${URL_PATH}?limit=2&actorUserId=${ADMIN}`)).status).toBe(200); });
            expect(sqls).toHaveLength(1);
            expect(sqls[0]).toContain("audit_logs");
        });

        it("should select exactly the nine columns plus cursor_timestamp and never select * (T-Q2)", async () => {
            await seedMany(1);
            const sqls = await statements(async () => { await get(URL_PATH); });
            const sql = sqls[0] ?? "";
            expect(sql).not.toMatch(/select\s+\*/i);
            expect(sql).not.toMatch(/count\(/i);
            const list = /^select (.*) from "audit_logs"/is.exec(sql)?.[1] ?? "";
            const stripped = list.replace(/to_char\(.*?\) AS "cursor_timestamp"/s, "").replace(/\s+/g, " ");
            expect(stripped.split(",").map((column) => column.trim()).filter((column) => column.length > 0)).toEqual(
                ["id", "actor_user_id", "actor_role", "action", "entity_type", "entity_id", "request_id", "metadata", "created_at"].map((column) => `"${column}"`),
            );
            expect(list).toContain('"cursor_timestamp"');
        });
    });

    describe("metadata passthrough (R10)", () => {
        it("should return metadata byte-for-byte equal with types preserved and no key the row lacked", async () => {
            const metadata = { fromStatus: "booked", toStatus: "cancelled", consultationId: 1042, flag: true, note: null, reasonLength: 12, off: false, ratio: 1.5 };
            await seed([{ id: 1, at: "2026-04-10 10:00:00+00", metadata, requestId: "9a0b7c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d" }]);
            const res = await get(URL_PATH);
            const entry = (res.body.data as Entry[])[0];
            expect(entry?.metadata).toStrictEqual(metadata);
            expect(typeof entry?.metadata.consultationId).toBe("number");
            expect(entry?.metadata.note).toBeNull();
            expect(entry?.metadata.flag).toBe(true);
            expect(Object.keys(entry?.metadata ?? {}).sort()).toEqual(Object.keys(metadata).sort());
        });

        it("should return an empty metadata object as {}", async () => {
            await seed([{ id: 1, at: "2026-04-10 10:00:00+00" }]);
            expect((await get(URL_PATH)).body.data[0].metadata).toStrictEqual({});
        });

        it("should return a row written by the real AuditRecorder once the clock is past the commit", async () => {
            const recorder = container.resolve<AuditRecorder>(TOKENS.AuditRecorder);
            await db.transaction((trx) => recorder.record(trx, {
                actor: { kind: "user", userId: ADMIN, role: "admin" }, action: "doctor.approved", entityType: "doctor_profile", entityId: 21, metadata: { fromStatus: "submitted", toStatus: "approved" },
            }));
            clock.set(Date.now() + 1000); // the only test touching the real created_at default
            const res = await get(URL_PATH);
            expect(res.status).toBe(200);
            expect(res.body.data).toHaveLength(1);
            expect(res.body.data[0]).toMatchObject({
                actorUserId: ADMIN, actorRole: "admin", action: "doctor.approved", entityType: "doctor_profile", entityId: 21, metadata: { fromStatus: "submitted", toStatus: "approved" },
            });
            expect(new Date(res.body.data[0].createdAt).toISOString()).toBe(res.body.data[0].createdAt);
        });

        it("should map service and system actors to actorUserId null with their role", async () => {
            await seed([
                { id: 1, at: "2026-04-10 10:00:00+00", actor: null, role: "service", metadata: { actorClientId: "ai-service" } },
                { id: 2, at: "2026-04-10 10:00:01+00", actor: null, role: "system" },
            ]);
            const data = (await get(URL_PATH)).body.data as Entry[];
            expect(data.map((entry) => [entry.actorUserId, entry.actorRole])).toEqual([[null, "system"], [null, "service"]]);
        });
    });

    describe("exact-match, injection-safe filters (R11)", () => {
        it("should treat percent, underscore and quote in action as literal characters", async () => {
            await seed([
                { id: 1, at: "2026-04-10 10:00:00+00", action: "x_y" },
                { id: 2, at: "2026-04-10 10:00:01+00", action: "xzy" },
                { id: 3, at: "2026-04-10 10:00:02+00", action: "x%y" },
            ]);
            expect(ids(await get(`${URL_PATH}?action=x_y`))).toEqual([1]);
            expect(ids(await get(`${URL_PATH}?action=x%25y`))).toEqual([3]);
            for (const action of ["x%25", "%25", "x_", "o'brien", "%27%20OR%20%271%27=%271", "x%25%25y"]) {
                const res = await get(`${URL_PATH}?action=${action}`);
                expect(res.status).toBe(200);
                expect(ids(res)).toEqual([]);
            }
        });

        it("should compare action and entityType case-sensitively", async () => {
            await seed([{ id: 1, at: "2026-04-10 10:00:00+00", action: "doctor.approved", entityType: "doctor_profile" }]);
            expect(ids(await get(`${URL_PATH}?action=Doctor.Approved`))).toEqual([]);
            expect(ids(await get(`${URL_PATH}?entityType=Doctor_Profile`))).toEqual([]);
            expect(ids(await get(`${URL_PATH}?action=doctor.approved`))).toEqual([1]);
        });

        it("should return 400, not 500, for a NUL in action or entityType", async () => {
            for (const field of ["action", "entityType"]) {
                const res = await get(`${URL_PATH}?${field}=a%00b`);
                expect(res.status).toBe(400);
                expect(res.body.error.details).toEqual([expect.objectContaining({ field })]);
            }
        });

        it("should accept 64-character action and entityType and reject 65", async () => {
            expect((await get(`${URL_PATH}?action=${"a".repeat(64)}&entityType=${"b".repeat(64)}`)).status).toBe(200);
            expect((await get(`${URL_PATH}?action=${"a".repeat(65)}`)).status).toBe(400);
            expect((await get(`${URL_PATH}?entityType=${"b".repeat(65)}`)).status).toBe(400);
        });

        it.each(["action=", "entityType=", "actorUserId=", "entityId=&entityType=consultation", "from=", "to=", "cursor="])(
            "should return 400 for the empty value in %s instead of treating it as no filter",
            async (query) => {
                expect((await get(`${URL_PATH}?${query}`)).status).toBe(400);
            },
        );
    });

    describe("every filter", () => {
        // 3 actors (101 patient, 202 doctor, 303 admin) + service + system, 3 actions groups, 3 entity types.
        beforeEach(async () => {
            await seed([
                { id: 1, at: "2026-04-10 10:01:00+00", actor: 101, role: "patient", action: "consultation.created", entityType: "consultation", entityId: 11 },
                { id: 2, at: "2026-04-10 10:02:00+00", actor: 101, role: "patient", action: "consultation.cancelled", entityType: "consultation", entityId: 12 },
                { id: 3, at: "2026-04-10 10:03:00+00", actor: 202, role: "doctor", action: "doctor.submitted", entityType: "doctor_profile", entityId: 21 },
                { id: 4, at: "2026-04-10 10:04:00+00", actor: 303, role: "admin", action: "doctor.approved", entityType: "doctor_profile", entityId: 21 },
                { id: 5, at: "2026-04-10 10:05:00+00", actor: 303, role: "admin", action: "specialty.created", entityType: "specialty", entityId: 31 },
                { id: 6, at: "2026-04-10 10:06:00+00", actor: null, role: "service", action: "doctor.summary_read", entityType: "doctor_profile", entityId: 21, metadata: { actorClientId: "ai-service" } },
                { id: 7, at: "2026-04-10 10:07:00+00", actor: null, role: "system", action: "sync.retried", entityType: "consultation", entityId: 11 },
            ]);
        });

        const idsFor = async (query: string): Promise<number[]> => {
            const res = await get(`${URL_PATH}?${query}`);
            expect(res.status).toBe(200);
            return ids(res);
        };

        it("should return only that actor's rows for actorUserId and exclude service and system rows", async () => {
            expect(await idsFor("actorUserId=303")).toEqual([5, 4]);
            expect(await idsFor("actorUserId=101")).toEqual([2, 1]);
            expect(await idsFor("actorUserId=999")).toEqual([]);
        });

        it("should match action exactly", async () => {
            expect(await idsFor("action=doctor.approved")).toEqual([4]);
            expect(await idsFor("action=doctor")).toEqual([]);
            expect(await idsFor("action=sync.retried")).toEqual([7]);
        });

        it("should match entityType exactly", async () => {
            expect(await idsFor("entityType=doctor_profile")).toEqual([6, 4, 3]);
            expect(await idsFor("entityType=consultation")).toEqual([7, 2, 1]);
            expect(await idsFor("entityType=doctor")).toEqual([]);
        });

        it("should match the entityType + entityId pair", async () => {
            expect(await idsFor("entityType=doctor_profile&entityId=21")).toEqual([6, 4, 3]);
            expect(await idsFor("entityType=consultation&entityId=11")).toEqual([7, 1]);
            expect(await idsFor("entityType=consultation&entityId=21")).toEqual([]);
            expect(await idsFor("entityType=specialty&entityId=11")).toEqual([]);
        });

        it("should apply from alone, to alone, and from + to", async () => {
            expect(await idsFor("from=2026-04-10T10:05:00Z")).toEqual([7, 6, 5]);
            expect(await idsFor("to=2026-04-10T10:03:00Z")).toEqual([2, 1]);
            expect(await idsFor("from=2026-04-10T10:03:00Z&to=2026-04-10T10:06:00Z")).toEqual([5, 4, 3]);
        });

        it("should return the intersection when every filter is combined", async () => {
            const all = "actorUserId=303&entityType=doctor_profile&entityId=21&action=doctor.approved&from=2026-04-10T10:04:00Z&to=2026-04-10T10:05:00Z";
            expect(await idsFor(all)).toEqual([4]);
            for (const broken of [
                all.replace("actorUserId=303", "actorUserId=202"),
                all.replace("entityId=21", "entityId=22"),
                all.replace("doctor.approved", "doctor.submitted"),
                all.replace("entityType=doctor_profile", "entityType=specialty"),
                all.replace("from=2026-04-10T10:04:00Z", "from=2026-04-10T10:04:00.001Z"),
                all.replace("to=2026-04-10T10:05:00Z", "to=2026-04-10T10:04:00Z"),
            ]) {
                expect(await idsFor(broken)).toEqual([]);
            }
        });

        it("should combine actorUserId with entityType and with action", async () => {
            expect(await idsFor("actorUserId=303&entityType=doctor_profile")).toEqual([4]);
            expect(await idsFor("actorUserId=101&action=consultation.cancelled")).toEqual([2]);
            expect(await idsFor("actorUserId=101&action=doctor.approved")).toEqual([]);
        });

        it.each(["foo=1", "requestId=9a0b7c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d", "metadata.x=1", "actor=1", "entity_type=x", "offset=1", "sort=asc"])(
            "should return 400 is not allowed for the unknown key %s",
            async (query) => {
                const res = await get(`${URL_PATH}?${query}`);
                expect(res.status).toBe(400);
                expectErrorEnvelope(res.body, "ValidationFailed");
                expect(res.body.error.details).toEqual([{ field: query.split("=")[0], issue: "is not allowed" }]);
            },
        );

        it("should return 400 for duplicated keys", async () => {
            for (const query of ["action=a&action=b", "actorUserId=1&actorUserId=2", "limit=1&limit=2", "from=2026-04-01T00:00:00Z&from=2026-04-02T00:00:00Z"]) {
                expect((await get(`${URL_PATH}?${query}`)).status).toBe(400);
            }
        });

        it.each(["0", "-1", "007", "1e3", "1.5", "%2B1", "%201", "abc", "9007199254740992"])("should return 400 for actorUserId=%s", async (value) => {
            const res = await get(`${URL_PATH}?actorUserId=${value}`);
            expect(res.status).toBe(400);
            expect(res.body.error.details).toEqual([expect.objectContaining({ field: "actorUserId" })]);
        });

        it("should page 2 with the same filter yield the rest", async () => {
            const { all, pages } = await walk(`${URL_PATH}?entityType=doctor_profile&limit=2`);
            expect(all).toEqual([6, 4, 3]);
            expect(pages.map((page) => ids(page))).toEqual([[6, 4], [3]]);
        });

        it("should treat a cursor as a position, not a grant: reused with a different filter it returns only rows matching the new filter", async () => {
            const unfiltered = await get(`${URL_PATH}?limit=3`); // 7, 6, 5 -> cursor after id 5
            expect(ids(unfiltered)).toEqual([7, 6, 5]);
            const cursor = encodeURIComponent(unfiltered.body.meta.nextCursor);
            const other = await get(`${URL_PATH}?actorUserId=303&cursor=${cursor}`);
            expect(ids(other)).toEqual([4]); // 5 itself is behind the cursor, 6 and 7 are newer
            const none = await get(`${URL_PATH}?actorUserId=999&cursor=${cursor}`);
            expect(ids(none)).toEqual([]);
        });
    });

    // ------------------------------------------------------------------------------------------------ cursor tamper
    describe("cursor tamper and stale cursors", () => {
        let good = "";
        const expectCursor400 = async (cursor: string): Promise<void> => {
            const res = await get(`${URL_PATH}?cursor=${encodeURIComponent(cursor)}`);
            expect(res.status).toBe(400);
            expectErrorEnvelope(res.body, "ValidationFailed");
            expect(res.body.error.details.map((detail: { field: string }) => detail.field)).toContain("cursor");
        };
        const flip = (value: string, index: number): string => `${value.slice(0, index)}${value[index] === "A" ? "B" : "A"}${value.slice(index + 1)}`;
        const signed = (payload: unknown, secret = SECRET): string => encodeSignedCursor(payload as object, secret);

        beforeEach(async () => {
            await seedMany(3);
            good = (await get(`${URL_PATH}?limit=1`)).body.meta.nextCursor as string;
            expect(typeof good).toBe("string");
        });

        it("should accept the untouched cursor", async () => {
            const res = await get(`${URL_PATH}?limit=1&cursor=${encodeURIComponent(good)}`);
            expect(res.status).toBe(200);
            expect(ids(res)).toEqual([2]);
        });

        it("should return 400 with details [{ field: cursor, issue: is invalid }] for a random string", async () => {
            const res = await get(`${URL_PATH}?cursor=not-a-cursor`);
            expect(res.status).toBe(400);
            expect(res.body.error.details).toEqual([{ field: "cursor", issue: "is invalid" }]);
        });

        it("should return 400 for valid base64 JSON without a MAC", async () => {
            await expectCursor400(Buffer.from(JSON.stringify({ t: "2026-04-10T10:00:00.000001Z", id: 1, to: "2026-04-15T12:00:00.000Z" })).toString("base64url"));
        });

        it("should return 400 for a flipped MAC and for a flipped payload byte", async () => {
            await expectCursor400(flip(good, good.indexOf(".") + 4));
            await expectCursor400(flip(good, 6));
        });

        it("should return 400 for an edited payload under the old MAC", async () => {
            const payload = { ...decodeCursor(good), id: 1 };
            await expectCursor400(`${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${good.split(".")[1] ?? ""}`);
        });

        it("should return 400 for a verification-queue cursor (validly signed, different payload)", async () => {
            await expectCursor400(signed({ s: "submitted", t: "2026-04-10T10:00:00.123Z", id: 4 }));
        });

        it("should return 400 for a cursor signed with a rotated secret", async () => {
            await expectCursor400(signed(decodeCursor(good), "a-previous-secret"));
        });

        it.each<[string, Record<string, unknown>]>([
            ["t with three fraction digits", { t: "2026-04-10T10:00:00.123Z" }],
            ["id 0", { id: 0 }],
            ["a float id", { id: 1.5 }],
            ["a string id", { id: "3" }],
            ["a negative id", { id: -3 }],
            ["a missing to", { to: undefined }],
            ["a to that is not a valid instant", { to: "2026-13-45T00:00:00.000Z" }],
            ["a to without milliseconds", { to: "2026-04-15T12:00:00Z" }],
        ])("should return 400 for a signed payload with %s", async (_label, override) => {
            await expectCursor400(signed({ ...decodeCursor(good), ...override }));
        });

        it("should return 400 for a cursor over 1024 characters", async () => {
            const res = await get(`${URL_PATH}?cursor=${"a".repeat(1025)}`);
            expect(res.status).toBe(400);
            expect(res.body.error.details).toEqual([expect.objectContaining({ field: "cursor" })]);
        });

        // A validly signed `t` that is not a real instant is rejected by the cursor validator (it would otherwise raise 22008 -> 500).
        it("should return 400 for every shape a signer could emit that Postgres cannot parse", async () => {
            // Shaped like a position but not a real instant: must be a 400, never a 500 from the database.
            await expectCursor400(signed({ ...decodeCursor(good), t: "2026-13-45T25:61:61.000000Z" }));
            await expectCursor400(signed({ ...decodeCursor(good), t: "0000-01-01T00:00:00.000000Z" }));
        });

        it("should never return 500 for any of the above", async () => {
            const hostile = [
                "", ".", "..", "a.b.c", "%00", " . ", good.split(".")[0] ?? "", `${good}.extra`, `${good}%`, "=.=", "e30.e30",
            ];
            for (const cursor of hostile) {
                const res = await get(`${URL_PATH}?cursor=${encodeURIComponent(cursor)}`);
                expect([200, 400]).toContain(res.status);
            }
        });
    });

    // ------------------------------------------------------------------------------------------------ contract
    describe("contract conformance", () => {
        const operation = contractOperationBlock(URL_PATH, "get");

        it("should return the success envelope with entries of exactly the contract AuditLogEntry keys", async () => {
            await seed([
                { id: 1, at: "2026-04-10 10:00:00+00", requestId: "9a0b7c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d", metadata: { a: 1 } },
                { id: 2, at: "2026-04-10 10:00:01+00", actor: null, role: "service", metadata: { actorClientId: "ai-service" } },
                { id: 3, at: "2026-04-10 10:00:02+00", actor: 101, role: "patient" },
                { id: 4, at: "2026-04-10 10:00:03+00", actor: 202, role: "doctor" },
                { id: 5, at: "2026-04-10 10:00:04+00", actor: null, role: "system" },
            ]);
            const res = await get(URL_PATH);
            expect(res.status).toBe(200);
            expect(Object.keys(res.body).sort()).toEqual(["data", "meta", "success"]);
            const data = expectSuccessEnvelope(res.body) as Entry[];
            const [required = []] = inlineLists(schemaBlock("AuditLogEntry"), "required");
            const [roles = []] = inlineLists(schemaBlock("AuditLogEntry"), "enum");
            expect(data).toHaveLength(5);
            for (const entry of data) {
                expect(Object.keys(entry).sort()).toEqual([...required].sort());
                expect(roles).toContain(entry.actorRole);
                expect(entry.requestId === null || UUID.test(entry.requestId)).toBe(true);
                expect(Number.isInteger(entry.id) && Number.isInteger(entry.entityId)).toBe(true);
                expect(entry.actorUserId === null || Number.isInteger(entry.actorUserId)).toBe(true);
                expect(new Date(entry.createdAt).toISOString()).toBe(entry.createdAt);
                for (const value of Object.values(entry.metadata)) expect(["string", "number", "boolean", "object"]).toContain(typeof value);
            }
            expect(Object.keys(expectPaginationMeta(res.body.meta)).sort()).toEqual(["count", "hasMore", "nextCursor"]);
            expect(Object.keys(res.body.meta).sort()).toEqual(["count", "hasMore", "nextCursor"]);
        });

        it("should declare exactly the DTO's filters as query parameters", () => {
            const declared = [...operation.matchAll(/^ {8}- name: (\w+)$/gm)].map((match) => match[1]).sort();
            expect(declared).toEqual(["action", "actorUserId", "entityId", "entityType", "from", "to"]);
            expect(operation).toContain("#/components/parameters/Cursor");
            expect(operation).toContain("#/components/parameters/Limit");
        });

        it("should return only status codes the contract declares for the operation, and declare every one of them", async () => {
            await seedMany(1);
            const statuses = new Set<number>();
            for (const [url, actor] of [[URL_PATH, "admin"], [`${URL_PATH}?limit=0`, "admin"], [URL_PATH, null], [URL_PATH, "patient"]] as const) statuses.add((await get(url, actor)).status);
            const declared = contractResponseCodes(URL_PATH, "get").map(Number);
            expect(declared.sort()).toEqual([200, 400, 401, 403, 429, 500]);
            expect([...statuses].sort()).toEqual([200, 400, 401, 403]);
            for (const status of statuses) expect(declared).toContain(status);
        });

        it("should send Cache-Control no-store as the contract declares on success and on every error", async () => {
            await seedMany(1);
            const expected = contractNoStoreValue();
            expect(expected).toBe("no-store");
            for (const [url, actor] of [[URL_PATH, "admin"], [`${URL_PATH}?limit=0`, "admin"], [URL_PATH, null], [URL_PATH, "patient"], [URL_PATH, "expired"]] as const) {
                const res = await get(url, actor);
                expect(res.headers["cache-control"]).toBe(expected);
            }
        });

        it("should echo X-Request-Id and adopt an incoming valid UUID, also inside the error envelope", async () => {
            const incoming = randomUUID();
            const ok = await get(URL_PATH, "admin", { "X-Request-Id": incoming });
            expect(ok.headers["x-request-id"]).toBe(incoming);
            const bad = await get(`${URL_PATH}?limit=0`, "admin", { "X-Request-Id": incoming });
            expect(bad.headers["x-request-id"]).toBe(incoming);
            expectErrorEnvelope(bad.body, "ValidationFailed", incoming);
            const generated = await get(URL_PATH, "admin", { "X-Request-Id": "not-a-uuid" });
            expect(generated.headers["x-request-id"]).toMatch(UUID);
            expect(generated.headers["x-request-id"]).not.toBe("not-a-uuid");
        });

        it("should contain no token, secret, or hash in any response", async () => {
            await seedMany(2);
            const bodies = [await get(URL_PATH), await get(`${URL_PATH}?limit=0`), await get(URL_PATH, "patient"), await get(URL_PATH, null)];
            for (const res of bodies) {
                const text = JSON.stringify(res.body);
                for (const forbidden of [tokens.admin, tokens.patient, SECRET, "password", "token_hash", "Bearer "]) expect(text).not.toContain(forbidden);
            }
        });

        it("should return 429 on the 121st request within a minute for one admin, with Retry-After, and leave a second admin unaffected", async () => {
            await seedMany(1);
            const capture = captureLogs();
            let limited: Response;
            try {
                for (let index = 0; index < 120; index += 1) {
                    const res = await request(app).get(`${URL_PATH}?limit=1`).set("Authorization", `Bearer ${tokens.admin}`);
                    expect(res.status).toBe(200);
                }
                limited = await get(`${URL_PATH}?limit=1&action=canary.ratelimited.zq9`);
            } finally {
                capture.restore();
            }
            expect(limited.status).toBe(429);
            expectErrorEnvelope(limited.body, "RateLimited");
            expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
            expect(limited.headers["cache-control"]).toBe("no-store");
            expectNoSensitiveStrings(capture, ["canary.ratelimited.zq9"]);
            expect((await get(`${URL_PATH}?limit=1`, "admin2")).status).toBe(200);
        });
    });

    // ------------------------------------------------------------------------------------------------ logs
    describe("logs (R13)", () => {
        const CANARY_ACTION = "canary.action.zq9";
        const CANARY_ACTOR = 8765432;
        const CANARY_ENTITY = 7654321;
        const CANARY_META = "meta-canary-zq9";

        beforeEach(async () => {
            // `.env.test` runs at LOG_LEVEL=warn, which hides request_completed (info): raise it so the assertions are not vacuous.
            jest.replaceProperty(logger as unknown as { level: string }, "level", "debug");
            await seed([
                { id: 1, at: "2026-04-10 10:00:00+00", actor: CANARY_ACTOR, role: "admin", action: CANARY_ACTION, entityType: "canary_entity", entityId: CANARY_ENTITY, metadata: { note: CANARY_META } },
                { id: 2, at: "2026-04-10 10:00:01+00", actor: CANARY_ACTOR, role: "admin", action: CANARY_ACTION, entityType: "canary_entity", entityId: CANARY_ENTITY, metadata: { note: CANARY_META } },
            ]);
        });

        afterEach(() => {
            jest.restoreAllMocks();
        });

        it("should keep metadata, cursor, entityId, actorUserId, action and the query string out of the logs on success and 400", async () => {
            const capture = captureLogs();
            let cursor = "";
            try {
                const first = await get(`${URL_PATH}?actorUserId=${CANARY_ACTOR}&entityType=canary_entity&entityId=${CANARY_ENTITY}&action=${CANARY_ACTION}&limit=1`);
                expect(first.status).toBe(200);
                cursor = first.body.meta.nextCursor as string;
                expect((await get(`${URL_PATH}?actorUserId=${CANARY_ACTOR}&limit=1&cursor=${encodeURIComponent(cursor)}`)).status).toBe(200);
                expect((await get(`${URL_PATH}?actorUserId=${CANARY_ACTOR}&action=${CANARY_ACTION}&limit=0`)).status).toBe(400);
                expect((await get(`${URL_PATH}?entityId=${CANARY_ENTITY}&canaryKey=1`)).status).toBe(400);
                expect((await get(`${URL_PATH}?cursor=${CANARY_META}`)).status).toBe(400);
                expect((await get(`${URL_PATH}?actorUserId=${CANARY_ACTOR}`, "patient")).status).toBe(403);
            } finally {
                capture.restore();
            }
            expectNoSensitiveStrings(capture, [
                String(CANARY_ACTOR), String(CANARY_ENTITY), CANARY_ACTION, CANARY_META, "canary_entity", cursor, cursor.split(".")[0] ?? cursor, "canaryKey", "actorUserId=", "entityType=",
            ]);
            const completed = capture.lines().filter((line) => line.message === "request_completed" && String(line.route).includes("/api/audit-logs"));
            expect(completed.map((line) => line.status)).toEqual([200, 200, 400, 400, 400, 403]);
            for (const line of completed) {
                expect(Object.keys(line)).not.toEqual(expect.arrayContaining(["query", "url", "body", "metadata"]));
                expect(line.route).toBe("/api/audit-logs");
                expect(line.method).toBe("GET");
            }
        });

        it("should answer 500 and keep the filter values out of the logs when the statement times out", async () => {
            // Real scenario: the table is locked by another session, so the app pool's statement_timeout (2 s) cancels the read.
            const blocker = await ownerDb.transaction();
            await blocker.raw("LOCK TABLE audit_logs IN ACCESS EXCLUSIVE MODE");
            const capture = captureLogs();
            let res: Response;
            try {
                res = await get(`${URL_PATH}?actorUserId=${CANARY_ACTOR}&entityType=canary_entity&entityId=${CANARY_ENTITY}&action=${CANARY_ACTION}`);
            } finally {
                capture.restore();
                await blocker.rollback();
            }
            expect(res.status).toBe(500);
            expectErrorEnvelope(res.body, "InternalError");
            expect(JSON.stringify(res.body)).not.toMatch(/audit_logs|statement timeout|stack/);
            expect(capture.lines().some((line) => line.message === "unhandled_error")).toBe(true);
            expectNoSensitiveStrings(capture, [String(CANARY_ACTOR), String(CANARY_ENTITY), CANARY_ACTION, "canary_entity"]);
        });
    });

    // ------------------------------------------------------------------------------------------------ structure
    describe("indexes, grants and structure (T-IDX1..3)", () => {
        const INDEXES = {
            idx_audit_logs_entity_type_entity_id_created_at: "(entity_type, entity_id, created_at DESC, id DESC)",
            idx_audit_logs_actor_user_id_created_at: "(actor_user_id, created_at DESC, id DESC)",
            idx_audit_logs_created_at_id: "(created_at DESC, id DESC)",
        } as const;
        const names = Object.keys(INDEXES);

        it("should create the three named indexes with exactly the declared columns and DESC order, valid and not unique (T-IDX1)", async () => {
            const result = await ownerDb.raw<{ rows: Array<{ indexname: string; indexdef: string; indisvalid: boolean; indisunique: boolean }> }>(
                `SELECT i.indexname, i.indexdef, x.indisvalid, x.indisunique
                 FROM pg_indexes i
                 JOIN pg_class c ON c.relname = i.indexname AND c.relnamespace = 'public'::regnamespace
                 JOIN pg_index x ON x.indexrelid = c.oid
                 WHERE i.tablename = 'audit_logs' AND i.indexname = ANY(string_to_array(?, ','))
                 ORDER BY i.indexname`,
                [names.join(",")],
            );
            expect(result.rows.map((row) => row.indexname)).toEqual([...names].sort());
            for (const row of result.rows) {
                expect(row.indexdef).toContain(INDEXES[row.indexname as keyof typeof INDEXES]);
                expect(row.indexdef).toContain("USING btree");
                expect(row.indexdef).not.toMatch(/UNIQUE/);
                expect(row.indisvalid).toBe(true);
                expect(row.indisunique).toBe(false);
            }
        });

        const childIndexCounts = async (): Promise<Array<{ partition: string; matched: number }>> => {
            const result = await ownerDb.raw<{ rows: Array<{ partition: string; matched: number }> }>(
                `SELECT part.relname AS partition,
                        (SELECT count(*)::int FROM pg_index x
                           JOIN pg_inherits ih ON ih.inhrelid = x.indexrelid
                           JOIN pg_class parent_idx ON parent_idx.oid = ih.inhparent
                          WHERE x.indrelid = part.oid AND parent_idx.relname = ANY(string_to_array(?, ','))) AS matched
                 FROM pg_inherits pi JOIN pg_class part ON part.oid = pi.inhrelid
                 WHERE pi.inhparent = 'public.audit_logs'::regclass
                 ORDER BY part.relname`,
                [names.join(",")],
            );
            return result.rows;
        };

        it("should give every existing partition, including audit_logs_default, a child of each of the three indexes (T-IDX2)", async () => {
            const counts = await childIndexCounts();
            expect(counts.map((row) => row.partition)).toEqual(expect.arrayContaining(["audit_logs_default", ...TEST_MONTHS.map(partitionOf)]));
            for (const row of counts) expect(row).toEqual({ partition: row.partition, matched: 3 });
        });

        it("should give a partition created later by audit_logs_ensure_partitions a child of each of the three indexes (T-IDX2)", async () => {
            const created = await ownerDb.raw<{ rows: Array<{ partition_name: string; created: boolean }> }>("SELECT partition_name, created FROM audit_logs_ensure_partitions(5)");
            const added = created.rows.filter((row) => row.created).map((row) => row.partition_name);
            try {
                expect(added.length).toBeGreaterThan(0); // current+3..+5 are not part of the migration-created window
                const counts = await childIndexCounts();
                for (const name of added) expect(counts.find((row) => row.partition === name)?.matched).toBe(3);
            } finally {
                for (const name of added) await ownerDb.raw(`DROP TABLE IF EXISTS public.${name}`);
            }
        });

        it("should keep the app role's privileges unchanged: SELECT yes, UPDATE/DELETE/TRUNCATE no, column-level INSERT set unchanged (T-IDX3)", async () => {
            const result = await ownerDb.raw<{ rows: Array<Record<string, boolean>> }>(
                `SELECT has_table_privilege('care_app','audit_logs','SELECT') AS sel,
                        has_table_privilege('care_app','audit_logs','UPDATE') AS upd,
                        has_table_privilege('care_app','audit_logs','DELETE') AS del,
                        has_table_privilege('care_app','audit_logs','TRUNCATE') AS trunc,
                        has_table_privilege('care_app','audit_logs','INSERT') AS tbl_ins,
                        has_table_privilege('care_app','audit_logs_default','SELECT') AS def_sel,
                        has_table_privilege('care_app','audit_logs_default','UPDATE') AS def_upd`,
            );
            expect(result.rows[0]).toEqual({ sel: true, upd: false, del: false, trunc: false, tbl_ins: false, def_sel: true, def_upd: false });
            const columns = await ownerDb.raw<{ rows: Array<{ attname: string; can_insert: boolean; can_update: boolean }> }>(
                `SELECT attname, has_column_privilege('care_app','audit_logs',attname,'INSERT') AS can_insert,
                        has_column_privilege('care_app','audit_logs',attname,'UPDATE') AS can_update
                 FROM pg_attribute WHERE attrelid = 'audit_logs'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`,
            );
            const insertable = columns.rows.filter((row) => row.can_insert).map((row) => row.attname);
            expect(insertable).toEqual(["actor_user_id", "actor_role", "action", "entity_type", "entity_id", "request_id", "metadata"]);
            expect(columns.rows.some((row) => row.can_update)).toBe(false);
        });
    });

    // ------------------------------------------------------------------------------------------------ explain
    describe("EXPLAIN: index choice and partition pruning (9.4)", () => {
        interface PlanNode { "Node Type": string; "Relation Name"?: string; "Index Name"?: string; "Index Cond"?: string; Plans?: PlanNode[] }
        const WINDOW = { from: new Date("2026-03-16T12:00:00.000Z"), to: new Date("2026-04-15T12:00:00.000Z"), fetchLimit: 21 } as const;
        const flatten = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(flatten)];

        async function plan(params: ListAuditLogsParams): Promise<{ nodes: PlanNode[]; sql: string }> {
            return db.transaction(async (trx) => {
                await trx.raw("SET LOCAL enable_seqscan = off");
                // Deviation from spec 9.4: with a few hundred rows per partition the planner also has a cheap Bitmap + Sort plan for the
                // selective shapes; disabling bitmap scans makes the assertion about the ordered index paths the indexes were built for.
                await trx.raw("SET LOCAL enable_bitmapscan = off");
                const sql = listAuditLogsQuery(params, trx).toQuery();
                const result = await trx.raw<{ rows: Array<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }> }>(`EXPLAIN (FORMAT JSON) ${sql}`);
                const root = result.rows[0]?.["QUERY PLAN"][0]?.Plan;
                if (root === undefined) throw new Error("no plan");
                return { nodes: flatten(root), sql };
            });
        }

        /** Parent index (by name) of every index used in the plan. */
        async function parentIndexes(nodes: PlanNode[]): Promise<string[]> {
            const used = [...new Set(nodes.map((node) => node["Index Name"]).filter((name): name is string => name !== undefined))];
            if (used.length === 0) return [];
            const result = await ownerDb.raw<{ rows: Array<{ parent: string }> }>(
                `SELECT DISTINCT p.relname AS parent FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
                 WHERE c.relname = ANY(string_to_array(?, ','))`,
                [used.join(",")],
            );
            return result.rows.map((row) => row.parent).sort();
        }

        const relations = (nodes: PlanNode[]): string[] => [...new Set(nodes.map((node) => node["Relation Name"]).filter((name): name is string => name !== undefined))].sort();
        const onMonthly = (nodes: PlanNode[]): PlanNode[] => nodes.filter((node) => node["Relation Name"]?.startsWith("audit_logs_y") === true);
        const monthly = (nodes: PlanNode[]): string[] => relations(nodes).filter((name) => name !== "audit_logs_default");

        beforeEach(async () => {
            for (const month of TEST_MONTHS) {
                await ownerDb.raw(
                    `INSERT INTO audit_logs (id, actor_user_id, actor_role, action, entity_type, entity_id, request_id, metadata, created_at)
                     SELECT ? * 1000 + g, CASE WHEN g % 100 = 0 THEN 303 ELSE 400 + (g % 7) END, 'admin', 'test.action_' || (g % 4), (ARRAY['consultation','doctor_profile','specialty'])[1 + (g % 3)], 1 + (g % 20), NULL, '{}'::jsonb,
                            make_timestamptz(2026, ?, 1, 0, 0, 0, 'UTC') + (g * interval '2 hours')
                     FROM generate_series(1, 300) AS g`,
                    [month, month],
                );
            }
            await ownerDb.raw("ANALYZE audit_logs");
        });

        it("should prune to the in-window partitions for the default query", async () => {
            const { nodes } = await plan({ ...WINDOW });
            expect(monthly(nodes)).toEqual([partitionOf(3), partitionOf(4)]);
            expect(relations(nodes)).not.toContain(partitionOf(1));
            expect(relations(nodes)).not.toContain(partitionOf(2));
            expect(relations(nodes)).not.toContain(partitionOf(5));
        });

        it("should prune when a cursor is present (page 2) and still plan no Sort", async () => {
            const { nodes } = await plan({ ...WINDOW, after: { t: "2026-04-10T10:00:00.123456Z", id: 4005 } });
            expect(monthly(nodes)).toEqual([partitionOf(3), partitionOf(4)]);
            expect(nodes.map((node) => node["Node Type"])).not.toContain("Sort");
        });

        it("should use idx_audit_logs_created_at_id for the unfiltered shape and for an action filter, with no Sort and no Seq Scan", async () => {
            for (const params of [{ ...WINDOW }, { ...WINDOW, action: "test.action_1" }] as ListAuditLogsParams[]) {
                const { nodes } = await plan(params);
                expect(await parentIndexes(onMonthly(nodes))).toEqual(["idx_audit_logs_created_at_id"]);
                expect(nodes.map((node) => node["Node Type"])).not.toContain("Sort");
                expect(nodes.filter((node) => node["Node Type"] === "Seq Scan" && node["Relation Name"]?.startsWith("audit_logs_y") === true)).toEqual([]);
            }
        });

        it("should use idx_audit_logs_entity_type_entity_id_created_at for entityType + entityId, with its equality and range as index conditions", async () => {
            const { nodes } = await plan({ ...WINDOW, entityType: "consultation", entityId: 5 });
            expect(await parentIndexes(onMonthly(nodes))).toEqual(["idx_audit_logs_entity_type_entity_id_created_at"]);
            expect(nodes.map((node) => node["Node Type"])).not.toContain("Sort");
            const conds = onMonthly(nodes).map((node) => node["Index Cond"]).filter((cond): cond is string => cond !== undefined).join(" ");
            for (const part of ["entity_type", "entity_id", "created_at"]) expect(conds).toContain(part);
        });

        it("should use idx_audit_logs_actor_user_id_created_at for actorUserId, with no Sort", async () => {
            const { nodes } = await plan({ ...WINDOW, actorUserId: 303 });
            expect(await parentIndexes(onMonthly(nodes))).toEqual(["idx_audit_logs_actor_user_id_created_at"]);
            expect(nodes.map((node) => node["Node Type"])).not.toContain("Sort");
        });

        it("should include every test partition for an explicit 1970..9999 window (the pruning assertions are not vacuous)", async () => {
            const { nodes } = await plan({ from: new Date("1970-01-01T00:00:00.000Z"), to: new Date("9999-12-31T23:59:59.000Z"), fetchLimit: 21 });
            expect(monthly(nodes)).toEqual(expect.arrayContaining(TEST_MONTHS.map(partitionOf)));
        });

        it("should bind the bounds as parameters, not SQL time functions", () => {
            const built = listAuditLogsQuery({ ...WINDOW, after: { t: "2026-04-10T10:00:00.123456Z", id: 1 }, actorUserId: 303, action: "a.b", entityType: "x", entityId: 1 }, db);
            const { sql, bindings } = built.toSQL();
            expect(sql).not.toMatch(/now\(\)|current_timestamp|\binterval\b|localtimestamp|clock_timestamp/i);
            expect(sql).toContain("?::timestamptz");
            expect(bindings).toEqual(expect.arrayContaining(["2026-03-16T12:00:00.000Z", "2026-04-15T12:00:00.000Z"]));
            expect(built.toQuery()).not.toMatch(/now\(\)|current_timestamp|\binterval\b/i);
        });
    });
});
