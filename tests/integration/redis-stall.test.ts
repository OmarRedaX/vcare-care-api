import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import request from "supertest";
import { TOKENS } from "../../src/lib/di/tokens";
import { logger } from "../../src/lib/logger/logger";
import { REDIS_BREAKER_FAILURE_THRESHOLD, REDIS_BREAKER_OPEN_MS } from "../../src/lib/redis/breaker";
import { createRedis, REDIS_SOCKET_TIMEOUT_MS } from "../../src/lib/redis/redis";
import { buildTestApps, withContainerOverrides } from "../helpers/app";
import { startBlackHoleProxy } from "../helpers/black-hole-proxy";
import { closeDb, truncateAll } from "../helpers/db";
import { captureLogs } from "../helpers/log-capture";
import { closeRedis, ensureRedisReady, flushByPrefix } from "../helpers/redis";
import { buildIdempotencyRouter, buildRateLimitRouter, counters, resetCounters } from "../helpers/test-routers";
import type { BlackHoleProxy, LogCapture } from "../helpers/types";

jest.setTimeout(40_000);

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Foundation issue #10: a Redis that stalls while its client still reports `ready` used to cost the full 500 ms
 * command timeout on EVERY idempotency / rate-limited request. Real Redis behind the TCP black-hole proxy: the
 * established connection goes silent (no RST, no FIN), so ioredis keeps `status === "ready"`.
 */
describe("regression #10: stalled-but-ready Redis (integration: real Redis behind a black-hole proxy)", () => {
    let proxy: BlackHoleProxy;
    let stalled: Redis;
    let capture: LogCapture;

    beforeAll(async () => {
        await ensureRedisReady();
        await truncateAll();
        await flushByPrefix(["idem:", "rl:"]);
        proxy = await startBlackHoleProxy(process.env.REDIS_URL ?? "");
        stalled = createRedis(proxy.url, { name: "care-stall-test" });
        await ensureRedisReady(stalled);
    });

    afterAll(async () => {
        stalled.disconnect();
        await proxy.close();
        await flushByPrefix(["idem:", "rl:"]);
        await closeRedis();
        await closeDb();
    });

    it("should stop paying the command timeout after the breaker opens, then use Redis again once it recovers", async () => {
        resetCounters();
        jest.replaceProperty(logger as unknown as { level: string }, "level", "debug");
        capture = captureLogs();
        try {
            await withContainerOverrides([{ token: TOKENS.Redis, value: stalled }], async () => {
                const app = buildTestApps({
                    publicRouters: [
                        { path: "/api", router: buildIdempotencyRouter() },
                        { path: "/api", router: buildRateLimitRouter(`stall_${Date.now()}`, 100, 60_000) },
                    ],
                }).publicApp;
                const idem = (key = randomUUID()) => request(app).post("/api/__test/idem").set("Idempotency-Key", key).send({ n: 1 });
                const timed = async (send: () => Promise<request.Response>) => {
                    const startedAt = Date.now();
                    const res = await send();
                    return { status: res.status, ms: Date.now() - startedAt, body: res.body as unknown };
                };

                // Healthy through the proxy.
                expect((await idem()).status).toBe(201);

                const acceptedBefore = proxy.acceptedCount();
                proxy.blackHoleEstablished();
                const stalledAt = Date.now();
                expect(stalled.status).toBe("ready");

                // Until the breaker opens, each request waits for a command timeout (~500 ms) — at most `threshold` of them.
                const slow: number[] = [];
                let fast: { status: number; ms: number } | undefined;
                for (let attempt = 0; attempt < REDIS_BREAKER_FAILURE_THRESHOLD + 2 && fast === undefined; attempt += 1) {
                    const result = await timed(() => idem());
                    expect(result.status).toBe(201); // Tier 2: the request itself never fails
                    if (result.ms >= 400) {
                        slow.push(result.ms);
                    } else {
                        fast = result;
                    }
                }
                expect(slow.length).toBeGreaterThanOrEqual(1);
                expect(slow.length).toBeLessThanOrEqual(REDIS_BREAKER_FAILURE_THRESHOLD);
                expect(fast?.ms).toBeLessThan(100);
                if (Date.now() - stalledAt < REDIS_SOCKET_TIMEOUT_MS) {
                    // Still "ready" before the socket timeout: only the breaker keeps it out of the path.
                    expect(stalled.status).toBe("ready");
                }

                // Open breaker: neither middleware touches Redis.
                const idemOpen = await timed(() => idem());
                const limitedOpen = await timed(() => request(app).get("/api/__test/limited"));
                expect(idemOpen).toMatchObject({ status: 201 });
                expect(idemOpen.ms).toBeLessThan(100);
                expect(limitedOpen).toMatchObject({ status: 200 });
                expect(limitedOpen.ms).toBeLessThan(100);

                const lines = capture.lines();
                expect(lines.some((line) => line.message === "redis_breaker_open")).toBe(true);
                expect(
                    lines.some((line) => line.message === "idempotency_skipped" && line.reason === "redis_breaker_open"),
                ).toBe(true);
                expect(lines.some((line) => line.message === "rate_limiter_degraded")).toBe(true);

                // Recovery WITHOUT any help from the test (M2): the socket timeout destroys the silent connection,
                // retryStrategy dials a fresh one through the proxy (which forwards new connections), and after the
                // open window the breaker admits one probe that closes it.
                const deadline = stalledAt + REDIS_SOCKET_TIMEOUT_MS + REDIS_BREAKER_OPEN_MS + 3_000;
                const closed = (): boolean => capture.lines().some((line) => line.message === "redis_breaker_closed");
                while (!closed() && Date.now() < deadline) {
                    expect((await idem()).status).toBe(201);
                    await delay(250);
                }
                expect(closed()).toBe(true);
                expect(Date.now()).toBeLessThanOrEqual(deadline);
                expect(proxy.acceptedCount()).toBeGreaterThan(acceptedBefore); // it reconnected on its own
                expect(stalled.status).toBe("ready");
                expect(capture.lines().some((line) => line.message === "redis_recovered")).toBe(true);

                const key = randomUUID();
                const before = counters.idem;
                const stored = await idem(key);
                await delay(50);
                const replay = await idem(key);
                expect(stored.status).toBe(201);
                expect(replay.status).toBe(201);
                expect(replay.body).toEqual(stored.body); // replayed from Redis: Redis is used again
                expect(counters.idem).toBe(before + 1);
            });
        } finally {
            capture.restore();
            jest.restoreAllMocks();
        }
    });
});
