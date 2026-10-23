import type Redis from "ioredis";
import { breakerFor } from "../../../../src/lib/redis/breaker";
import { tryRedis } from "../../../../src/lib/redis/try-redis";

describe("tryRedis", () => {
    it("should skip the command when the connection is not usable", async () => {
        const command = jest.fn();
        expect(await tryRedis({ status: "wait" } as Redis, command)).toEqual({ ok: false });
        expect(command).not.toHaveBeenCalled();
    });
    it("should return the value and report command success", async () => {
        const client = { status: "ready" } as Redis;
        expect(await tryRedis(client, () => Promise.resolve(42))).toEqual({ ok: true, value: 42 });
        expect(breakerFor(client).state).toBe("closed");
    });
    it("should swallow failure and open the shared breaker after repeated errors", async () => {
        const client = { status: "ready" } as Redis;
        const command = jest.fn().mockRejectedValue(new Error("synthetic redis failure"));
        for (let i = 0; i < 3; i += 1) expect(await tryRedis(client, command)).toEqual({ ok: false });
        expect(breakerFor(client).state).toBe("open");
        expect(await tryRedis(client, command)).toEqual({ ok: false });
        expect(command).toHaveBeenCalledTimes(3);
    });
});
