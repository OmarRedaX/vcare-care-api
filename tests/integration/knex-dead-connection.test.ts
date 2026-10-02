import type { Knex } from "knex";
import request from "supertest";
import { HealthController } from "../../src/app/health/controller/health.controller";
import { HealthService } from "../../src/app/health/service/health.service";
import type { JwksStatusSource } from "../../src/lib/auth/types";
import { container } from "../../src/lib/di/container";
import { TOKENS } from "../../src/lib/di/tokens";
import { createKnex } from "../../src/lib/knex/knex";
import { ShutdownState } from "../../src/lib/lifecycle/shutdown-state";
import { redis } from "../../src/lib/redis/redis";
import { buildTestApps, withContainerOverrides } from "../helpers/app";
import { startBlackHoleProxy } from "../helpers/black-hole-proxy";
import { closeDb } from "../helpers/db";
import { closeRedis, ensureRedisReady } from "../helpers/redis";
import type { BlackHoleProxy } from "../helpers/types";

/** The production statement timeout (`db`, `probeDb`): server 2 s, client `query_timeout` 3 s. */
const STATEMENT_TIMEOUT_MS = 2_000;
const QUERY_TIMEOUT_MS = STATEMENT_TIMEOUT_MS + 1_000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function timed<T>(work: Promise<T>): Promise<{ ms: number; value?: T; error?: Error }> {
    const startedAt = Date.now();
    try {
        const value = await work;
        return { ms: Date.now() - startedAt, value };
    } catch (error) {
        return { ms: Date.now() - startedAt, error: error as Error };
    }
}

/**
 * Review 2026-09-28 (re-opened Medium): pg 8.23 keeps a query whose `query_timeout` fired after it was sent as the
 * client's active query and never destroys the socket, so without `pool.validate: isConnectionIdle` the pool reissues
 * the dead connection and every later query fails at `query_timeout` until the kernel drops the socket (~15 min).
 * Established sockets are black-holed (no RST) while new ones reach the real test Postgres — a failover without RST.
 */
describe("knex pools after a connection is black-holed (integration: TCP proxy to real Postgres)", () => {
    let proxy: BlackHoleProxy;
    const pools: Knex[] = [];

    beforeAll(async () => {
        await ensureRedisReady();
    });

    beforeEach(async () => {
        proxy = await startBlackHoleProxy(process.env.DATABASE_URL ?? "");
    });

    afterEach(async () => {
        await Promise.all(pools.splice(0).map((pool) => pool.destroy()));
        await proxy.close();
    });

    afterAll(async () => {
        await closeRedis();
        await closeDb();
    });

    it("should run the next query on a fresh connection after a query timed out on a black-holed one (request pool)", async () => {
        const pool = createKnex({
            url: proxy.url,
            poolMax: 1,
            statementTimeoutMs: STATEMENT_TIMEOUT_MS,
            applicationName: "care-api",
        });
        pools.push(pool);

        await pool.raw("SELECT 1");
        expect(proxy.acceptedCount()).toBe(1);

        proxy.blackHoleEstablished();
        const during = await timed(pool.raw("SELECT 1"));
        expect(during.error?.message).toMatch(/Query read timeout/);
        expect(during.ms).toBeGreaterThanOrEqual(QUERY_TIMEOUT_MS - 100);

        // The dead connection is discarded on the next acquire; the query runs on a new socket, fast.
        const after = await timed(pool.raw<{ rows: Array<{ ok: number }> }>("SELECT 1 AS ok"));
        expect(after.error).toBeUndefined();
        expect(after.value?.rows[0]?.ok).toBe(1);
        expect(after.ms).toBeLessThan(1_000);
        expect(proxy.acceptedCount()).toBe(2);

        // And it stays healthy: the fresh connection is reused, not replaced per query.
        for (let i = 0; i < 3; i += 1) {
            const again = await timed(pool.raw("SELECT 1"));
            expect(again.error).toBeUndefined();
            expect(again.ms).toBeLessThan(1_000);
        }
        expect(proxy.acceptedCount()).toBe(2);
    }, 20_000);

    it("should report database up on the next readiness probe after the probe connection was black-holed", async () => {
        const probePool = createKnex({
            url: proxy.url,
            poolMax: 1,
            statementTimeoutMs: STATEMENT_TIMEOUT_MS,
            applicationName: "care-api-probe",
        });
        pools.push(probePool);
        const service = new HealthService(
            probePool,
            redis,
            new ShutdownState(),
            container.resolve<JwksStatusSource>(TOKENS.JwksCache),
        );

        await withContainerOverrides(
            [
                { token: TOKENS.ProbeDb, value: probePool },
                { token: TOKENS.HealthService, value: service },
                { token: TOKENS.HealthController, value: new HealthController(service) },
            ],
            async () => {
                const { publicApp, internalApp } = buildTestApps();
                const up = { status: "ok", checks: { database: "up", redis: "up", identityJwks: "down" } };

                expect((await request(publicApp).get("/api/health/ready")).body).toEqual(up);
                expect(proxy.acceptedCount()).toBe(1);

                proxy.blackHoleEstablished();
                const blackHoledAt = Date.now();
                const down = await request(publicApp).get("/api/health/ready");
                expect(down.status).toBe(503);
                expect(down.body).toEqual({ status: "down", checks: { database: "down", redis: "up", identityJwks: "down" } });

                // Let the probe query that is stuck on the dead socket reach its client-side query_timeout.
                await sleep(Math.max(0, QUERY_TIMEOUT_MS + 200 - (Date.now() - blackHoledAt)));

                // The very next probe on each listener is up again, on a fresh connection.
                for (const [app, path] of [
                    [publicApp, "/api/health/ready"],
                    [internalApp, "/internal/health/ready"],
                ] as const) {
                    const startedAt = Date.now();
                    const res = await request(app).get(path);
                    expect(res.status).toBe(200);
                    expect(res.body).toEqual(up);
                    expect(Date.now() - startedAt).toBeLessThan(1_000);
                }
                expect(proxy.acceptedCount()).toBe(2);
            },
        );
    }, 20_000);
});
