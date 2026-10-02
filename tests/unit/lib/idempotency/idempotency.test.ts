import express from "express";
import type { Request, Response } from "express";
import type Redis from "ioredis";
import request from "supertest";
import { errorHandler } from "../../../../src/lib/error/errorHandler";
import { RateLimited } from "../../../../src/lib/error/errors";
import { buildIdempotencyKey, hashBody, idempotency, resolvePrincipal } from "../../../../src/lib/idempotency/idempotency";
import { logger } from "../../../../src/lib/logger/logger";
import { requestId } from "../../../../src/lib/request-id/request-id";

const KEY = "3c1b2a4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

/** In-memory stand-in for the Redis commands the middleware uses (EVAL = the compare-and-delete release). */
function fakeRedis(status = "ready") {
    const store = new Map<string, string>();
    const calls: unknown[][] = [];
    const client = {
        status,
        store,
        calls,
        set: jest.fn((key: string, value: string, ...args: Array<string | number>): Promise<string | null> => {
            calls.push(["set", key, ...args]);
            if (args.includes("NX") && store.has(key)) {
                return Promise.resolve(null);
            }
            store.set(key, value);
            return Promise.resolve("OK");
        }),
        get: jest.fn((key: string): Promise<string | null> => Promise.resolve(store.get(key) ?? null)),
        del: jest.fn((key: string) => {
            calls.push(["del", key]);
            store.delete(key);
            return Promise.resolve(1);
        }),
        eval: jest.fn((script: string, _numKeys: number, key: string, expected: string): Promise<number> => {
            calls.push(["eval", key]);
            expect(script).toContain('redis.call("GET", KEYS[1]) == ARGV[1]');
            if (store.get(key) === expected) {
                store.delete(key);
                return Promise.resolve(1);
            }
            return Promise.resolve(0);
        }),
    };
    return client;
}

type FakeRedis = ReturnType<typeof fakeRedis>;

function harness(redis: FakeRedis, options: { required?: boolean; respond?: (req: Request, res: Response) => void } = {}) {
    const runs = { count: 0 };
    const app = express();
    app.use(requestId());
    app.use(express.json());
    app.all(
        "/api/things",
        idempotency({ required: options.required ?? true, redis: redis as unknown as Redis }),
        (req: Request, res: Response) => {
            runs.count += 1;
            if (options.respond !== undefined) {
                options.respond(req, res);
                return;
            }
            res.status(201).json({ success: true, data: { run: runs.count } });
        },
    );
    app.use(errorHandler);
    return { app, runs };
}

/** The store write happens on `finish`, after supertest already has the response. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

describe("lib/idempotency/idempotency middleware", () => {
    let warn: jest.SpyInstance;
    let metric: jest.SpyInstance;

    beforeEach(() => {
        warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
        metric = jest.spyOn(logger, "metric").mockImplementation(() => undefined);
        jest.spyOn(logger, "error").mockImplementation(() => undefined);
    });
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("should call next without Redis when the method is GET", async () => {
        const redis = fakeRedis();
        const { app, runs } = harness(redis);
        const res = await request(app).get("/api/things");
        expect(res.status).toBe(201);
        expect(runs.count).toBe(1);
        expect(redis.set).not.toHaveBeenCalled();
        expect(redis.get).not.toHaveBeenCalled();
    });

    it("should return 400 when required and the header is missing even if Redis is down (F14)", async () => {
        const redis = fakeRedis("reconnecting");
        const { app, runs } = harness(redis);
        const res = await request(app).post("/api/things").send({ a: 1 });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("ValidationFailed");
        expect(res.body.error.details).toEqual([{ field: "Idempotency-Key", issue: "is required" }]);
        expect(runs.count).toBe(0);
    });

    it("should call next when the header is missing and the key is optional", async () => {
        const redis = fakeRedis();
        const { app, runs } = harness(redis, { required: false });
        const res = await request(app).post("/api/things").send({ a: 1 });
        expect(res.status).toBe(201);
        expect(runs.count).toBe(1);
        expect(redis.set).not.toHaveBeenCalled();
    });

    it.each(["not-a-uuid", "3c1b2a4d5e6f4a7b8c9d0e1f2a3b4c5d"])(
        "should return 400 when the key is not a UUID (%p)",
        async (key) => {
            const { app, runs } = harness(fakeRedis());
            const res = await request(app).post("/api/things").set("Idempotency-Key", key).send({ a: 1 });
            expect(res.status).toBe(400);
            expect(res.body.error.details).toEqual([{ field: "Idempotency-Key", issue: "must be a UUID" }]);
            expect(runs.count).toBe(0);
        },
    );

    it("should skip and call next when Redis is not ready (F16)", async () => {
        const redis = fakeRedis("reconnecting");
        const { app, runs } = harness(redis);
        const res = await request(app).post("/api/things").set("Idempotency-Key", KEY).send({ a: 1 });

        expect(res.status).toBe(201);
        expect(runs.count).toBe(1);
        expect(redis.set).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith("idempotency_skipped", expect.objectContaining({ reason: "redis_not_ready" }));
        expect(metric).toHaveBeenCalledWith("idempotency_skipped", 1, { reason: "redis_not_ready" });
        expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
    });

    it("should skip and call next when SET NX throws (F16)", async () => {
        const redis = fakeRedis();
        redis.set.mockImplementationOnce(() => Promise.reject(new Error("Command timed out")));
        const { app, runs } = harness(redis);
        const res = await request(app).post("/api/things").set("Idempotency-Key", KEY).send({ a: 1 });

        expect(res.status).toBe(201);
        expect(runs.count).toBe(1);
        expect(metric).toHaveBeenCalledWith("idempotency_skipped", 1, { reason: "redis_error" });
    });

    it("should skip and call next when the follow-up GET throws", async () => {
        const redis = fakeRedis();
        redis.store.set("placeholder", "x");
        redis.set.mockImplementationOnce(() => Promise.resolve(null));
        redis.get.mockImplementationOnce(() => Promise.reject(new Error("Command timed out")));
        const { app, runs } = harness(redis);
        const res = await request(app).post("/api/things").set("Idempotency-Key", KEY).send({ a: 1 });
        expect(res.status).toBe(201);
        expect(runs.count).toBe(1);
    });

    it("should set the in-flight marker with a 60 s TTL", async () => {
        const redis = fakeRedis();
        const { app } = harness(redis);
        await request(app).post("/api/things").set("Idempotency-Key", KEY).send({ a: 1 });
        await settle();

        const [first, second] = redis.calls;
        expect(first).toEqual(["set", expect.any(String), "PX", 60_000, "NX"]);
        expect(second).toEqual(["set", expect.any(String), "PX", 86_400_000]);
        const stored = JSON.parse(redis.store.values().next().value ?? "{}") as Record<string, unknown>;
        expect(JSON.parse(String(redis.set.mock.calls[0]?.[1]))).toEqual({
            state: "in_progress",
            bodyHash: hashBody({ a: 1 }),
            owner: expect.stringMatching(/^[0-9a-f-]{36}$/),
        });
        expect(stored).toEqual({
            state: "done",
            bodyHash: hashBody({ a: 1 }),
            status: 201,
            body: { success: true, data: { run: 1 } },
        });
    });

    it("should replay the stored status and body without running the handler when the same key and body repeat (F12)", async () => {
        const redis = fakeRedis();
        const { app, runs } = harness(redis);
        const first = await request(app).post("/api/things").set("Idempotency-Key", KEY).send({ a: 1, b: 2 });
        await settle();
        const second = await request(app).post("/api/things").set("Idempotency-Key", KEY).send({ b: 2, a: 1 });

        expect(second.status).toBe(201);
        expect(second.body).toEqual(first.body);
        expect(runs.count).toBe(1);
    });

    it("should replay an empty 204 when the stored response had no body", async () => {
        const redis = fakeRedis();
        const { app, runs } = harness(redis, { respond: (_req, res) => void res.status(204).end() });
        await request(app).post("/api/things").set("Idempotency-Key", KEY).send({ a: 1 });
        await settle();
        const replay = await request(app).post("/api/things").set("Idempotency-Key", KEY).send({ a: 1 });
        expect(replay.status).toBe(204);
        expect(replay.text).toBe("");
        expect(runs.count).toBe(1);
    });

    it("should return 422 IdempotencyConflict when a done record has a different body (F13)", async () => {
        const redis = fakeRedis();
        const { app, runs } = harness(redis);
        await request(app).post("/api/things").set("Idempotency-Key", KEY).send({ a: 1 });
        await settle();
        const res = await request(app).post("/api/things").set("Idempotency-Key", KEY).send({ a: 2 });
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe("IdempotencyConflict");
        expect(runs.count).toBe(1);
    });

    it("should return 422 IdempotencyConflict when an in-progress record has a different body (F13)", async () => {
        const redis = fakeRedis();
        const { app, runs } = harness(redis);
        redis.set.mockImplementationOnce(() => Promise.resolve(null));
        redis.get.mockImplementationOnce(() =>
            Promise.resolve(JSON.stringify({ state: "in_progress", bodyHash: hashBody({ other: true }), owner: "synthetic-owner" })),
        );
        const res = await request(app).post("/api/things").set("Idempotency-Key", KEY).send({ a: 1 });
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe("IdempotencyConflict");
        expect(runs.count).toBe(0);
    });

    it("should respond 409 Conflict with Retry-After 1 immediately when a duplicate arrives while the first is in flight (F15)", async () => {
        const redis = fakeRedis();
        const { app, runs } = harness(redis);
        redis.set.mockImplementationOnce(() => Promise.resolve(null));
        redis.get.mockImplementationOnce(() =>
            Promise.resolve(JSON.stringify({ state: "in_progress", bodyHash: hashBody({ a: 1 }), owner: "synthetic-owner" })),
        );

        const startedAt = Date.now();
        const res = await request(app).post("/api/things").set("Idempotency-Key", KEY).send({ a: 1 });

        expect(Date.now() - startedAt).toBeLessThan(1_000);
        expect(res.status).toBe(409);
        expect(res.headers["retry-after"]).toBe("1");
        expect(res.body.error.code).toBe("Conflict");
        expect(res.body.error.message).toBe("A request with this idempotency key is still being processed");
        expect(runs.count).toBe(0);
    });

    it("should respond 409 Conflict when SET NX loses and no record is found", async () => {
        const redis = fakeRedis();
        const { app, runs } = harness(redis);
        redis.set.mockImplementationOnce(() => Promise.resolve(null));
        const res = await request(app).post("/api/things").set("Idempotency-Key", KEY).send({ a: 1 });
        expect(res.status).toBe(409);
        expect(res.headers["retry-after"]).toBe("1");
        expect(runs.count).toBe(0);
    });

    it("should delete the lock when the handler responds 5xx", async () => {
        const redis = fakeRedis();
        const { app } = harness(redis, {
            respond: () => {
                throw new Error("synthetic handler failure");
            },
        });
        const res = await request(app).post("/api/things").set("Idempotency-Key", KEY).send({ a: 1 });
        await settle();
        expect(res.status).toBe(500);
        expect(redis.eval).toHaveBeenCalledTimes(1);
        expect(redis.del).not.toHaveBeenCalled();
        expect(redis.store.size).toBe(0);
    });

    it("should delete the lock when the handler responds 429", async () => {
        const redis = fakeRedis();
        const { app } = harness(redis, {
            respond: () => {
                throw RateLimited;
            },
        });
        await request(app).post("/api/things").set("Idempotency-Key", KEY).send({ a: 1 });
        await settle();
        expect(redis.eval).toHaveBeenCalledTimes(1);
        expect(redis.store.size).toBe(0);
    });

    it("should keep the lock to expire when storing the result fails", async () => {
        const redis = fakeRedis();
        const { app } = harness(redis);
        redis.set
            .mockImplementationOnce((key: string, value: string) => {
                redis.store.set(key, value);
                return Promise.resolve("OK");
            })
            .mockImplementationOnce(() => Promise.reject(new Error("Connection is closed.")));

        const res = await request(app).post("/api/things").set("Idempotency-Key", KEY).send({ a: 1 });
        await settle();

        expect(res.status).toBe(201);
        expect(warn).toHaveBeenCalledWith("idempotency_store_failed", expect.any(Object));
        expect(redis.del).not.toHaveBeenCalled();
        expect(redis.eval).not.toHaveBeenCalled();
        const lock = JSON.parse(redis.store.values().next().value ?? "{}") as Record<string, unknown>;
        expect(lock.state).toBe("in_progress");
    });

    it("should store the result and replay it when the client disconnects before the response (High: settle on end)", async () => {
        const redis = fakeRedis();
        const { app, runs } = harness(redis, {
            respond: (_req, res) => {
                // The handler commits AFTER the client gave up (timeout-then-retry).
                setTimeout(() => void res.status(201).json({ success: true, data: { run: 1 } }), 150);
            },
        });

        await expect(
            request(app).post("/api/things").set("Idempotency-Key", KEY).send({ a: 1 }).timeout(30),
        ).rejects.toThrow();
        await new Promise((resolve) => setTimeout(resolve, 250));

        const stored = JSON.parse(redis.store.values().next().value ?? "{}") as Record<string, unknown>;
        expect(stored).toMatchObject({ state: "done", status: 201 });

        const retry = await request(app).post("/api/things").set("Idempotency-Key", KEY).send({ a: 1 });
        expect(retry.status).toBe(201);
        expect(retry.body).toEqual({ success: true, data: { run: 1 } });
        expect(runs.count).toBe(1);
    });

    it("should settle exactly once when both the wrapped end and finish fire", async () => {
        const redis = fakeRedis();
        const { app } = harness(redis);
        await request(app).post("/api/things").set("Idempotency-Key", KEY).send({ a: 1 });
        await settle();
        const writes = redis.calls.filter((call) => call[0] === "set");
        expect(writes).toHaveLength(2); // the NX lock, then exactly one done record
    });

    it("should compare-and-delete its own lock when SET NX throws after its effect landed (High: orphan lock)", async () => {
        const redis = fakeRedis();
        // The SET reaches Redis but the client-side commandTimeout rejects it first.
        redis.set.mockImplementationOnce((key: string, value: string) => {
            redis.store.set(key, value);
            return Promise.reject(new Error("Command timed out"));
        });
        const { app, runs } = harness(redis);

        const first = await request(app).post("/api/things").set("Idempotency-Key", KEY).send({ a: 1 });
        await settle();
        expect(first.status).toBe(201);
        expect(metric).toHaveBeenCalledWith("idempotency_skipped", 1, { reason: "redis_error" });
        expect(redis.eval).toHaveBeenCalledTimes(1);
        expect(redis.store.size).toBe(0);

        // The retry is not blocked by a 60 s orphan in-flight marker.
        const retry = await request(app).post("/api/things").set("Idempotency-Key", KEY).send({ a: 1 });
        expect(retry.status).toBe(201);
        expect(retry.headers["retry-after"]).toBeUndefined();
        expect(runs.count).toBe(2);
    });

    it("should never delete another attempt's lock when its own SET NX throws without landing", async () => {
        const redis = fakeRedis();
        const foreign = JSON.stringify({ state: "in_progress", bodyHash: hashBody({ a: 1 }), owner: "someone-else" });
        redis.set.mockImplementationOnce((key: string) => {
            redis.store.set(key, foreign); // another attempt holds the key; ours never landed
            return Promise.reject(new Error("Command timed out"));
        });
        const { app } = harness(redis);

        await request(app).post("/api/things").set("Idempotency-Key", KEY).send({ a: 1 });
        await settle();

        expect(redis.eval).toHaveBeenCalledTimes(1);
        expect(redis.store.values().next().value).toBe(foreign);
    });

    it("should replace error.requestId with the current request id when replaying a stored error", async () => {
        const redis = fakeRedis();
        const { app, runs } = harness(redis, {
            respond: (_req, res) => {
                res.status(400).json({
                    success: false,
                    error: { code: "ValidationFailed", message: "m", details: [], requestId: "11111111-1111-4111-8111-111111111111" },
                });
            },
        });
        await request(app).post("/api/things").set("Idempotency-Key", KEY).send({ a: 1 });
        await settle();
        const replayId = "22222222-2222-4222-8222-222222222222";
        const replay = await request(app)
            .post("/api/things")
            .set("Idempotency-Key", KEY)
            .set("X-Request-Id", replayId)
            .send({ a: 1 });

        expect(replay.status).toBe(400);
        expect(replay.headers["x-request-id"]).toBe(replayId);
        expect(replay.body.error.requestId).toBe(replayId);
        expect(runs.count).toBe(1);
    });
});

describe("lib/idempotency key helpers", () => {
    const baseReq = (extra: Partial<Request> = {}): Request =>
        ({
            method: "POST",
            baseUrl: "/api",
            path: "/consultations/42/cancel",
            headers: {},
            socket: { remoteAddress: "::ffff:203.0.113.9" },
            ...extra,
        }) as unknown as Request;

    it("should build the principal as user:<id>, client:<clientId>, or ip:<ip> when auth, a service token, or neither is present", () => {
        expect(resolvePrincipal(baseReq({ auth: { userId: 7, role: "patient", status: "active", emailVerified: true } }))).toBe(
            "user:7",
        );
        expect(resolvePrincipal(baseReq({ service: { clientId: "admin-tooling", scopes: [] } }))).toBe("client:admin-tooling");
        expect(resolvePrincipal(baseReq())).toBe("ip:203.0.113.9");
    });

    it("should prefer the user token over a service context when both are present", () => {
        expect(
            resolvePrincipal(
                baseReq({
                    auth: { userId: 9, role: "admin", status: "active", emailVerified: true },
                    service: { clientId: "x", scopes: [] },
                }),
            ),
        ).toBe("user:9");
    });

    it("should build the key as idem:<METHOD path>:<principal>:<key> without the query string", () => {
        const req = baseReq({ originalUrl: "/api/consultations/42/cancel?reason=x" } as Partial<Request>);
        expect(buildIdempotencyKey(req, KEY.toUpperCase())).toBe(`idem:POST /api/consultations/42/cancel:ip:203.0.113.9:${KEY}`);
    });

    it("should hash semantically identical bodies identically regardless of key order", () => {
        expect(hashBody({ a: 1, b: [1, 2] })).toBe(hashBody({ b: [1, 2], a: 1 }));
        expect(hashBody({ a: 1 })).not.toBe(hashBody({ a: 2 }));
        expect(hashBody(undefined)).toBe(hashBody(null));
        expect(hashBody({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
    });
});
