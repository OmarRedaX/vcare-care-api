import express from "express";
import type { Request } from "express";
import type Redis from "ioredis";
import request from "supertest";
import { errorHandler } from "../../../../src/lib/error/errorHandler";
import { logger } from "../../../../src/lib/logger/logger";
import { MemoryLimiter } from "../../../../src/lib/rate-limit/memory-limiter";
import { fallbackLimit, rateLimit } from "../../../../src/lib/rate-limit/rate-limit";
import { byIp, byUser } from "../../../../src/lib/rate-limit/subjects";
import type { RateLimitOptions } from "../../../../src/lib/rate-limit/types";
import { requestId } from "../../../../src/lib/request-id/request-id";

const SUBJECT = "198.51.100.77";
let limiterSeq = 0;

/** Unique limiter names: the degraded-log throttle is module-level per limiter name. */
const uniqueName = (): string => `unit_${process.pid}_${(limiterSeq += 1)}`;

function harness(options: Partial<RateLimitOptions> & { redis?: Redis }) {
    const runs = { count: 0 };
    const app = express();
    app.use(requestId());
    app.get(
        "/api/limited",
        rateLimit({
            name: options.name ?? uniqueName(),
            limit: options.limit ?? 4,
            windowMs: options.windowMs ?? 60_000,
            subject: options.subject ?? (() => SUBJECT),
            onRedisDown: options.onRedisDown,
            redis: options.redis,
            now: options.now,
        }),
        (_req, res) => {
            runs.count += 1;
            res.status(200).json({ ok: true });
        },
    );
    app.use(errorHandler);
    return { app, runs };
}

const downRedis = (): Redis => ({ status: "reconnecting" }) as unknown as Redis;

describe("lib/rate-limit/rateLimit", () => {
    let warn: jest.SpyInstance;
    let metric: jest.SpyInstance;

    beforeEach(() => {
        warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
        metric = jest.spyOn(logger, "metric").mockImplementation(() => undefined);
    });
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it.each([
        [60, 2, 30],
        [3, 2, 1],
        [1, 2, 1],
        [10, 3, 3],
        [7, 1, 7],
    ])("should compute max(1, floor(%p / %p)) = %p for fallbackLimit (F18)", (limit, divisor, expected) => {
        expect(fallbackLimit(limit, divisor)).toBe(expected);
    });

    it("should admit the fallback limit then return 429 when Redis is not ready (F18)", async () => {
        // limit 4, RATE_LIMIT_FALLBACK_DIVISOR 2 (.env.test default) → 2 per instance.
        const now = 1_000_000;
        const { app, runs } = harness({ limit: 4, windowMs: 10_000, redis: downRedis(), now: () => now });

        const statuses: number[] = [];
        for (let index = 0; index < 3; index += 1) {
            statuses.push((await request(app).get("/api/limited")).status);
        }

        expect(statuses).toEqual([200, 200, 429]);
        expect(runs.count).toBe(2);
    });

    it("should admit again in fallback mode when the window slides", async () => {
        let now = 1_000_000;
        const { app } = harness({ limit: 2, windowMs: 1_000, redis: downRedis(), now: () => now });
        expect((await request(app).get("/api/limited")).status).toBe(200);
        expect((await request(app).get("/api/limited")).status).toBe(429);
        now += 1_001;
        expect((await request(app).get("/api/limited")).status).toBe(200);
    });

    it("should use the fallback when the Redis command throws", async () => {
        const redis = {
            status: "ready",
            defineCommand: jest.fn(),
            slidingWindowHit: jest.fn().mockRejectedValue(new Error("Command timed out")),
        } as unknown as Redis;
        const { app, runs } = harness({ limit: 2, redis });
        expect((await request(app).get("/api/limited")).status).toBe(200);
        expect((await request(app).get("/api/limited")).status).toBe(429);
        expect(runs.count).toBe(1);
        expect(warn).toHaveBeenCalledWith("rate_limiter_degraded", expect.any(Object));
    });

    it("should call next when onRedisDown is fail-open and Redis throws", async () => {
        const redis = {
            status: "ready",
            defineCommand: jest.fn(),
            slidingWindowHit: jest.fn().mockRejectedValue(new Error("Command timed out")),
        } as unknown as Redis;
        const { app, runs } = harness({ limit: 1, redis, onRedisDown: "fail-open" });
        for (let index = 0; index < 5; index += 1) {
            expect((await request(app).get("/api/limited")).status).toBe(200);
        }
        expect(runs.count).toBe(5);
    });

    it("should call next when onRedisDown is fail-open and Redis is not ready", async () => {
        const { app, runs } = harness({ limit: 1, redis: downRedis(), onRedisDown: "fail-open" });
        await request(app).get("/api/limited");
        await request(app).get("/api/limited");
        expect(runs.count).toBe(2);
    });

    it("should skip counting when the subject is null", async () => {
        const redis = { status: "ready", defineCommand: jest.fn(), slidingWindowHit: jest.fn() } as unknown as Redis;
        const { app, runs } = harness({ limit: 1, redis, subject: () => null });
        await request(app).get("/api/limited");
        await request(app).get("/api/limited");
        expect(runs.count).toBe(2);
        expect((redis as unknown as { slidingWindowHit: jest.Mock }).slidingWindowHit).not.toHaveBeenCalled();
    });

    it("should log rate_limiter_degraded at most once per 60 seconds per limiter", async () => {
        let now = 5_000_000;
        const name = uniqueName();
        const { app } = harness({ name, limit: 100, redis: downRedis(), now: () => now });
        const other = harness({ limit: 100, redis: downRedis(), now: () => now });

        await request(app).get("/api/limited");
        await request(app).get("/api/limited");
        now += 59_999;
        await request(app).get("/api/limited");
        await request(other.app).get("/api/limited");

        const degradedFor = (limiter: string) =>
            warn.mock.calls.filter(
                ([message, fields]) => message === "rate_limiter_degraded" && (fields as { limiter: string }).limiter === limiter,
            );
        expect(degradedFor(name)).toHaveLength(1);
        expect(metric).toHaveBeenCalledWith("rate_limiter_degraded", 1, { limiter: name });

        now += 1;
        await request(app).get("/api/limited");
        expect(degradedFor(name)).toHaveLength(2);
        expect(warn.mock.calls.filter(([message]) => message === "rate_limiter_degraded")).toHaveLength(3);
    });

    it("should call the Lua script with key rl:<name>:<subject>, now, window, limit, and a unique member", async () => {
        const name = uniqueName();
        const slidingWindowHit = jest.fn().mockResolvedValue([1, 0]);
        const defineCommand = jest.fn();
        const redis = { status: "ready", defineCommand, slidingWindowHit } as unknown as Redis;
        const { app } = harness({ name, limit: 5, windowMs: 1_000, redis, now: () => 42_000 });

        const res = await request(app).get("/api/limited");
        await request(app).get("/api/limited");

        expect(res.status).toBe(200);
        expect(defineCommand).toHaveBeenCalledTimes(1);
        expect(defineCommand).toHaveBeenCalledWith("slidingWindowHit", expect.objectContaining({ numberOfKeys: 1 }));
        expect(slidingWindowHit).toHaveBeenCalledWith(
            `rl:${name}:${SUBJECT}`,
            "42000",
            "1000",
            "5",
            `42000-${String(res.headers["x-request-id"])}`,
        );
    });

    it("should set Retry-After to at least 1 when denied (F17)", async () => {
        const now = 100_000;
        const cases: Array<[number, string]> = [
            [now - 500, "1"], // oldest 0.5 s ago in a 1 s window → 0.5 s → rounds up to 1
            [now, "1"],
            [0, "1"], // no oldest score reported → floor of 1
        ];
        for (const [oldest, expected] of cases) {
            const redis = {
                status: "ready",
                defineCommand: jest.fn(),
                slidingWindowHit: jest.fn().mockResolvedValue([0, oldest]),
            } as unknown as Redis;
            const { app, runs } = harness({ limit: 1, windowMs: 1_000, redis, now: () => now });
            const res = await request(app).get("/api/limited");
            expect(res.status).toBe(429);
            expect(res.headers["retry-after"]).toBe(expected);
            expect(res.body.error.code).toBe("RateLimited");
            expect(runs.count).toBe(0);
        }
    });

    it("should compute Retry-After from the oldest hit when the window is long", async () => {
        const now = 1_000_000;
        const redis = {
            status: "ready",
            defineCommand: jest.fn(),
            slidingWindowHit: jest.fn().mockResolvedValue([0, now - 20_000]),
        } as unknown as Redis;
        const { app } = harness({ limit: 1, windowMs: 60_000, redis, now: () => now });
        const res = await request(app).get("/api/limited");
        expect(res.headers["retry-after"]).toBe("40");
    });

    it("should not log the subject when a request is limited", async () => {
        const redis = {
            status: "ready",
            defineCommand: jest.fn(),
            slidingWindowHit: jest.fn().mockResolvedValue([0, 1]),
        } as unknown as Redis;
        const name = uniqueName();
        const { app } = harness({ name, limit: 1, redis });
        await request(app).get("/api/limited");

        const limited = warn.mock.calls.find(([message]) => message === "rate_limited");
        expect(limited?.[1]).toEqual({ requestId: expect.any(String) as string, limiter: name, route: "GET /api/limited" });
        expect(JSON.stringify(warn.mock.calls)).not.toContain(SUBJECT);
    });
});

describe("lib/rate-limit/subjects", () => {
    it("should return the client IP when byIp is used", () => {
        const req = { headers: {}, socket: { remoteAddress: "::ffff:192.0.2.1" } } as unknown as Request;
        expect(byIp(req)).toBe("192.0.2.1");
    });

    it("should return the user id when authenticated and null when not for byUser", () => {
        expect(byUser({ auth: { userId: 31, role: "patient", status: "active", emailVerified: true } } as Request)).toBe("31");
        expect(byUser({} as Request)).toBeNull();
    });
});

/** Foundation issue #11 (same pattern in the rate limiter): no promise in the middleware may reject unobserved. */
describe("regression #11: lib/rate-limit unexpected failures", () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("should forward an unexpected throw in the degrade path to next exactly once", async () => {
        jest.spyOn(logger, "warn").mockImplementation(() => undefined);
        jest.spyOn(logger, "metric").mockImplementation(() => undefined);
        jest.spyOn(logger, "error").mockImplementation(() => undefined);
        jest.spyOn(MemoryLimiter.prototype, "hit").mockImplementation(() => {
            throw new Error("synthetic limiter failure");
        });
        // Ready and admitted by its (fresh) breaker, but the script call fails: degrade, then the fallback throws.
        const stalled = {
            status: "ready",
            defineCommand: jest.fn(),
            slidingWindowHit: jest.fn(() => Promise.reject(new Error("Command timed out"))),
        } as unknown as Redis;
        const rejections: unknown[] = [];
        const onRejection = (reason: unknown): void => {
            rejections.push(reason);
        };
        process.on("unhandledRejection", onRejection);
        const nextCalls: unknown[] = [];
        try {
            const limiter = rateLimit({
                name: uniqueName(),
                limit: 4,
                windowMs: 60_000,
                subject: () => SUBJECT,
                redis: stalled,
            });
            const app = express();
            app.use(requestId());
            app.get(
                "/api/limited",
                (req: Request, res: express.Response, next: (err?: unknown) => void) =>
                    limiter(req, res, (err?: unknown) => {
                        nextCalls.push(err);
                        next(err);
                    }),
                (_req: Request, res: express.Response) => {
                    res.json({ ok: true });
                },
            );
            app.use(errorHandler);
            const res = await request(app).get("/api/limited");
            expect(res.status).toBe(500);
            expect(res.body.error.code).toBe("InternalError");
            expect(nextCalls).toHaveLength(1);
            expect(nextCalls[0]).toBeInstanceOf(Error);
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(rejections).toEqual([]);
        } finally {
            process.off("unhandledRejection", onRejection);
        }
    });
});
