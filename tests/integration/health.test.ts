import type Redis from "ioredis";
import type { Knex } from "knex";
import request from "supertest";
import { HealthController } from "../../src/app/health/controller/health.controller";
import { HealthService } from "../../src/app/health/service/health.service";
import { container } from "../../src/lib/di/container";
import { TOKENS } from "../../src/lib/di/tokens";
import { createKnex, db } from "../../src/lib/knex/knex";
import { ShutdownState } from "../../src/lib/lifecycle/shutdown-state";
import { redis } from "../../src/lib/redis/redis";
import { buildTestApps, withContainerOverrides } from "../helpers/app";
import {
    contractNoStoreValue,
    contractResponseCodes,
    expectErrorEnvelope,
    expectHealthLiveBody,
    expectHealthStatusBody,
} from "../helpers/contract";
import { closeDb, truncateAll } from "../helpers/db";
import { closeRedis, createUnreachableRedis, ensureRedisReady } from "../helpers/redis";
import type { ContainerOverride } from "../helpers/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Real HealthService/HealthController instances wired to the given infrastructure. The health router resolves
 * its controller when the app is built, so the apps must be built INSIDE `withContainerOverrides`.
 */
function healthWiring(deps: { db?: Knex; redis?: Redis; state?: ShutdownState }): ContainerOverride[] {
    const service = new HealthService(deps.db ?? db, deps.redis ?? redis, deps.state ?? new ShutdownState());
    return [
        ...(deps.db !== undefined ? [{ token: TOKENS.Db, value: deps.db }] : []),
        ...(deps.redis !== undefined ? [{ token: TOKENS.Redis, value: deps.redis }] : []),
        ...(deps.state !== undefined ? [{ token: TOKENS.ShutdownState, value: deps.state }] : []),
        { token: TOKENS.HealthService, value: service },
        { token: TOKENS.HealthController, value: new HealthController(service) },
    ];
}

describe("health (integration: real Postgres + Redis)", () => {
    beforeAll(async () => {
        await ensureRedisReady();
        await truncateAll();
    });

    afterAll(async () => {
        await closeRedis();
        await closeDb();
    });

    it("should return 200 {status:\"ok\"} when GET /api/health/live is called (F9)", async () => {
        const { publicApp } = buildTestApps();
        const res = await request(publicApp).get("/api/health/live");
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: "ok" });
        expectHealthLiveBody(res.body);
    });

    it("should return 200 {status:\"ok\"} when GET /internal/health/live is called on the internal app", async () => {
        const { internalApp } = buildTestApps();
        const res = await request(internalApp).get("/internal/health/live");
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: "ok" });
        expectHealthLiveBody(res.body);
    });

    it("should return 200 ok with database and redis up when both are reachable (F10)", async () => {
        const { publicApp, internalApp } = buildTestApps();
        for (const [app, path] of [
            [publicApp, "/api/health/ready"],
            [internalApp, "/internal/health/ready"],
        ] as const) {
            const res = await request(app).get(path);
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ status: "ok", checks: { database: "up", redis: "up" } });
            expectHealthStatusBody(res.body, res.status);
        }
    });

    it("should return 200 degraded when Redis is unreachable (F10, F16)", async () => {
        const unreachable = createUnreachableRedis();
        // Never connected → status is not "ready", so the probe reports down without a round trip (spec §3.1).
        // PING rejection/timeout on a ready client is covered by tests/unit/lib/redis/redis.test.ts.
        try {
            await withContainerOverrides(healthWiring({ redis: unreachable }), async () => {
                const { publicApp, internalApp } = buildTestApps();
                for (const [app, path] of [
                    [publicApp, "/api/health/ready"],
                    [internalApp, "/internal/health/ready"],
                ] as const) {
                    const res = await request(app).get(path);
                    expect(res.status).toBe(200);
                    expect(res.body).toEqual({ status: "degraded", checks: { database: "up", redis: "down" } });
                    expectHealthStatusBody(res.body, res.status);
                }
            });
        } finally {
            unreachable.disconnect();
        }
    });

    it("should return 503 down within the probe budget when Postgres is unreachable (F10)", async () => {
        const deadDb = createKnex({
            url: "postgres://care:care@127.0.0.1:1/care_test",
            poolMax: 1,
            statementTimeoutMs: 2_000,
            applicationName: "care-test",
        });
        try {
            await withContainerOverrides(healthWiring({ db: deadDb }), async () => {
                const { publicApp, internalApp } = buildTestApps();
                for (const [app, path] of [
                    [publicApp, "/api/health/ready"],
                    [internalApp, "/internal/health/ready"],
                ] as const) {
                    const startedAt = Date.now();
                    const res = await request(app).get(path);
                    expect(Date.now() - startedAt).toBeLessThan(1_500);
                    expect(res.status).toBe(503);
                    expect(res.body).toEqual({ status: "down", checks: { database: "down", redis: "up" } });
                    expectHealthStatusBody(res.body, res.status);
                }

                // Liveness never checks a dependency.
                const live = await request(publicApp).get("/api/health/live");
                expect(live.status).toBe(200);
            });
        } finally {
            await deadDb.destroy();
        }
    });

    // PRODUCT BUG (spec §3.4.4 "everything goes through Logger"; ADR 0007 log-derived metrics): createKnex
    // (src/lib/knex/knex.ts:23-46) passes no `log` option, so Knex's default logger writes a raw, ANSI-coloured
    // console.log line ("Acquire connection error: …") outside the structured JSON logger whenever the pool
    // cannot connect — exactly during a Postgres outage, when clean logs matter most.
    test.failing("should write no raw (non-JSON) console output when the Postgres pool cannot connect", async () => {
        const deadDb = createKnex({
            url: "postgres://care:care@127.0.0.1:1/care_test",
            poolMax: 1,
            statementTimeoutMs: 2_000,
            applicationName: "care-test",
        });
        const consoleCalls: unknown[][] = [];
        const spies = (["log", "warn", "error", "info", "debug"] as const).map((method) =>
            jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
                consoleCalls.push([method, ...args]);
            }),
        );
        try {
            await withContainerOverrides(healthWiring({ db: deadDb }), async () => {
                const { publicApp } = buildTestApps();
                expect((await request(publicApp).get("/api/health/ready")).status).toBe(503);
            });
        } finally {
            spies.forEach((spy) => spy.mockRestore());
            await deadDb.destroy();
        }
        expect(consoleCalls).toEqual([]);
    });

    it("should return 503 when shutdown has been marked (F10) while liveness stays 200 (F9)", async () => {
        const state = new ShutdownState();
        state.markShuttingDown();
        await withContainerOverrides(healthWiring({ state }), async () => {
            const { publicApp, internalApp } = buildTestApps();
            const ready = await request(publicApp).get("/api/health/ready");
            expect(ready.status).toBe(503);
            expect(ready.body).toEqual({ status: "down", checks: { database: "up", redis: "up" } });
            expectHealthStatusBody(ready.body, ready.status);

            expect((await request(internalApp).get("/internal/health/ready")).status).toBe(503);
            expect((await request(publicApp).get("/api/health/live")).status).toBe(200);
            expect((await request(internalApp).get("/internal/health/live")).status).toBe(200);
        });
    });

    it("should restore the real wiring after an override so later requests see the real dependencies", async () => {
        const realController = container.resolve(TOKENS.HealthController);
        await withContainerOverrides(healthWiring({ state: new ShutdownState() }), () => undefined);
        expect(container.resolve(TOKENS.HealthController)).toBe(realController);
        expect(container.resolve(TOKENS.Redis)).toBe(redis);
        expect(container.resolve(TOKENS.Db)).toBe(db);

        const { publicApp } = buildTestApps();
        expect((await request(publicApp).get("/api/health/ready")).body.status).toBe("ok");
    });

    it("should set X-Request-Id and Cache-Control no-store on health responses (F3)", async () => {
        const { publicApp, internalApp } = buildTestApps();
        const incoming = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
        for (const [app, path] of [
            [publicApp, "/api/health/live"],
            [publicApp, "/api/health/ready"],
            [internalApp, "/internal/health/live"],
            [internalApp, "/internal/health/ready"],
        ] as const) {
            const generated = await request(app).get(path);
            expect(generated.headers["x-request-id"]).toMatch(UUID);
            expect(generated.headers["cache-control"]).toBe(contractNoStoreValue());
            expect(generated.headers["content-type"]).toMatch(/^application\/json/);

            const echoed = await request(app).get(path).set("X-Request-Id", incoming);
            expect(echoed.headers["x-request-id"]).toBe(incoming);
        }
    });

    it("should ignore unknown query parameters when calling health routes", async () => {
        const { publicApp } = buildTestApps();
        const res = await request(publicApp).get("/api/health/ready?verbose=true&x=1");
        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(["checks", "status"]);
    });

    it("should return 404 for /api/health on the internal app and /internal/health on the public app (F11)", async () => {
        const { publicApp, internalApp } = buildTestApps();
        for (const [app, path] of [
            [internalApp, "/api/health/live"],
            [internalApp, "/api/health/ready"],
            [publicApp, "/internal/health/live"],
            [publicApp, "/internal/health/ready"],
            [publicApp, "/api/health"],
            [publicApp, "/api/health/other"],
            [internalApp, "/internal/health"],
        ] as const) {
            const res = await request(app).get(path);
            expect(res.status).toBe(404);
            expectErrorEnvelope(res.body, "NotFound", res.headers["x-request-id"]);
        }
    });

    it("should return 404 NotFound when an unsupported method hits a health route", async () => {
        const { publicApp } = buildTestApps();
        const res = await request(publicApp).post("/api/health/live");
        expect(res.status).toBe(404);
        expectErrorEnvelope(res.body, "NotFound");
    });

    it("should match the contract HealthLive and HealthStatus shapes and declared status codes exactly (contract conformance)", async () => {
        expect(contractResponseCodes("/api/health/live", "get")).toEqual(["200"]);
        expect(contractResponseCodes("/internal/health/live", "get")).toEqual(["200"]);
        expect(contractResponseCodes("/api/health/ready", "get")).toEqual(["200", "503"]);
        expect(contractResponseCodes("/internal/health/ready", "get")).toEqual(["200", "503"]);

        const { publicApp, internalApp } = buildTestApps();
        expectHealthLiveBody((await request(publicApp).get("/api/health/live")).body);
        expectHealthLiveBody((await request(internalApp).get("/internal/health/live")).body);
        const ready = await request(publicApp).get("/api/health/ready");
        expectHealthStatusBody(ready.body, ready.status);
        expect(["200", "503"]).toContain(String(ready.status));
    });
});
