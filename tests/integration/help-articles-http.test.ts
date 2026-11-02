import request from "supertest";
import { HELP_ARTICLES_READ_USER_LIMIT, HELP_ARTICLES_WRITE_USER_LIMIT } from "../../src/app/help-articles/constants";
import { getEnv } from "../../src/lib/config/env";
import { TOKENS } from "../../src/lib/di/tokens";
import { fallbackLimit } from "../../src/lib/rate-limit/rate-limit";
import { logger } from "../../src/lib/logger/logger";
import { redis } from "../../src/lib/redis/redis";
import { withContainerOverrides } from "../helpers/app";
import { expectErrorEnvelope } from "../helpers/contract";
import { ownerDb } from "../helpers/db";
import { BODY_MARKER, expectObservedStatusesDeclared, LIST, useHelpArticlesHarness, validCreate } from "../helpers/help-articles-harness";
import { captureLogs, expectNoSensitiveStrings } from "../helpers/log-capture";
import { createUnreachableRedis } from "../helpers/redis";

jest.setTimeout(120_000);

const CACHE_CONTROL = "private, no-cache";

describe("help-articles HTTP behaviour (integration: real wiring, real Redis)", () => {
    const h = useHelpArticlesHarness();

    describe("rate limits (HA-R20)", () => {
        it("should store read hits under rl:help-articles-read-user:<id> and write hits under rl:help-articles-write:<id>", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            expect((await h.get(LIST, "patient")).status).toBe(200);
            expect(await redis.exists("rl:help-articles-read-user:101")).toBe(1);
            expect(await redis.exists("rl:help-articles-read-user:303")).toBe(0);
            expect(await redis.exists("rl:help-articles-write:303")).toBe(0);
            expect((await h.patch(id, { title: "Synthetic Renamed" }, "admin")).status).toBe(200);
            expect(await redis.exists("rl:help-articles-write:303")).toBe(1);
            expect(await redis.exists("rl:help-articles-read-user:303")).toBe(0);
        });

        it("should answer 429 RateLimited with Retry-After and no-cache on the 121st read in a minute, shared by list and get", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            const statuses: number[] = [];
            for (let index = 0; index < HELP_ARTICLES_READ_USER_LIMIT; index += 1) {
                statuses.push((await h.get(index % 2 === 0 ? LIST : `${LIST}/${id}`, "patient")).status);
            }
            expect(statuses.every((status) => status === 200)).toBe(true);
            const limited = await h.get(LIST, "patient");
            expect(limited.status).toBe(429);
            expectErrorEnvelope(limited.body, "RateLimited", limited.headers["x-request-id"]);
            expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
            expect(limited.headers["cache-control"]).toBe(CACHE_CONTROL);
            // Per user: another reader is unaffected, and the get route is in the same bucket.
            expect((await h.get(LIST, "doctor")).status).toBe(200);
            expect((await h.get(`${LIST}/${id}`, "patient")).status).toBe(429);
        });

        it("should answer 429 on the 21st write in a minute across POST, PATCH and DELETE with one shared bucket and write nothing", async () => {
            const created: number[] = [];
            for (let index = 0; index < 8; index += 1) {
                const res = await h.post(validCreate({ title: `Synthetic Article ${index + 1}00` }), "admin");
                expect(res.status).toBe(201);
                created.push(res.body.data.id as number);
            }
            for (const id of created.slice(0, 7)) expect((await h.patch(id, { body: `SYNTHETIC-EDITED-${id}` }, "admin")).status).toBe(200);
            for (const id of created.slice(0, 5)) expect((await h.del(id, "admin")).status).toBe(204);
            // 8 + 7 + 5 = 20 writes spent.
            expect(created.length + 7 + 5).toBe(HELP_ARTICLES_WRITE_USER_LIMIT);
            const rowsBefore = await h.dbRows();
            const auditBefore = await h.auditRows();

            const post = await h.post(validCreate({ title: "Synthetic Over Limit" }), "admin");
            expect(post.status).toBe(429);
            expectErrorEnvelope(post.body, "RateLimited");
            expect(Number(post.headers["retry-after"])).toBeGreaterThanOrEqual(1);
            expect((await h.patch(created[5] ?? 0, { title: "Synthetic Over Limit" }, "admin")).status).toBe(429);
            expect((await h.del(created[6] ?? 0, "admin")).status).toBe(429);
            expect(await h.dbRows()).toEqual(rowsBefore);
            expect(await h.auditRows()).toEqual(auditBefore);

            // The limit is per user: another admin still writes, and reads by the limited admin are a separate bucket.
            expect((await h.post(validCreate({ title: "Synthetic Other Admin" }), "admin2")).status).toBe(201);
            expect((await h.get(LIST, "admin")).status).toBe(200);
        });

        it("should not spend the write bucket on unauthenticated or forbidden calls because the limiter runs after authorize", async () => {
            for (let index = 0; index < 25; index += 1) {
                expect((await h.post(validCreate({ title: `Synthetic Article ${index}00` }))).status).toBe(401);
                expect((await h.post(validCreate({ title: `Synthetic Article ${index}00` }), "patient")).status).toBe(403);
            }
            expect(await redis.exists("rl:help-articles-write:101")).toBe(0);
            expect((await h.post(validCreate(), "admin")).status).toBe(201);
        });

        it("should keep limiting with the per-instance fallback when Redis is unreachable (HA-R20)", async () => {
            const unreachable = createUnreachableRedis();
            const readCap = fallbackLimit(HELP_ARTICLES_READ_USER_LIMIT, getEnv().RATE_LIMIT_FALLBACK_DIVISOR);
            const writeCap = fallbackLimit(HELP_ARTICLES_WRITE_USER_LIMIT, getEnv().RATE_LIMIT_FALLBACK_DIVISOR);
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            try {
                await withContainerOverrides([{ token: TOKENS.Redis, value: unreachable }], async () => {
                    for (let index = 0; index < readCap; index += 1) expect((await h.get(LIST, "doctor")).status).toBe(200);
                    const readLimited = await h.get(LIST, "doctor");
                    expect(readLimited.status).toBe(429);
                    expectErrorEnvelope(readLimited.body, "RateLimited");
                    expect(Number(readLimited.headers["retry-after"])).toBeGreaterThanOrEqual(1);

                    for (let index = 0; index < writeCap; index += 1) expect((await h.patch(id, { body: `SYNTHETIC-NOOP-${index}` }, "admin")).status).toBe(200);
                    const writeLimited = await h.patch(id, { body: "SYNTHETIC-OVER" }, "admin");
                    expect(writeLimited.status).toBe(429);
                    expectErrorEnvelope(writeLimited.body, "RateLimited");
                });
            } finally {
                unreachable.disconnect();
            }
        });
    });

    describe("Cache-Control private, no-cache on every response under the prefix (HA-R21)", () => {
        it("should send it on 200 list, 200 get, 201, 200 patch and 204 delete and never no-store", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            const created = await h.post(validCreate({ title: "Synthetic Article 002" }), "admin");
            const responses = [
                await h.get(LIST, "patient"),
                await h.get(`${LIST}/${id}`, "patient"),
                await h.get(LIST, "admin"),
                created,
                await h.patch(id, { title: "Synthetic Renamed" }, "admin"),
                await h.patch(id, { title: "Synthetic Renamed" }, "admin"), // no-op 200
                await h.del(created.body.data.id as number, "admin"),
            ];
            expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 201, 200, 200, 204]);
            for (const res of responses) {
                expect(res.headers["cache-control"]).toBe(CACHE_CONTROL);
                expect(res.headers["cache-control"]).not.toContain("no-store");
            }
        });

        it("should send it on 401, 403, 404, 400, 409 and malformed-JSON responses too", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            const malformed = await request(h.app).post(LIST).set("Authorization", `Bearer ${h.tokens.admin}`).set("Content-Type", "application/json").send("{not json");
            const responses = [
                [401, await h.get(LIST)],
                [401, await h.get(`${LIST}/${id}`, undefined, { Authorization: "Bearer not-a-jwt" })],
                [403, await h.post(validCreate(), "patient")],
                [403, await h.get(LIST, "patientPending")],
                [404, await h.get(`${LIST}/999999`, "patient")],
                [404, await h.patch(999999, { title: "Synthetic Renamed" }, "admin")],
                [400, await h.get(`${LIST}?limit=0`, "patient")],
                [400, await h.post(validCreate({ title: "ab" }), "admin")],
                [400, malformed],
                [409, await h.post(validCreate({ title: "Synthetic Article 001" }), "admin")],
            ] as const;
            for (const [status, res] of responses) {
                expect([status, res.status]).toEqual([status, status]);
                expect([status, res.headers["cache-control"]]).toEqual([status, CACHE_CONTROL]);
            }
        });

        it("should send it on a 500 InternalError", async () => {
            await ownerDb.raw("ALTER TABLE audit_logs ADD CONSTRAINT chk_test_block_help CHECK (action <> 'help_article.created')");
            try {
                const res = await h.post(validCreate(), "admin");
                expect(res.status).toBe(500);
                expect(res.headers["cache-control"]).toBe(CACHE_CONTROL);
            } finally {
                await ownerDb.raw("ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS chk_test_block_help");
            }
        });

        it("should not send it outside the help-articles prefix", async () => {
            const res = await h.get("/api/specialties", "patient");
            expect(res.status).toBe(200);
            expect(res.headers["cache-control"]).not.toBe(CACHE_CONTROL);
        });
    });

    describe("logs and audit carry no article text (HA-R24)", () => {
        const TITLE = "Synthetic Logged Title 7731";

        it("should keep tokens, authorization values, titles and body fixtures out of captured logs and log only the two route patterns", async () => {
            jest.replaceProperty(logger as unknown as { level: string }, "level", "debug");
            const capture = captureLogs();
            let createdId = 0;
            try {
                const created = await h.post(validCreate({ title: TITLE, body: `${BODY_MARKER}-A` }), "admin");
                createdId = created.body.data.id as number;
                await h.get(LIST, "patient");
                await h.get(`${LIST}/${createdId}`, "patient");
                await h.get(`${LIST}?limit=1`, "admin");
                await h.patch(createdId, { body: `${BODY_MARKER}-B`, title: `${TITLE} edited` }, "admin");
                await h.patch(createdId, {}, "admin");
                await h.patch("abc", { body: `${BODY_MARKER}-C` }, "admin");
                await h.post(validCreate({ title: `${TITLE} edited`, body: `${BODY_MARKER}-D` }), "admin"); // 409
                await h.post(validCreate({ title: "ab", body: `${BODY_MARKER}-E` }), "admin"); // 400
                await h.post(validCreate({ title: TITLE, body: `${BODY_MARKER}-F` }), "patient"); // 403
                await h.post(validCreate({ title: TITLE, body: `${BODY_MARKER}-G` })); // 401
                await h.post(validCreate({ title: "Synthetic Oversized", body: "😀".repeat(50_000) }), "admin"); // 400 parser limit
                await h.get(`${LIST}/999999`, "patient"); // 404
                await h.del(createdId, "admin");
                // NOT VALID: earlier steps of this run already wrote help_article.created rows; only new inserts are refused.
                await ownerDb.raw("ALTER TABLE audit_logs ADD CONSTRAINT chk_test_block_help CHECK (action <> 'help_article.created') NOT VALID");
                try {
                    await h.post(validCreate({ title: `${TITLE} blocked`, body: `${BODY_MARKER}-H` }), "admin"); // 500, audit write fails
                } finally {
                    await ownerDb.raw("ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS chk_test_block_help");
                }
            } finally {
                capture.restore();
                jest.restoreAllMocks();
            }
            expectNoSensitiveStrings(capture, [
                BODY_MARKER,
                TITLE,
                "Synthetic Oversized",
                ...Object.values(h.tokens),
                "Bearer ",
            ]);
            const completed = capture.lines().filter((line) => line.message === "request_completed");
            expect(completed.length).toBeGreaterThanOrEqual(14);
            // A body refused by the 100 kb parser never reaches a route, so its line carries the "unmatched" label; everything else is a pattern.
            for (const line of completed) {
                expect(["/api/help-articles", "/api/help-articles/:id", "unmatched"]).toContain(line.route);
            }
            expect(completed.filter((line) => line.route === "unmatched")).toHaveLength(1);
            // The audit rows of the whole run hold ids, flags and field names only.
            const audit = JSON.stringify(await h.auditRows());
            for (const secret of [BODY_MARKER, TITLE]) expect(audit).not.toContain(secret);
            expect(JSON.parse(audit).length).toBeGreaterThanOrEqual(3);
        });
    });

    describe("contract conformance", () => {
        it("should answer every route in this suite with a status the contract declares", () => {
            expectObservedStatusesDeclared(h, [
                ["GET /api/help-articles", "/api/help-articles", "get"],
                ["POST /api/help-articles", "/api/help-articles", "post"],
                ["PATCH /api/help-articles/{id}", "/api/help-articles/{id}", "patch"],
                ["DELETE /api/help-articles/{id}", "/api/help-articles/{id}", "delete"],
            ]);
        });
    });
});
