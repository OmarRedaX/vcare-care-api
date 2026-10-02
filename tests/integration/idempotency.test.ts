import { randomUUID } from "node:crypto";
import request from "supertest";
import { TOKENS } from "../../src/lib/di/tokens";
import { redis } from "../../src/lib/redis/redis";
import { buildTestApps, withContainerOverrides } from "../helpers/app";
import { expectErrorEnvelope, expectSuccessEnvelope } from "../helpers/contract";
import { closeDb, truncateAll } from "../helpers/db";
import { closeRedis, createUnreachableRedis, ensureRedisReady, flushByPrefix } from "../helpers/redis";
import { buildIdempotencyRouter, counters, resetCounters } from "../helpers/test-routers";

// Suites that boot the app can hit a cold-start transpile on the first request (identity saw one flake).
jest.setTimeout(20_000);

const ROUTE = "/api/__test/idem";

function publicApp() {
    return buildTestApps({ publicRouters: [{ path: "/api", router: buildIdempotencyRouter() }] }).publicApp;
}

/** The loopback address supertest connects from, as normalised by clientIp(). */
async function storedKeyFor(route: string, key: string): Promise<string> {
    for (const ip of ["127.0.0.1", "::1"]) {
        const candidate = `idem:POST ${route}:ip:${ip}:${key}`;
        if ((await redis.exists(candidate)) === 1) {
            return candidate;
        }
    }
    throw new Error(`no idempotency record stored for ${route} / ${key}`);
}

describe("idempotency middleware (integration: real Redis)", () => {
    beforeAll(async () => {
        await ensureRedisReady();
        await truncateAll();
    });

    beforeEach(async () => {
        resetCounters();
        await flushByPrefix(["idem:"]);
    });

    afterAll(async () => {
        await flushByPrefix(["idem:"]);
        await closeRedis();
        await closeDb();
    });

    it("should replay the original status and body and run the handler once when the same key and body repeat (F12)", async () => {
        const app = publicApp();
        const key = randomUUID();
        const first = await request(app).post(ROUTE).set("Idempotency-Key", key).send({ amount: 1, note: "a" });
        const second = await request(app).post(ROUTE).set("Idempotency-Key", key).send({ note: "a", amount: 1 });
        const third = await request(app).post(ROUTE).set("Idempotency-Key", key.toUpperCase()).send({ amount: 1, note: "a" });

        expect(first.status).toBe(201);
        expect(expectSuccessEnvelope(first.body)).toEqual({ run: 1, echo: { amount: 1, note: "a" } });
        for (const replay of [second, third]) {
            expect(replay.status).toBe(201);
            expect(replay.body).toEqual(first.body);
        }
        expect(counters.idem).toBe(1);
        // Every response still carries its OWN request id header.
        expect(second.headers["x-request-id"]).not.toBe(first.headers["x-request-id"]);
    });

    it("should return 422 IdempotencyConflict when the same key has a different body (F13)", async () => {
        const app = publicApp();
        const key = randomUUID();
        await request(app).post(ROUTE).set("Idempotency-Key", key).send({ amount: 1 });
        const res = await request(app).post(ROUTE).set("Idempotency-Key", key).send({ amount: 2 });

        expect(res.status).toBe(422);
        expectErrorEnvelope(res.body, "IdempotencyConflict", res.headers["x-request-id"]);
        expect(res.body.error.message).toBe("The idempotency key was already used with a different request");
        expect(counters.idem).toBe(1);
    });

    it("should treat different keys as independent requests", async () => {
        const app = publicApp();
        await request(app).post(ROUTE).set("Idempotency-Key", randomUUID()).send({ amount: 1 });
        await request(app).post(ROUTE).set("Idempotency-Key", randomUUID()).send({ amount: 1 });
        expect(counters.idem).toBe(2);
    });

    it("should return 400 ValidationFailed when the key is missing (F14)", async () => {
        const res = await request(publicApp()).post(ROUTE).send({ amount: 1 });
        expect(res.status).toBe(400);
        expectErrorEnvelope(res.body, "ValidationFailed");
        expect(res.body.error.details).toEqual([{ field: "Idempotency-Key", issue: "is required" }]);
        expect(counters.idem).toBe(0);
    });

    it("should return 400 ValidationFailed when the key is not a UUID", async () => {
        const res = await request(publicApp()).post(ROUTE).set("Idempotency-Key", "order-123").send({ amount: 1 });
        expect(res.status).toBe(400);
        expect(res.body.error.details).toEqual([{ field: "Idempotency-Key", issue: "must be a UUID" }]);
        expect(counters.idem).toBe(0);
    });

    it("should replay the stored 2xx and run the handler once when the first attempt was aborted by the client before the response (F12, review High)", async () => {
        const app = publicApp();
        const key = randomUUID();
        const body = { amount: 7 };

        // The client times out at 100 ms and disconnects; the handler commits at 400 ms (timeout-then-retry).
        await expect(
            request(app).post(`${ROUTE}?delayMs=400`).set("Idempotency-Key", key).send(body).timeout(100),
        ).rejects.toThrow();
        await new Promise((resolve) => setTimeout(resolve, 600));

        const record = JSON.parse((await redis.get(await storedKeyFor(ROUTE, key))) ?? "{}") as { state: string; status: number };
        expect(record).toMatchObject({ state: "done", status: 201 });

        const retry = await request(app).post(ROUTE).set("Idempotency-Key", key).send(body);
        expect(retry.status).toBe(201);
        expect(expectSuccessEnvelope(retry.body)).toEqual({ run: 1, echo: body });
        expect(retry.headers["retry-after"]).toBeUndefined();
        expect(counters.idem).toBe(1);
    });

    it("should run the handler once and answer the loser with 409 Conflict and Retry-After 1 when two requests with the same key race against a slow handler (F15)", async () => {
        const app = publicApp();
        const key = randomUUID();
        const body = { amount: 5 };

        const slow = request(app).post(`${ROUTE}?delayMs=600`).set("Idempotency-Key", key).send(body).then((res) => res);
        await new Promise((resolve) => setTimeout(resolve, 150));

        // While the first is still running, the in-flight marker is visible with the 60 s TTL.
        const lockKey = await storedKeyFor(ROUTE, key);
        const lock = JSON.parse((await redis.get(lockKey)) ?? "{}") as { state: string };
        expect(lock.state).toBe("in_progress");
        const lockTtl = await redis.pttl(lockKey);
        expect(lockTtl).toBeGreaterThan(55_000);
        expect(lockTtl).toBeLessThanOrEqual(60_000);

        const startedAt = Date.now();
        const loser = await request(app).post(ROUTE).set("Idempotency-Key", key).send(body);
        expect(Date.now() - startedAt).toBeLessThan(400); // immediate — no waiting for the winner
        const winner = await slow;

        expect(winner.status).toBe(201);
        expect(loser.status).toBe(409);
        expect(loser.headers["retry-after"]).toBe("1");
        expectErrorEnvelope(loser.body, "Conflict", loser.headers["x-request-id"]);
        expect(loser.body.error.message).toBe("A request with this idempotency key is still being processed");
        expect(counters.idem).toBe(1);

        // Once the winner is done, a retry replays its response.
        await new Promise((resolve) => setTimeout(resolve, 50));
        const retry = await request(app).post(ROUTE).set("Idempotency-Key", key).send(body);
        expect(retry.status).toBe(201);
        expect(retry.body).toEqual(winner.body);
        expect(counters.idem).toBe(1);
    });

    it("should run the handler exactly once when many duplicates are fired concurrently (F15)", async () => {
        const app = publicApp();
        const key = randomUUID();
        const responses = await Promise.all(
            Array.from({ length: 6 }, () => request(app).post(`${ROUTE}?delayMs=300`).set("Idempotency-Key", key).send({ amount: 9 })),
        );
        const statuses = responses.map((res) => res.status).sort();
        expect(statuses.filter((status) => status === 201)).toHaveLength(1);
        expect(statuses.filter((status) => status === 409)).toHaveLength(5);
        expect(counters.idem).toBe(1);
    });

    it("should replay with the current request id in error.requestId when the stored response was an error", async () => {
        const app = publicApp();
        const key = randomUUID();
        const firstId = randomUUID();
        const replayId = randomUUID();

        const first = await request(app)
            .post("/api/__test/idem-invalid")
            .set("Idempotency-Key", key)
            .set("X-Request-Id", firstId)
            .send({ name: 1 });
        await new Promise((resolve) => setTimeout(resolve, 50));
        const replay = await request(app)
            .post("/api/__test/idem-invalid")
            .set("Idempotency-Key", key)
            .set("X-Request-Id", replayId)
            .send({ name: 1 });

        expect(first.status).toBe(400);
        expectErrorEnvelope(first.body, "ValidationFailed", firstId);
        expect(replay.status).toBe(400);
        expect(replay.headers["x-request-id"]).toBe(replayId);
        expectErrorEnvelope(replay.body, "ValidationFailed", replayId);
        expect(replay.body.error.details).toEqual(first.body.error.details);
        expect(counters.invalid).toBe(1);
    });

    it("should run the handler again when the first attempt returned 5xx", async () => {
        const app = publicApp();
        const key = randomUUID();

        const failed = await request(app).post("/api/__test/idem-flaky").set("Idempotency-Key", key).send({ a: 1 });
        expect(failed.status).toBe(500);
        expectErrorEnvelope(failed.body, "InternalError");
        await new Promise((resolve) => setTimeout(resolve, 50));

        const retried = await request(app).post("/api/__test/idem-flaky").set("Idempotency-Key", key).send({ a: 1 });
        expect(retried.status).toBe(201);
        await new Promise((resolve) => setTimeout(resolve, 50));
        const replayed = await request(app).post("/api/__test/idem-flaky").set("Idempotency-Key", key).send({ a: 1 });

        expect(replayed.status).toBe(201);
        expect(replayed.body).toEqual(retried.body);
        expect(counters.flaky).toBe(2);
    });

    it("should replay an empty 204 when the original response had no content", async () => {
        const app = publicApp();
        const key = randomUUID();
        const first = await request(app).post("/api/__test/idem-empty").set("Idempotency-Key", key).send({});
        await new Promise((resolve) => setTimeout(resolve, 50));
        const replay = await request(app).post("/api/__test/idem-empty").set("Idempotency-Key", key).send({});
        expect(first.status).toBe(204);
        expect(replay.status).toBe(204);
        expect(replay.text).toBe("");
        expect(counters.noContent).toBe(1);
    });

    it("should store the record under idem:POST /api/__test/idem:ip:<ip>:<key> with a TTL of at most 24 h", async () => {
        const app = publicApp();
        const key = randomUUID();
        await request(app).post(`${ROUTE}?ignored=query`).set("Idempotency-Key", key.toUpperCase()).send({ amount: 3 });
        await new Promise((resolve) => setTimeout(resolve, 50));

        const stored = await storedKeyFor(ROUTE, key);
        expect(stored).not.toContain("?");
        expect(stored.endsWith(key)).toBe(true); // lower-cased key
        const ttl = await redis.pttl(stored);
        expect(ttl).toBeGreaterThan(86_400_000 - 60_000);
        expect(ttl).toBeLessThanOrEqual(86_400_000);

        const record = JSON.parse((await redis.get(stored)) ?? "{}") as Record<string, unknown>;
        expect(record).toMatchObject({ state: "done", status: 201 });
        expect(record.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("should run the handler on every request and never 5xx when Redis is unreachable (F16)", async () => {
        const unreachable = createUnreachableRedis();
        try {
            await withContainerOverrides([{ token: TOKENS.Redis, value: unreachable }], async () => {
                const app = publicApp();
                const key = randomUUID();
                const responses = [];
                for (let index = 0; index < 3; index += 1) {
                    responses.push(await request(app).post(ROUTE).set("Idempotency-Key", key).send({ amount: 1 }));
                }
                expect(responses.map((res) => res.status)).toEqual([201, 201, 201]);
                expect(counters.idem).toBe(3);

                // A required key is still enforced while Redis is down (F14).
                const missing = await request(app).post(ROUTE).send({ amount: 1 });
                expect(missing.status).toBe(400);
            });
        } finally {
            unreachable.disconnect();
        }
    });
});
