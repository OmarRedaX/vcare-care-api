import type Redis from "ioredis";
import { logger } from "../../../../src/lib/logger/logger";
import {
    breakerFor,
    REDIS_BREAKER_FAILURE_THRESHOLD,
    REDIS_BREAKER_OPEN_MS,
    RedisBreaker,
} from "../../../../src/lib/redis/breaker";
import { isRedisUsable, withRedis } from "../../../../src/lib/redis/redis";

/** Foundation issue #10: a Redis that stalls while "ready" must not cost a command timeout on every request. */
describe("regression #10: lib/redis/RedisBreaker", () => {
    let warn: jest.SpyInstance;
    let info: jest.SpyInstance;
    let metric: jest.SpyInstance;
    const clock = { t: 1_000_000 };
    const breaker = (): RedisBreaker => new RedisBreaker({ now: () => clock.t });
    const open = (b: RedisBreaker): void => {
        for (let i = 0; i < REDIS_BREAKER_FAILURE_THRESHOLD; i += 1) {
            b.recordFailure();
        }
    };

    beforeEach(() => {
        warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
        info = jest.spyOn(logger, "info").mockImplementation(() => undefined);
        metric = jest.spyOn(logger, "metric").mockImplementation(() => undefined);
    });
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("should default to 3 failures and a 5 s open window", () => {
        expect(REDIS_BREAKER_FAILURE_THRESHOLD).toBe(3);
        expect(REDIS_BREAKER_OPEN_MS).toBe(5_000);
    });

    it("should open after 3 consecutive failures", () => {
        const b = breaker();
        b.recordFailure();
        b.recordFailure();
        expect(b.state).toBe("closed");
        expect(b.canAttempt()).toBe(true);
        b.recordFailure();
        expect(b.state).toBe("open");
        expect(b.canAttempt()).toBe(false);
    });

    it("should reset the count on success", () => {
        const b = breaker();
        b.recordFailure();
        b.recordFailure();
        b.recordSuccess();
        b.recordFailure();
        b.recordFailure();
        expect(b.state).toBe("closed");
    });

    it("should admit exactly one half-open probe after openMs", () => {
        const b = breaker();
        open(b);
        clock.t += REDIS_BREAKER_OPEN_MS - 1;
        expect(b.canAttempt()).toBe(false);
        clock.t += 1;
        expect(b.canAttempt()).toBe(true);
        expect(b.state).toBe("half_open");
        expect(b.canAttempt()).toBe(false); // a second caller waits for the probe
        clock.t += REDIS_BREAKER_OPEN_MS; // the probe never reported: another one is admitted
        expect(b.canAttempt()).toBe(true);
    });

    it("should close on a successful probe and reopen on a failed one", () => {
        const b = breaker();
        open(b);
        clock.t += REDIS_BREAKER_OPEN_MS;
        b.canAttempt();
        b.recordFailure(); // one failure while half-open reopens at once
        expect(b.state).toBe("open");
        expect(b.canAttempt()).toBe(false);

        clock.t += REDIS_BREAKER_OPEN_MS;
        expect(b.canAttempt()).toBe(true);
        b.recordSuccess();
        expect(b.state).toBe("closed");
        expect(b.canAttempt()).toBe(true);
    });

    it("should log and emit the metric once per transition", () => {
        const b = breaker();
        for (let i = 0; i < 5; i += 1) {
            b.recordFailure(); // opens on the 3rd; the 4th and 5th are not transitions
        }
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith("redis_breaker_open", { consecutiveFailures: 3 });
        expect(metric).toHaveBeenCalledTimes(1);
        expect(metric).toHaveBeenCalledWith("redis_breaker_open", 1);

        clock.t += REDIS_BREAKER_OPEN_MS;
        b.canAttempt();
        b.recordSuccess();
        b.recordSuccess();
        expect(info).toHaveBeenCalledTimes(1);
        expect(info).toHaveBeenCalledWith("redis_breaker_closed");
    });

    it("should keep one breaker per client and stop admitting commands through isRedisUsable once it opens", async () => {
        const client = { status: "ready" } as unknown as Redis;
        const other = { status: "ready" } as unknown as Redis;
        expect(breakerFor(client)).toBe(breakerFor(client));
        expect(breakerFor(client)).not.toBe(breakerFor(other));

        const stalled = jest.fn(() => Promise.reject(new Error("Command timed out")));
        for (let i = 0; i < REDIS_BREAKER_FAILURE_THRESHOLD; i += 1) {
            expect(isRedisUsable(client)).toBe(true);
            await expect(withRedis(client, stalled)).rejects.toThrow("Command timed out");
        }
        expect(isRedisUsable(client)).toBe(false); // still "ready", but kept out of the request path
        expect(stalled).toHaveBeenCalledTimes(REDIS_BREAKER_FAILURE_THRESHOLD);

        await expect(withRedis(other, () => Promise.resolve("OK"))).resolves.toBe("OK");
        expect(isRedisUsable(other)).toBe(true);
    });

    it("should report a not-ready client as unusable", () => {
        expect(isRedisUsable({ status: "reconnecting" } as unknown as Redis)).toBe(false);
    });
});
