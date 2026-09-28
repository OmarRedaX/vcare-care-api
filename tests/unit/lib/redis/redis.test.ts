import type Redis from "ioredis";
import { logger } from "../../../../src/lib/logger/logger";
import { container } from "../../../../src/lib/di/container";
import { TOKENS } from "../../../../src/lib/di/tokens";
import { closeRedis, createRedis, isRedisReady, probeRedis, redis, resolveRedis } from "../../../../src/lib/redis/redis";

function fakeRedis(status: string, ping: () => Promise<string>): Redis & { pingMock: jest.Mock } {
    const pingMock = jest.fn(ping);
    return { status, ping: pingMock, pingMock } as unknown as Redis & { pingMock: jest.Mock };
}

describe("lib/redis", () => {
    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it.each(["wait", "connecting", "reconnecting", "end", "close"])(
        "should report not ready when status is %p",
        (status) => {
            expect(isRedisReady(fakeRedis(status, () => Promise.resolve("PONG")))).toBe(false);
        },
    );

    it("should report ready when status is ready", () => {
        expect(isRedisReady(fakeRedis("ready", () => Promise.resolve("PONG")))).toBe(true);
    });

    it("should resolve true when PING answers PONG", async () => {
        await expect(probeRedis(fakeRedis("ready", () => Promise.resolve("PONG")), 500)).resolves.toBe(true);
    });

    it("should skip the round trip and resolve false when the client is not ready", async () => {
        const client = fakeRedis("reconnecting", () => Promise.resolve("PONG"));
        await expect(probeRedis(client, 500)).resolves.toBe(false);
        expect(client.pingMock).not.toHaveBeenCalled();
    });

    it("should resolve false when PING rejects", async () => {
        await expect(probeRedis(fakeRedis("ready", () => Promise.reject(new Error("down"))), 500)).resolves.toBe(false);
    });

    it("should resolve false when PING exceeds the timeout", async () => {
        jest.useFakeTimers();
        const probe = probeRedis(fakeRedis("ready", () => new Promise<string>(() => undefined)), 500);
        await jest.advanceTimersByTimeAsync(500);
        await expect(probe).resolves.toBe(false);
    });

    it("should configure fail-fast Tier 2 options when a client is created", () => {
        const client = createRedis("redis://127.0.0.1:1/0", { name: "care-unit" });
        try {
            expect(client.status).toBe("wait");
            expect(client.options).toMatchObject({
                lazyConnect: true,
                enableOfflineQueue: false,
                maxRetriesPerRequest: 1,
                connectTimeout: 2_000,
                commandTimeout: 500,
                // parity e: a command on the wire at disconnect is never replayed after the reconnect
                autoResendUnfulfilledCommands: false,
                connectionName: "care-unit",
            });
            const retry = client.options.retryStrategy;
            expect(retry?.(1)).toBe(200);
            expect(retry?.(5)).toBe(1_000);
            expect(retry?.(50)).toBe(2_000);
        } finally {
            client.disconnect();
        }
    });

    it("should log one line per transition when the client goes down and recovers", () => {
        const info = jest.spyOn(logger, "info").mockImplementation(() => undefined);
        const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
        const client = createRedis("redis://127.0.0.1:1/0");
        try {
            client.emit("error", new Error("before first ready")); // never healthy yet → silent
            client.emit("ready");
            client.emit("ready");
            client.emit("error", new Error("drop 1"));
            client.emit("error", new Error("drop 2"));
            client.emit("ready");

            expect(info.mock.calls.map((call) => call[0])).toEqual(["redis_recovered", "redis_recovered"]);
            expect(warn.mock.calls.map((call) => call[0])).toEqual(["redis_unavailable"]);
        } finally {
            client.disconnect();
        }
    });

    it("should prefer the explicit override when resolving a client", () => {
        const override = fakeRedis("ready", () => Promise.resolve("PONG"));
        expect(resolveRedis(override)).toBe(override);
    });

    it("should resolve the container's client when one is registered", () => {
        const registered = fakeRedis("ready", () => Promise.resolve("PONG"));
        const child = container.createChildContainer();
        child.registerInstance(TOKENS.Redis, registered);
        jest.spyOn(container, "isRegistered").mockImplementation((token) => child.isRegistered(token));
        jest.spyOn(container, "resolve").mockImplementation((token) => child.resolve(token));
        expect(resolveRedis()).toBe(registered);
    });

    it("should fall back to the root client when nothing is registered", () => {
        jest.spyOn(container, "isRegistered").mockReturnValue(false);
        expect(resolveRedis()).toBe(redis);
    });

    it("should disconnect when QUIT fails while closing", async () => {
        const client = { quit: jest.fn().mockRejectedValue(new Error("closed")), disconnect: jest.fn() };
        await closeRedis(client as unknown as Redis);
        expect(client.disconnect).toHaveBeenCalledTimes(1);
    });

    it("should not disconnect when QUIT succeeds while closing", async () => {
        const client = { quit: jest.fn().mockResolvedValue("OK"), disconnect: jest.fn() };
        await closeRedis(client as unknown as Redis);
        expect(client.disconnect).not.toHaveBeenCalled();
    });
});
