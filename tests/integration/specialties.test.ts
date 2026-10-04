import { randomUUID } from "node:crypto";
import type { Express } from "express";
import request from "supertest";
import type { Test } from "supertest";
import { listSpecialtiesQuery } from "../../src/app/specialties/repository/specialties.repo";
import { container } from "../../src/lib/di/container";
import { TOKENS } from "../../src/lib/di/tokens";
import { encodeCursor } from "../../src/lib/http/pagination/cursor";
import { db } from "../../src/lib/knex/knex";
import { logger } from "../../src/lib/logger/logger";
import { redis } from "../../src/lib/redis/redis";
import { buildTestApps } from "../helpers/app";
import {
    contractResponseCodes,
    expectErrorEnvelope,
    expectPaginationMeta,
    expectSuccessEnvelope,
    idempotentOperations,
    inlineLists,
    schemaBlock,
} from "../helpers/contract";
import { closeDb, ownerDb, truncateAll } from "../helpers/db";
import { buildFakeJwksWiring, startFakeJwks } from "../helpers/fake-jwks";
import { captureLogs, expectNoSensitiveStrings } from "../helpers/log-capture";
import { closeRedis, ensureRedisReady, flushByPrefix } from "../helpers/redis";
import { signExpiredUserToken, signUserToken } from "../helpers/tokens";
import type { FakeJwks, FakeJwksWiring } from "../helpers/types";

jest.setTimeout(30_000);

const LIST = "/api/specialties";
const DESCRIPTION_FIXTURE = "SYNTHETIC-DESCRIPTION-4410";

interface SpecialtyBody {
    id: number;
    name: string;
    slug: string;
    description: string | null;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
}

interface SeedRow {
    name: string;
    slug: string;
    description?: string | null;
    isActive?: boolean;
}

interface AuditRow {
    actor_user_id: number;
    actor_role: string;
    action: string;
    entity_type: string;
    entity_id: number;
    request_id: string | null;
    metadata: Record<string, unknown>;
}

interface ActorSpec {
    label: string;
    sub: string;
    role: "patient" | "doctor" | "admin";
    status: "pending" | "active" | "rejected" | "suspended";
}

const ACTORS = {
    patient: { label: "patient active", sub: "101", role: "patient", status: "active" },
    doctor: { label: "doctor active", sub: "202", role: "doctor", status: "active" },
    doctorPending: { label: "doctor pending", sub: "203", role: "doctor", status: "pending" },
    doctorRejected: { label: "doctor rejected", sub: "204", role: "doctor", status: "rejected" },
    admin: { label: "admin active", sub: "303", role: "admin", status: "active" },
    patientPending: { label: "patient pending", sub: "105", role: "patient", status: "pending" },
    adminPending: { label: "admin pending", sub: "305", role: "admin", status: "pending" },
    patientSuspended: { label: "patient suspended", sub: "106", role: "patient", status: "suspended" },
    doctorSuspended: { label: "doctor suspended", sub: "206", role: "doctor", status: "suspended" },
    adminSuspended: { label: "admin suspended", sub: "306", role: "admin", status: "suspended" },
} as const satisfies Record<string, ActorSpec>;

type ActorName = keyof typeof ACTORS;

const padded = (n: number): string => String(n).padStart(3, "0");

describe("specialties (integration: real wiring, real Postgres as care_app, real Redis)", () => {
    let fake: FakeJwks;
    let wiring: FakeJwksWiring;
    let app: Express;
    const tokens = {} as Record<ActorName, string>;
    const previous: Array<{ token: symbol; value: unknown }> = [];
    /** `METHOD contract-path` -> statuses observed, asserted against the contract at the end. */
    const observed = new Map<string, Set<number>>();
    let slugSeq = 0;
    const freshSlug = (): string => `synthetic-slug-${(slugSeq += 1)}`;

    function record(req: Test, method: string, path: string): Test {
        const key = `${method} ${path.split("?")[0]?.replace(/\/[^/]*\d[^/]*$/, "/{id}").replace(/\/abc$/, "/{id}")}`;
        const originalEnd = req.end.bind(req) as (callback?: (error: Error | null, res: request.Response) => void) => Test;
        req.end = ((callback?: (error: Error | null, res: request.Response) => void): Test =>
            originalEnd((error, res) => {
                if (res !== undefined) {
                    const set = observed.get(key) ?? new Set<number>();
                    set.add(res.status);
                    observed.set(key, set);
                }
                callback?.(error, res);
            })) as Test["end"];
        return req;
    }

    const authed = (req: Test, actor: ActorName | undefined): Test =>
        actor === undefined ? req : req.set("Authorization", `Bearer ${tokens[actor]}`);

    const get = (path: string, actor?: ActorName): Test => authed(record(request(app).get(path), "GET", path), actor);
    const post = (body: unknown, actor?: ActorName, headers: Record<string, string> = {}): Test => {
        let req = authed(record(request(app).post(LIST), "POST", LIST), actor).set(headers);
        req = req.send(body as object);
        return req;
    };
    const patch = (id: number | string, body: unknown, actor?: ActorName, headers: Record<string, string> = {}): Test =>
        authed(record(request(app).patch(`${LIST}/${id}`), "PATCH", `${LIST}/${id}`), actor)
            .set(headers)
            .send(body as object);

    async function seed(rows: SeedRow[]): Promise<number[]> {
        if (rows.length === 0) return [];
        const inserted = await ownerDb("specialties")
            .insert(
                rows.map((row) => ({
                    name: row.name,
                    slug: row.slug,
                    description: row.description ?? null,
                    is_active: row.isActive ?? true,
                })),
            )
            .returning("id");
        return inserted.map((row: { id: number | string }) => Number(row.id));
    }

    const seedMany = (count: number, prefix = "Synthetic Specialty "): Promise<number[]> =>
        seed(Array.from({ length: count }, (_v, i) => ({ name: `${prefix}${padded(i + 1)}`, slug: `synthetic-specialty-${padded(i + 1)}` })));

    async function auditRows(): Promise<AuditRow[]> {
        const result = await ownerDb.raw<{ rows: AuditRow[] }>(
            `SELECT actor_user_id, actor_role, action, entity_type, entity_id, request_id, metadata
             FROM audit_logs WHERE entity_type = 'specialty' ORDER BY id`,
        );
        return result.rows;
    }

    async function dbRows(): Promise<Array<{ id: number; name: string; slug: string; description: string | null; is_active: boolean; created_at: Date; updated_at: Date }>> {
        const result = await ownerDb.raw<{ rows: Array<{ id: number; name: string; slug: string; description: string | null; is_active: boolean; created_at: Date; updated_at: Date }> }>(
            "SELECT id, name, slug, description, is_active, created_at, updated_at FROM specialties ORDER BY id",
        );
        return result.rows;
    }

    /** Asserts exactly the contract `Specialty` shape. */
    function expectSpecialty(value: unknown): SpecialtyBody {
        const [required = []] = inlineLists(schemaBlock("Specialty"), "required");
        const body = value as SpecialtyBody;
        expect(Object.keys(body).sort()).toEqual([...required].sort());
        expect(typeof body.id).toBe("number");
        expect(typeof body.name).toBe("string");
        expect(typeof body.slug).toBe("string");
        expect(body.description === null || typeof body.description === "string").toBe(true);
        expect(typeof body.isActive).toBe("boolean");
        expect(new Date(body.createdAt).toISOString()).toBe(body.createdAt);
        expect(new Date(body.updatedAt).toISOString()).toBe(body.updatedAt);
        return body;
    }

    const names = (res: { body: { data: SpecialtyBody[] } }): string[] => res.body.data.map((s) => s.name);

    beforeAll(async () => {
        await ensureRedisReady();
        fake = await startFakeJwks(["k1"]);
        wiring = await buildFakeJwksWiring(fake);
        for (const token of [TOKENS.JwksCache, TOKENS.UserTokenVerifier]) {
            previous.push({ token, value: container.isRegistered(token) ? container.resolve(token) : undefined });
        }
        container.registerInstance(TOKENS.JwksCache, wiring.cache);
        container.registerInstance(TOKENS.UserTokenVerifier, wiring.verifier);
        app = buildTestApps().publicApp; // the REAL src/routes.ts mounts the specialties router
        for (const [name, actor] of Object.entries(ACTORS) as Array<[ActorName, ActorSpec]>) {
            tokens[name] = await signUserToken(fake.key("k1"), { sub: actor.sub, role: actor.role, status: actor.status });
        }
    });

    beforeEach(async () => {
        await truncateAll();
        await flushByPrefix(["idem:", "rl:"]);
    });

    afterAll(async () => {
        await truncateAll();
        await flushByPrefix(["idem:", "rl:"]);
        for (const entry of previous) {
            if (entry.value !== undefined) container.registerInstance(entry.token, entry.value);
        }
        wiring.cache.stop();
        await fake.close();
        await closeRedis();
        await closeDb();
    });

    describe("RBAC per route", () => {
        const ROWS: Array<[string, ActorName | undefined, number]> = [
            ["unauthenticated", undefined, 401],
            ["patient active", "patient", 200],
            ["doctor active", "doctor", 200],
            ["doctor pending", "doctorPending", 200],
            ["doctor rejected", "doctorRejected", 200],
            ["admin active", "admin", 200],
            ["patient pending", "patientPending", 403],
            ["admin pending", "adminPending", 403],
            ["patient suspended", "patientSuspended", 403],
            ["doctor suspended", "doctorSuspended", 403],
            ["admin suspended", "adminSuspended", 403],
        ];

        it.each(ROWS)("should answer GET /api/specialties for %s with %i", async (_label, actor, status) => {
            await seed([{ name: "Synthetic Specialty 001", slug: "synthetic-specialty-001" }]);
            const res = await get(LIST, actor);
            expect(res.status).toBe(status);
            if (status === 200) {
                expect(names(res)).toEqual(["Synthetic Specialty 001"]);
            } else {
                expectErrorEnvelope(res.body, status === 401 ? "Unauthorized" : "Forbidden", res.headers["x-request-id"]);
            }
        });

        it.each(ROWS.map(([label, actor, status]) => [label, actor, status === 200 && actor !== "admin" ? 403 : status === 200 ? 201 : status] as const))(
            "should answer POST /api/specialties for %s with %i",
            async (_label, actor, status) => {
                const res = await post({ name: "Synthetic Created", slug: freshSlug() }, actor);
                expect(res.status).toBe(status);
                if (status === 201) {
                    expectSpecialty(expectSuccessEnvelope(res.body));
                } else {
                    expectErrorEnvelope(res.body, status === 401 ? "Unauthorized" : "Forbidden");
                    expect(await dbRows()).toEqual([]);
                    expect(await auditRows()).toEqual([]);
                }
            },
        );

        it.each(ROWS.map(([label, actor, status]) => [label, actor, status === 200 && actor !== "admin" ? 403 : status] as const))(
            "should answer PATCH /api/specialties/{id} for %s with %i",
            async (_label, actor, status) => {
                const [id = 0] = await seed([{ name: "Synthetic Specialty 001", slug: "synthetic-specialty-001" }]);
                const res = await patch(id, { name: "Synthetic Renamed" }, actor);
                expect(res.status).toBe(status);
                if (status === 200) {
                    expect(expectSpecialty(expectSuccessEnvelope(res.body)).name).toBe("Synthetic Renamed");
                } else {
                    expectErrorEnvelope(res.body, status === 401 ? "Unauthorized" : "Forbidden");
                    expect((await dbRows())[0]?.name).toBe("Synthetic Specialty 001");
                    expect(await auditRows()).toEqual([]);
                }
            },
        );

        it("should answer 401 TokenExpired for an expired token on every route", async () => {
            const expired = await signExpiredUserToken(fake.key("k1"), { sub: "303", role: "admin", status: "active" });
            for (const res of [
                await request(app).get(LIST).set("Authorization", `Bearer ${expired}`),
                await request(app).post(LIST).set("Authorization", `Bearer ${expired}`).send({ name: "Ab", slug: "ab" }),
                await request(app).patch(`${LIST}/1`).set("Authorization", `Bearer ${expired}`).send({ name: "Ab" }),
            ]) {
                expect(res.status).toBe(401);
                expectErrorEnvelope(res.body, "TokenExpired");
            }
        });

        it("should ignore X-Role and X-User-Id headers and answer 403 on POST for a patient token", async () => {
            const res = await post({ name: "Synthetic Created", slug: freshSlug() }, "patient", { "X-Role": "admin", "X-User-Id": "303" });
            expect(res.status).toBe(403);
            expectErrorEnvelope(res.body, "Forbidden");
            expect(await dbRows()).toEqual([]);
        });

        it("should answer 403 for a patient on PATCH with a non-numeric id because the role is checked before the id", async () => {
            const res = await patch("abc", { name: "Synthetic Renamed" }, "patient");
            expect(res.status).toBe(403);
            expectErrorEnvelope(res.body, "Forbidden");
        });

        it.each([["abc"], ["0"], ["007"], ["9007199254740993"], ["999999"], ["-1"], ["1.5"]])(
            "should answer 404 NotFound for an admin PATCH on id %s (S-R13)",
            async (id) => {
                const res = await patch(id, { name: "Synthetic Renamed" }, "admin");
                expect(res.status).toBe(404);
                expectErrorEnvelope(res.body, "NotFound");
                expect(await auditRows()).toEqual([]);
            },
        );

        it("should expose no DELETE route (S-R3)", async () => {
            const [id = 0] = await seed([{ name: "Synthetic Specialty 001", slug: "synthetic-specialty-001" }]);
            const res = await request(app).delete(`${LIST}/${id}`).set("Authorization", `Bearer ${tokens.admin}`);
            expect(res.status).toBe(404);
            expect(await dbRows()).toHaveLength(1);
        });
    });

    describe("GET /api/specialties", () => {
        it("should return only active rows for a patient and a doctor even with includeInactive=true (S-R6)", async () => {
            await seed([
                { name: "Synthetic Active", slug: "synthetic-active" },
                { name: "Synthetic Inactive", slug: "synthetic-inactive", isActive: false },
            ]);
            for (const actor of ["patient", "doctor", "doctorPending"] as const) {
                const res = await get(`${LIST}?includeInactive=true`, actor);
                expect(res.status).toBe(200);
                expect(names(res)).toEqual(["Synthetic Active"]);
            }
        });

        it("should return inactive rows to an admin only with includeInactive=true (S-R6, #8 over HTTP)", async () => {
            await seed([
                { name: "Synthetic Active", slug: "synthetic-active" },
                { name: "Synthetic Inactive", slug: "synthetic-inactive", isActive: false },
            ]);
            expect(names(await get(`${LIST}?includeInactive=true`, "admin"))).toEqual(["Synthetic Active", "Synthetic Inactive"]);
            expect(names(await get(`${LIST}?includeInactive=false`, "admin"))).toEqual(["Synthetic Active"]);
            expect(names(await get(LIST, "admin"))).toEqual(["Synthetic Active"]);
        });

        it.each([["includeInactive=yes"], ["includeInactive=1"], ["includeInactive=TRUE"], ["includeInactive="], ["includeInactive=true&includeInactive=false"]])(
            "should answer 400 for %s for a patient and an admin (S-R7)",
            async (query) => {
                for (const actor of ["patient", "admin"] as const) {
                    const res = await get(`${LIST}?${query}`, actor);
                    expect(res.status).toBe(400);
                    expectErrorEnvelope(res.body, "ValidationFailed");
                    expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain("includeInactive");
                }
            },
        );

        it.each([["limit=0"], ["limit=101"], ["limit=1e1"], ["limit=05"], ["sort=name"], [`cursor=${"a".repeat(513)}`]])(
            "should answer 400 for the query %s",
            async (query) => {
                const res = await get(`${LIST}?${query}`, "patient");
                expect(res.status).toBe(400);
                expectErrorEnvelope(res.body, "ValidationFailed");
            },
        );

        it("should reach page 2 and the last page on the default sort without duplicates (S-R8)", async () => {
            await seedMany(45);
            const expectedNames = Array.from({ length: 45 }, (_v, i) => `Synthetic Specialty ${padded(i + 1)}`);

            const first = await get(LIST, "patient");
            expect(first.status).toBe(200);
            expect(names(first)).toEqual(expectedNames.slice(0, 20));
            const meta1 = expectPaginationMeta(first.body.meta);
            expect(meta1).toMatchObject({ hasMore: true, count: 20 });
            expect(meta1.nextCursor).not.toBeNull();

            const second = await get(`${LIST}?cursor=${meta1.nextCursor}`, "patient");
            expect(second.status).toBe(200);
            expect(names(second)).toEqual(expectedNames.slice(20, 40));
            const meta2 = expectPaginationMeta(second.body.meta);
            expect(meta2).toMatchObject({ hasMore: true, count: 20 });

            const third = await get(`${LIST}?cursor=${meta2.nextCursor}`, "patient");
            expect(third.status).toBe(200);
            expect(names(third)).toEqual(expectedNames.slice(40));
            expect(expectPaginationMeta(third.body.meta)).toEqual({ nextCursor: null, hasMore: false, count: 5 });

            const all = [...first.body.data, ...second.body.data, ...third.body.data].map((s: SpecialtyBody) => s.id);
            expect(new Set(all).size).toBe(45);
            for (const page of [first, second, third]) {
                for (const item of page.body.data) expectSpecialty(item);
            }
        });

        it("should report hasMore false with a null cursor when the rows exactly fill the limit", async () => {
            await seedMany(3);
            const res = await get(`${LIST}?limit=3`, "patient");
            expect(expectPaginationMeta(res.body.meta)).toEqual({ nextCursor: null, hasMore: false, count: 3 });
            const split = await get(`${LIST}?limit=2`, "patient");
            expect(expectPaginationMeta(split.body.meta)).toMatchObject({ hasMore: true, count: 2 });
        });

        it("should skip inactive rows inside pages for a patient while the cursor stays valid", async () => {
            await seed(
                Array.from({ length: 12 }, (_v, i) => ({
                    name: `Synthetic Specialty ${padded(i + 1)}`,
                    slug: `synthetic-specialty-${padded(i + 1)}`,
                    isActive: i % 2 === 0,
                })),
            );
            const first = await get(`${LIST}?limit=4`, "patient");
            expect(names(first)).toEqual(["Synthetic Specialty 001", "Synthetic Specialty 003", "Synthetic Specialty 005", "Synthetic Specialty 007"]);
            const second = await get(`${LIST}?limit=4&cursor=${first.body.meta.nextCursor}`, "patient");
            expect(names(second)).toEqual(["Synthetic Specialty 009", "Synthetic Specialty 011"]);
            expect(second.body.meta.hasMore).toBe(false);
        });

        it("should continue correctly when the cursor row is deactivated between pages (position, not grant)", async () => {
            await seedMany(6);
            const first = await get(`${LIST}?limit=3`, "patient");
            expect(names(first)).toEqual(["Synthetic Specialty 001", "Synthetic Specialty 002", "Synthetic Specialty 003"]);
            await ownerDb("specialties").where({ name: "Synthetic Specialty 003" }).update({ is_active: false });
            const second = await get(`${LIST}?limit=3&cursor=${first.body.meta.nextCursor}`, "patient");
            expect(second.status).toBe(200);
            expect(names(second)).toEqual(["Synthetic Specialty 004", "Synthetic Specialty 005", "Synthetic Specialty 006"]);
        });

        it("should keep the caller's filters on every page because a cursor is a position, not a grant", async () => {
            await seed([
                { name: "Synthetic A", slug: "synthetic-a" },
                { name: "Synthetic B", slug: "synthetic-b", isActive: false },
                { name: "Synthetic C", slug: "synthetic-c" },
            ]);
            const adminPage = await get(`${LIST}?includeInactive=true&limit=1`, "admin");
            const patientPage = await get(`${LIST}?includeInactive=true&limit=5&cursor=${adminPage.body.meta.nextCursor}`, "patient");
            expect(names(patientPage)).toEqual(["Synthetic C"]);
        });

        it.each([
            ["a tampered cursor", "not-a-cursor!"],
            ["a numeric sortValue", encodeCursor(5, 1)],
            ["a 101-character name position", encodeCursor("x".repeat(101), 1)],
        ])("should answer 400 on the cursor field for %s", async (_label, cursor) => {
            const res = await get(`${LIST}?cursor=${encodeURIComponent(cursor)}`, "patient");
            expect(res.status).toBe(400);
            expectErrorEnvelope(res.body, "ValidationFailed");
            expect(res.body.error.details).toEqual([{ field: "cursor", issue: "is invalid" }]);
        });

        it("should return an empty page with the contract meta when there are no rows", async () => {
            const res = await get(LIST, "patient");
            expect(res.status).toBe(200);
            expect(expectSuccessEnvelope(res.body)).toEqual([]);
            expect(expectPaginationMeta(res.body.meta)).toEqual({ nextCursor: null, hasMore: false, count: 0 });
        });

        it("should not leak any column outside the contract in a list item", async () => {
            await seed([{ name: "Synthetic Specialty 001", slug: "synthetic-specialty-001", description: "text" }]);
            const res = await get(LIST, "admin");
            expectSpecialty(res.body.data[0]);
            expect(JSON.stringify(res.body)).not.toMatch(/is_active|created_at|updated_at|deleted_at/);
        });
    });

    describe("POST /api/specialties", () => {
        it("should answer 201 with the contract Specialty and write one row and one audit row (S-R4, S-R9)", async () => {
            const requestId = randomUUID();
            const res = await post({ name: "Synthetic Created", slug: "synthetic-created" }, "admin", { "X-Request-Id": requestId });
            expect(res.status).toBe(201);
            expect(res.headers["x-request-id"]).toBe(requestId);
            const body = expectSpecialty(expectSuccessEnvelope(res.body));
            expect(body).toMatchObject({ name: "Synthetic Created", slug: "synthetic-created", description: null, isActive: true });
            expect(await dbRows()).toEqual([expect.objectContaining({ id: body.id, name: "Synthetic Created", is_active: true })]);
            expect(await auditRows()).toEqual([
                {
                    actor_user_id: 303,
                    actor_role: "admin",
                    action: "specialty.created",
                    entity_type: "specialty",
                    entity_id: body.id,
                    request_id: requestId,
                    metadata: {},
                },
            ]);
        });

        it("should store the description when given", async () => {
            const res = await post({ name: "Synthetic Created", slug: "synthetic-created", description: "Synthetic text." }, "admin");
            expect(res.status).toBe(201);
            expect(res.body.data.description).toBe("Synthetic text.");
        });

        it.each([
            ["slug", { name: "Synthetic Other", slug: "synthetic-existing" }],
            ["name", { name: "Synthetic Existing", slug: "synthetic-other" }],
        ])("should answer 409 Conflict with details field %s for a duplicate and leave no audit row (S-R1, S-R10)", async (field, body) => {
            await seed([{ name: "Synthetic Existing", slug: "synthetic-existing" }]);
            const res = await post(body, "admin");
            expect(res.status).toBe(409);
            expectErrorEnvelope(res.body, "Conflict");
            expect(res.body.error.details).toEqual([{ field, issue: "is already in use" }]);
            expect(await dbRows()).toHaveLength(1);
            expect(await auditRows()).toEqual([]);
        });

        it("should treat Cardiology and cardiology as different names because uniqueness is case-sensitive (D3)", async () => {
            await seed([{ name: "Cardiology", slug: "cardiology" }]);
            const res = await post({ name: "cardiology", slug: "cardiology-lower" }, "admin");
            expect(res.status).toBe(201);
        });

        it("should not trim or lower-case the stored name", async () => {
            const res = await post({ name: "  Padded Name ", slug: freshSlug() }, "admin");
            expect(res.status).toBe(201);
            expect(res.body.data.name).toBe("  Padded Name ");
        });

        it.each([
            ["a 1-character name", { name: "A", slug: "ok" }],
            ["a 101-character name", { name: "A".repeat(101), slug: "ok" }],
            ["a missing name", { slug: "ok" }],
            ["a missing slug", { name: "Okay" }],
            ["an upper-case slug", { name: "Okay", slug: "Bad_Slug" }],
            ["a slug starting with a dash", { name: "Okay", slug: "-a" }],
            ["a slug with a double dash", { name: "Okay", slug: "a--b" }],
            ["a 101-character slug", { name: "Okay", slug: "a".repeat(101) }],
            ["a 2001-character description", { name: "Okay", slug: "ok", description: "d".repeat(2001) }],
            ["a null description", { name: "Okay", slug: "ok", description: null }],
            ["an isActive member", { name: "Okay", slug: "ok", isActive: false }],
            ["an id member", { name: "Okay", slug: "ok", id: 9 }],
            ["an unknown member", { name: "Okay", slug: "ok", extra: 1 }],
        ])("should answer 400 ValidationFailed for %s", async (_label, body) => {
            const res = await post(body, "admin");
            expect(res.status).toBe(400);
            expectErrorEnvelope(res.body, "ValidationFailed");
            expect(await dbRows()).toEqual([]);
            expect(await auditRows()).toEqual([]);
        });

        it("should answer 400 for a non-object body and for malformed JSON", async () => {
            const array = await post([1], "admin");
            expect(array.status).toBe(400);
            expectErrorEnvelope(array.body, "ValidationFailed");
            const malformed = await request(app)
                .post(LIST)
                .set("Authorization", `Bearer ${tokens.admin}`)
                .set("Content-Type", "application/json")
                .send("{not json");
            expect(malformed.status).toBe(400);
            expectErrorEnvelope(malformed.body, "ValidationFailed");
        });

        it("should replay the original 201 for the same key and body with one row and one audit row (S-R14)", async () => {
            const key = randomUUID();
            const body = { name: "Synthetic Created", slug: "synthetic-created" };
            const first = await post(body, "admin", { "Idempotency-Key": key });
            const second = await post(body, "admin", { "Idempotency-Key": key });
            expect(first.status).toBe(201);
            expect(second.status).toBe(201);
            expect(second.body).toEqual(first.body);
            expect(await dbRows()).toHaveLength(1);
            expect(await auditRows()).toHaveLength(1);
        });

        it("should answer 422 IdempotencyConflict for the same key with a different body (S-R14)", async () => {
            const key = randomUUID();
            await post({ name: "Synthetic Created", slug: "synthetic-created" }, "admin", { "Idempotency-Key": key });
            const res = await post({ name: "Synthetic Different", slug: "synthetic-different" }, "admin", { "Idempotency-Key": key });
            expect(res.status).toBe(422);
            expectErrorEnvelope(res.body, "IdempotencyConflict");
            expect(await dbRows()).toHaveLength(1);
        });

        it("should answer 400 for an Idempotency-Key that is not a UUID", async () => {
            const res = await post({ name: "Synthetic Created", slug: "synthetic-created" }, "admin", { "Idempotency-Key": "not-a-uuid" });
            expect(res.status).toBe(400);
            expectErrorEnvelope(res.body, "ValidationFailed");
            expect(await dbRows()).toEqual([]);
        });

        it("should answer 201 then 409 for the same body twice without a key because the key is optional (S-R14)", async () => {
            const body = { name: "Synthetic Created", slug: "synthetic-created" };
            expect((await post(body, "admin")).status).toBe(201);
            const second = await post(body, "admin");
            expect(second.status).toBe(409);
            expectErrorEnvelope(second.body, "Conflict");
        });

        it("should answer exactly one 201 and one 409 for two parallel creates of one slug (S-R17)", async () => {
            const [a, b] = await Promise.all([
                post({ name: "Synthetic Race A", slug: "synthetic-race" }, "admin", { "Idempotency-Key": randomUUID() }),
                post({ name: "Synthetic Race B", slug: "synthetic-race" }, "admin", { "Idempotency-Key": randomUUID() }),
            ]);
            expect([a.status, b.status].sort()).toEqual([201, 409]);
            expect(await dbRows()).toHaveLength(1);
            expect(await auditRows()).toHaveLength(1);
        });

        it("should answer 500 InternalError and leave no specialties row when the audit insert fails (S-R10)", async () => {
            await ownerDb.raw("ALTER TABLE audit_logs ADD CONSTRAINT chk_test_block_specialty CHECK (action <> 'specialty.created')");
            try {
                const res = await post({ name: "Synthetic Created", slug: "synthetic-created" }, "admin");
                expect(res.status).toBe(500);
                expectErrorEnvelope(res.body, "InternalError");
            } finally {
                await ownerDb.raw("ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS chk_test_block_specialty");
            }
            expect(await dbRows()).toEqual([]);
            expect(await auditRows()).toEqual([]);
        });
    });

    describe("PATCH /api/specialties/{id}", () => {
        it("should rename and answer 200 with a newer updated_at and one audit row for name (S-R9)", async () => {
            const [id = 0] = await seed([{ name: "Synthetic Specialty 001", slug: "synthetic-specialty-001", description: "text" }]);
            const requestId = randomUUID();
            const res = await patch(id, { name: "Synthetic Renamed" }, "admin", { "X-Request-Id": requestId });
            expect(res.status).toBe(200);
            const body = expectSpecialty(expectSuccessEnvelope(res.body));
            expect(body).toMatchObject({ id, name: "Synthetic Renamed", slug: "synthetic-specialty-001", description: "text" });
            expect(new Date(body.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(body.createdAt).getTime());
            const row = (await dbRows())[0];
            expect(row?.updated_at.getTime()).toBeGreaterThan(row?.created_at.getTime() ?? 0);
            expect(await auditRows()).toEqual([
                {
                    actor_user_id: 303,
                    actor_role: "admin",
                    action: "specialty.updated",
                    entity_type: "specialty",
                    entity_id: id,
                    request_id: requestId,
                    metadata: { changedFields: "name" },
                },
            ]);
        });

        it("should audit description,isActive,slug sorted for a three-field change and never audit values", async () => {
            const [id = 0] = await seed([{ name: "Synthetic Specialty 001", slug: "synthetic-specialty-001", description: "text" }]);
            const res = await patch(id, { slug: "synthetic-new-slug", description: DESCRIPTION_FIXTURE, isActive: false }, "admin");
            expect(res.status).toBe(200);
            const audit = await auditRows();
            expect(audit).toHaveLength(1);
            expect(audit[0]?.metadata).toEqual({ changedFields: "description,isActive,slug" });
            expect(JSON.stringify(audit)).not.toContain(DESCRIPTION_FIXTURE);
            expect(JSON.stringify(audit)).not.toContain("synthetic-new-slug");
        });

        it("should clear the description with null (S-R12)", async () => {
            const [id = 0] = await seed([{ name: "Synthetic Specialty 001", slug: "synthetic-specialty-001", description: "text" }]);
            const res = await patch(id, { description: null }, "admin");
            expect(res.status).toBe(200);
            expect(res.body.data.description).toBeNull();
            expect((await dbRows())[0]?.description).toBeNull();
        });

        it("should hide a deactivated row from patients, show it to admins with includeInactive, and allow reactivation (S-R5, S-R6)", async () => {
            const [id = 0] = await seed([{ name: "Synthetic Specialty 001", slug: "synthetic-specialty-001" }]);
            expect((await patch(id, { isActive: false }, "admin")).body.data.isActive).toBe(false);
            expect(names(await get(LIST, "patient"))).toEqual([]);
            expect(names(await get(`${LIST}?includeInactive=true`, "admin"))).toEqual(["Synthetic Specialty 001"]);
            expect((await patch(id, { isActive: true }, "admin")).body.data.isActive).toBe(true);
            expect(names(await get(LIST, "patient"))).toEqual(["Synthetic Specialty 001"]);
            expect(await auditRows()).toHaveLength(2);
        });

        it("should answer 200 with an identical body, an unchanged updated_at, and no audit row for a no-op (S-R11)", async () => {
            const [id = 0] = await seed([{ name: "Synthetic Specialty 001", slug: "synthetic-specialty-001", description: "text" }]);
            const before = (await get(LIST, "patient")).body.data[0];
            const updatedBefore = (await dbRows())[0]?.updated_at.getTime();
            const res = await patch(id, { name: "Synthetic Specialty 001", slug: "synthetic-specialty-001", description: "text", isActive: true }, "admin");
            expect(res.status).toBe(200);
            expect(res.body.data).toEqual(before);
            expect((await dbRows())[0]?.updated_at.getTime()).toBe(updatedBefore);
            expect(await auditRows()).toEqual([]);
        });

        it("should answer 200 and audit nothing for a no-op description null on a null description (S-R11)", async () => {
            const [id = 0] = await seed([{ name: "Synthetic Specialty 001", slug: "synthetic-specialty-001", description: null }]);
            expect((await patch(id, { description: null }, "admin")).status).toBe(200);
            expect(await auditRows()).toEqual([]);
        });

        it("should audit only the changed names when the PATCH is partly equal (S-R11)", async () => {
            const [id = 0] = await seed([{ name: "Synthetic Specialty 001", slug: "synthetic-specialty-001" }]);
            const res = await patch(id, { name: "Synthetic Specialty 001", isActive: false }, "admin");
            expect(res.status).toBe(200);
            expect((await auditRows())[0]?.metadata).toEqual({ changedFields: "isActive" });
        });

        it("should answer 200 and not 409 when the slug is the row's own current slug", async () => {
            const [id = 0] = await seed([{ name: "Synthetic Specialty 001", slug: "synthetic-specialty-001" }]);
            const res = await patch(id, { slug: "synthetic-specialty-001", name: "Synthetic Renamed" }, "admin");
            expect(res.status).toBe(200);
        });

        it.each([
            ["slug", { slug: "synthetic-two" }],
            ["name", { name: "Synthetic Two" }],
        ])("should answer 409 on field %s for another row's value, leaving the row and the audit table unchanged (S-R1, S-R10)", async (field, body) => {
            const [one = 0] = await seed([
                { name: "Synthetic One", slug: "synthetic-one" },
                { name: "Synthetic Two", slug: "synthetic-two" },
            ]);
            const before = await dbRows();
            const res = await patch(one, body, "admin");
            expect(res.status).toBe(409);
            expectErrorEnvelope(res.body, "Conflict");
            expect(res.body.error.details).toEqual([{ field, issue: "is already in use" }]);
            expect(await dbRows()).toEqual(before);
            expect(await auditRows()).toEqual([]);
        });

        it.each([
            ["an empty body", {}],
            ["a null name", { name: null }],
            ["a null slug", { slug: null }],
            ["a null isActive", { isActive: null }],
            ["a string isActive", { isActive: "false" }],
            ["a createdAt member", { createdAt: "2026-01-01T00:00:00Z" }],
            ["an invalid slug", { slug: "Bad Slug" }],
            ["a 1-character name", { name: "x" }],
        ])("should answer 400 ValidationFailed for %s (S-R12)", async (_label, body) => {
            const [id = 0] = await seed([{ name: "Synthetic Specialty 001", slug: "synthetic-specialty-001" }]);
            const res = await patch(id, body, "admin");
            expect(res.status).toBe(400);
            expectErrorEnvelope(res.body, "ValidationFailed");
            expect(await auditRows()).toEqual([]);
        });

        it("should describe the empty-body failure on the body field", async () => {
            const [id = 0] = await seed([{ name: "Synthetic Specialty 001", slug: "synthetic-specialty-001" }]);
            const res = await patch(id, {}, "admin");
            expect(res.body.error.details).toEqual([{ field: "body", issue: "must contain at least one property" }]);
        });

        it("should answer 404 for an unknown numeric id after validating nothing else", async () => {
            const res = await patch(424242, { name: "Synthetic Renamed" }, "admin");
            expect(res.status).toBe(404);
            expectErrorEnvelope(res.body, "NotFound");
        });

        it("should ignore an Idempotency-Key header on PATCH because the contract declares none", async () => {
            const [id = 0] = await seed([{ name: "Synthetic Specialty 001", slug: "synthetic-specialty-001" }]);
            const key = randomUUID();
            expect((await patch(id, { name: "Synthetic First" }, "admin", { "Idempotency-Key": key })).status).toBe(200);
            expect((await patch(id, { name: "Synthetic Second" }, "admin", { "Idempotency-Key": key })).body.data.name).toBe("Synthetic Second");
        });

        it("should serialise two parallel renames to the same name into one 200 and one 409", async () => {
            const [one = 0, two = 0] = await seed([
                { name: "Synthetic One", slug: "synthetic-one" },
                { name: "Synthetic Two", slug: "synthetic-two" },
            ]);
            const [a, b] = await Promise.all([patch(one, { name: "Synthetic Target" }, "admin"), patch(two, { name: "Synthetic Target" }, "admin")]);
            expect([a.status, b.status].sort()).toEqual([200, 409]);
            expect(await auditRows()).toHaveLength(1);
        });
    });

    describe("rate limit on GET (S-R15)", () => {
        const ipKeys = async (): Promise<string[]> => {
            const found: string[] = [];
            for (const ip of ["127.0.0.1", "::1"]) {
                const key = `rl:specialties-list-ip:${ip}`;
                if ((await redis.exists(key)) === 1) found.push(key);
            }
            return found;
        };

        it("should store hits under the IP and user limiter keys after one patient GET", async () => {
            expect((await get(LIST, "patient")).status).toBe(200);
            expect(await ipKeys()).toHaveLength(1);
            expect(await redis.exists("rl:specialties-list-user:101")).toBe(1);
            expect(await redis.exists("rl:specialties-list-user:303")).toBe(0);
        });

        it("should answer 429 RateLimited with Retry-After on the 61st GET within a minute from one IP", async () => {
            const statuses: number[] = [];
            for (let index = 0; index < 60; index += 1) {
                statuses.push((await get(LIST, "patient")).status);
            }
            expect(statuses.every((status) => status === 200)).toBe(true);
            const limited = await get(LIST, "patient");
            expect(limited.status).toBe(429);
            expectErrorEnvelope(limited.body, "RateLimited", limited.headers["x-request-id"]);
            expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
        });

        it("should shed unauthenticated floods before the guard once the IP limit is spent", async () => {
            for (let index = 0; index < 60; index += 1) {
                expect((await get(LIST)).status).toBe(401);
            }
            const limited = await get(LIST);
            expect(limited.status).toBe(429);
            expectErrorEnvelope(limited.body, "RateLimited");
        });

        it("should not rate limit POST or PATCH", async () => {
            const [id = 0] = await seed([{ name: "Synthetic Specialty 001", slug: "synthetic-specialty-001" }]);
            for (let index = 0; index < 12; index += 1) {
                expect((await patch(id, { name: `Synthetic Name ${index}` }, "admin")).status).toBe(200);
            }
        });
    });

    describe("database: grants, checks, and index", () => {
        const insertSql = (name: string, slug: string, description: string | null = null): string =>
            `INSERT INTO specialties (name, slug, description, is_active) VALUES ('${name}', '${slug}', ${description === null ? "NULL" : `'${description}'`}, true)`;

        it("should reject DELETE and TRUNCATE for care_app with 42501 (S-R3)", async () => {
            await seed([{ name: "Synthetic Specialty 001", slug: "synthetic-specialty-001" }]);
            await expect(db.raw("DELETE FROM specialties")).rejects.toMatchObject({ code: "42501" });
            await expect(db.raw("TRUNCATE specialties")).rejects.toMatchObject({ code: "42501" });
            expect(await dbRows()).toHaveLength(1);
        });

        it("should allow SELECT, INSERT, and UPDATE for care_app", async () => {
            await db.raw(insertSql("Synthetic Grant", "synthetic-grant"));
            await db.raw("UPDATE specialties SET description = 'x' WHERE slug = 'synthetic-grant'");
            const result = await db.raw<{ rows: Array<{ description: string }> }>("SELECT description FROM specialties WHERE slug = 'synthetic-grant'");
            expect(result.rows[0]?.description).toBe("x");
        });

        it("should grant vcare_app exactly SELECT, INSERT, UPDATE and sequence USAGE", async () => {
            const result = await ownerDb.raw<{ rows: Array<Record<string, boolean>> }>(
                `SELECT has_table_privilege('vcare_app', 'specialties', 'SELECT') AS sel,
                        has_table_privilege('vcare_app', 'specialties', 'INSERT') AS ins,
                        has_table_privilege('vcare_app', 'specialties', 'UPDATE') AS upd,
                        has_table_privilege('vcare_app', 'specialties', 'DELETE') AS del,
                        has_table_privilege('vcare_app', 'specialties', 'TRUNCATE') AS trunc,
                        has_sequence_privilege('vcare_app', 'specialties_id_seq', 'USAGE') AS seq`,
            );
            expect(result.rows[0]).toEqual({ sel: true, ins: true, upd: true, del: false, trunc: false, seq: true });
        });

        it.each([
            ["a slug with an underscore", insertSql("Synthetic Check", "Bad_Slug"), "chk_specialties_slug_format"],
            ["a 1-character name", insertSql("A", "ok-slug"), "chk_specialties_name_length"],
            ["a 2001-character description", insertSql("Synthetic Check", "ok-slug", "d".repeat(2001)), "chk_specialties_description_length"],
        ])("should reject %s at the database with 23514", async (_label, sql, constraint) => {
            await expect(ownerDb.raw(sql)).rejects.toMatchObject({ code: "23514", constraint });
        });

        it("should reject an INSERT that omits is_active because the column has no default", async () => {
            await expect(ownerDb.raw("INSERT INTO specialties (name, slug) VALUES ('Synthetic NoState', 'synthetic-nostate')")).rejects.toMatchObject({
                code: "23502",
            });
        });

        it("should enforce case-sensitive unique name and slug with the named constraints", async () => {
            await ownerDb.raw(insertSql("Synthetic Unique", "synthetic-unique"));
            await expect(ownerDb.raw(insertSql("Synthetic Unique", "synthetic-other"))).rejects.toMatchObject({ constraint: "uq_specialties_name" });
            await expect(ownerDb.raw(insertSql("Synthetic Other", "synthetic-unique"))).rejects.toMatchObject({ constraint: "uq_specialties_slug" });
            await expect(ownerDb.raw(insertSql("synthetic unique", "synthetic-lower"))).resolves.toBeDefined();
        });

        it("should store timestamps as timestamptz and index (name, id)", async () => {
            const columns = await ownerDb.raw<{ rows: Array<{ column_name: string; data_type: string }> }>(
                `SELECT column_name, data_type FROM information_schema.columns
                 WHERE table_name = 'specialties' AND column_name IN ('created_at', 'updated_at')`,
            );
            expect(columns.rows.map((row) => row.data_type)).toEqual(["timestamp with time zone", "timestamp with time zone"]);
            const index = await ownerDb.raw<{ rows: Array<{ indexdef: string }> }>(
                "SELECT indexdef FROM pg_indexes WHERE tablename = 'specialties' AND indexname = 'idx_specialties_name_id'",
            );
            expect(index.rows[0]?.indexdef).toContain("(name, id)");
        });

        it("should scan idx_specialties_name_id with no Sort node for the keyset page query when seq scans are disabled", async () => {
            await seedMany(30);
            await ownerDb.raw("ANALYZE specialties");
            const built = listSpecialtiesQuery({ includeInactive: false, after: { sortValue: "M", id: 1 }, fetch: 21 }, db).toSQL();
            const plan = await db.transaction(async (trx) => {
                await trx.raw("SET LOCAL enable_seqscan = off");
                await trx.raw("SET LOCAL enable_bitmapscan = off"); // a bitmap scan would need a Sort; we prove the ordered index path exists
                const result = await trx.raw<{ rows: Array<{ "QUERY PLAN": unknown }> }>(`EXPLAIN (FORMAT JSON) ${built.sql}`, built.bindings as never[]);
                return JSON.stringify(result.rows[0]?.["QUERY PLAN"]);
            });
            expect(plan).toContain("idx_specialties_name_id");
            expect(plan).not.toContain('"Node Type":"Sort"');
        });
    });

    describe("logs and privacy", () => {
        it("should keep tokens, authorization values, and body fixtures out of captured logs and log only the two route patterns", async () => {
            jest.replaceProperty(logger as unknown as { level: string }, "level", "debug");
            const capture = captureLogs();
            try {
                const created = await post({ name: "Synthetic Logged", slug: "synthetic-logged", description: DESCRIPTION_FIXTURE }, "admin");
                const id = created.body.data.id as number;
                await patch(id, { description: `${DESCRIPTION_FIXTURE}-2` }, "admin");
                await patch("abc", { name: "Synthetic Renamed" }, "admin");
                await get(LIST, "patient");
                await get(LIST);
                await post({ name: "Synthetic Logged", slug: "synthetic-logged" }, "admin");
                await post({ name: "Synthetic Denied", slug: "synthetic-denied" }, "patient");
            } finally {
                capture.restore();
                jest.restoreAllMocks();
            }
            expectNoSensitiveStrings(capture, [
                DESCRIPTION_FIXTURE,
                ...Object.values(tokens),
                "Bearer ",
                "Synthetic Logged",
                "synthetic-logged",
            ]);
            const completed = capture.lines().filter((line) => line.message === "request_completed");
            expect(completed.length).toBeGreaterThanOrEqual(7);
            for (const line of completed) {
                expect(["/api/specialties", "/api/specialties/:id"]).toContain(line.route);
            }
        });

        it("should never include secrets or hashes in any response", async () => {
            await seedMany(2);
            const bodies = [JSON.stringify((await get(LIST, "admin")).body), JSON.stringify((await post({ name: "Synthetic New", slug: freshSlug() }, "admin")).body)];
            for (const body of bodies) {
                expect(body).not.toMatch(/password|token|secret|hash/i);
            }
        });
    });

    describe("contract conformance", () => {
        it("should still declare POST /api/specialties as idempotent with a Conflict 409 response", () => {
            expect(idempotentOperations()).toEqual(
                expect.arrayContaining([expect.objectContaining({ method: "POST", path: "/api/specialties", conflictResponse: "Conflict" })]),
            );
            expect(idempotentOperations().some((op) => op.method === "PATCH" && op.path === "/api/specialties/{id}")).toBe(false);
        });

        it("should have produced only statuses declared by the contract for each operation in this suite", () => {
            const expectations: Array<[string, string, "get" | "post" | "patch"]> = [
                ["GET /api/specialties", "/api/specialties", "get"],
                ["POST /api/specialties", "/api/specialties", "post"],
                ["PATCH /api/specialties/{id}", "/api/specialties/{id}", "patch"],
            ];
            for (const [key, path, method] of expectations) {
                const declared = contractResponseCodes(path, method).map(Number);
                const seen = observed.get(key);
                expect(seen).toBeDefined();
                for (const status of seen ?? []) {
                    expect(declared).toContain(status);
                }
            }
        });
    });
});
