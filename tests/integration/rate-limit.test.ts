import request from "supertest";
import { TOKENS } from "../../src/lib/di/tokens";
import { redis } from "../../src/lib/redis/redis";
import { buildTestApps, withContainerOverrides } from "../helpers/app";
import { expectErrorEnvelope } from "../helpers/contract";
import { closeDb, truncateAll } from "../helpers/db";
import { closeRedis, createUnreachableRedis, ensureRedisReady, flushByPrefix } from "../helpers/redis";
import { buildRateLimitRouter } from "../helpers/test-routers";

jest.setTimeout(20_000);

let seq = 0;
const limiterName = (): string => `it_${Date.now()}_${(seq += 1)}`;

function appWith(name: string) {
    return buildTestApps({ publicRouters: [{ path: "/api", router: buildRateLimitRouter(name, 3, 1_000) }] }).publicApp;
}

const hit = (app: ReturnType<typeof appWith>) => request(app).get("/api/__test/limited");

describe("rate limiter (integration: real Redis, limit 3 / 1000 ms, subject byIp)", () => {
    beforeAll(async () => {
        await ensureRedisReady();
        await truncateAll();
        await flushByPrefix(["rl:"]);
    });

    afterAll(async () => {
        await flushByPrefix(["rl:"]);
        await closeRedis();
        await closeDb();
    });

    it("should admit 3 requests then return 429 with Retry-After when the limit is exceeded (F17)", async () => {
        const app = appWith(limiterName());
        const statuses: number[] = [];
        for (let index = 0; index < 3; index += 1) {
            statuses.push((await hit(app)).status);
        }
        const limited = await hit(app);

        expect(statuses).toEqual([200, 200, 200]);
        expect(limited.status).toBe(429);
        expectErrorEnvelope(limited.body, "RateLimited", limited.headers["x-request-id"]);
        expect(limited.body.error.message).toBe("Too many requests");
        const retryAfter = Number(limited.headers["retry-after"]);
        expect(Number.isInteger(retryAfter)).toBe(true);
        expect(retryAfter).toBeGreaterThanOrEqual(1);
        expect(retryAfter).toBeLessThanOrEqual(1);
    });

    it("should store hits under rl:<name>:<subject> and not record denied requests", async () => {
        const name = limiterName();
        const app = appWith(name);
        for (let index = 0; index < 5; index += 1) {
            await hit(app);
        }

        const keys: string[] = [];
        let cursor = "0";
        do {
            const [next, batch] = await redis.scan(cursor, "MATCH", `rl:${name}:*`, "COUNT", 100);
            cursor = next;
            keys.push(...batch);
        } while (cursor !== "0");

        expect(keys).toHaveLength(1);
        expect(["127.0.0.1", "::1"].map((ip) => `rl:${name}:${ip}`)).toContain(keys[0]);
        expect(await redis.zcard(keys[0] ?? "")).toBe(3);
        const ttl = await redis.pttl(keys[0] ?? "");
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(1_000);
    });

    it("should admit exactly the limit when 10 concurrent requests share one X-Request-Id and one fixed now", async () => {
        const name = limiterName();
        const app = buildTestApps({
            publicRouters: [{ path: "/api", router: buildRateLimitRouter(name, 3, 60_000, () => 42_000) }],
        }).publicApp;
        const requestId = "b2d8a93f-4e12-4c8e-9d35-7b89a0621dca";
        const responses = await Promise.all(
            Array.from({ length: 10 }, () => hit(app).set("X-Request-Id", requestId)),
        );

        expect(responses.filter((response) => response.status === 200)).toHaveLength(3);
        expect(responses.filter((response) => response.status === 429)).toHaveLength(7);
        expect(responses.every((response) => response.headers["x-request-id"] === requestId)).toBe(true);

        const keys: string[] = [];
        let cursor = "0";
        do {
            const [next, batch] = await redis.scan(cursor, "MATCH", `rl:${name}:*`, "COUNT", 100);
            cursor = next;
            keys.push(...batch);
        } while (cursor !== "0");
        expect(keys).toHaveLength(1);
        expect(await redis.zcard(keys[0] ?? "")).toBe(3);
    });

    it("should admit again when the window has slid (F17)", async () => {
        const app = appWith(limiterName());
        for (let index = 0; index < 3; index += 1) {
            await hit(app);
        }
        expect((await hit(app)).status).toBe(429);

        await new Promise((resolve) => setTimeout(resolve, 1_100));
        expect((await hit(app)).status).toBe(200);
    });

    it("should count limiters independently when two limiters share a subject", async () => {
        const a = appWith(limiterName());
        const b = appWith(limiterName());
        for (let index = 0; index < 3; index += 1) {
            await hit(a);
        }
        expect((await hit(a)).status).toBe(429);
        expect((await hit(b)).status).toBe(200);
    });

    it("should apply floor(3 / 2) = 1 per instance when Redis is unreachable (F18)", async () => {
        const unreachable = createUnreachableRedis();
        try {
            await withContainerOverrides([{ token: TOKENS.Redis, value: unreachable }], async () => {
                const app = appWith(limiterName());
                const first = await hit(app);
                const second = await hit(app);

                expect(first.status).toBe(200);
                expect(second.status).toBe(429);
                expectErrorEnvelope(second.body, "RateLimited");
                expect(Number(second.headers["retry-after"])).toBeGreaterThanOrEqual(1);
            });
        } finally {
            unreachable.disconnect();
        }
    });
});
