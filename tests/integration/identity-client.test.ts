import { FakeIdentityServer } from "../helpers/fake-identity-server";
import { IdentityClient } from "../../src/lib/identity-client/identity-client";
import { getEnv } from "../../src/lib/config/env";
import { redis } from "../../src/lib/redis/redis";
import { closeRedis, ensureRedisReady, flushByPrefix } from "../helpers/redis";

describe("Identity client with real Redis", () => {
    let fake: FakeIdentityServer;
    let client: IdentityClient;
    beforeAll(async () => {
        await ensureRedisReady();
        fake = new FakeIdentityServer();
        const url = await fake.start();
        fake.users.set(42, { id: 42, fullName: "Synthetic Doctor", avatarUrl: null, status: "pending" });
        client = new IdentityClient({ env: { ...getEnv(), IDENTITY_INTERNAL_URL: url }, redis, sleep: () => Promise.resolve() });
    });
    afterAll(async () => { await flushByPrefix(["identity:user:"]); await client.close(); await fake.close(); await closeRedis(); });
    it("writes status, caches only display fields for 300 seconds, and serves cache on failure", async () => {
        expect(await client.setUserStatus(42, "active", "synthetic reason", 1, "integration-r")).toEqual({ outcome: "applied", attemptsMade: 1 });
        expect((await client.getUsersBatch([42], "integration-r")).users.get(42)?.status).toBe("active");
        expect(await redis.ttl("identity:user:42")).toBeGreaterThan(0);
        expect(await redis.ttl("identity:user:42")).toBeLessThanOrEqual(300);
        expect(JSON.parse((await redis.get("identity:user:42")) ?? "{}" )).toEqual({ fullName: "Synthetic Doctor", avatarUrl: null, status: "active" });
        fake.options.batchFailures = 2;
        expect((await client.getUsersBatch([42, 999], "integration-r")).users.has(42)).toBe(true);
    });
    it("stops on provider 409 and degrades when the provider is down", async () => {
        fake.options.forceConflict = true;
        expect(await client.setUserStatus(42, "rejected", "synthetic reason", 1, "integration-r"))
            .toEqual({ outcome: "rejected-transition", attemptsMade: 1 });
        fake.options.forceConflict = false;
        fake.options.down = true;
        const result = await client.getUsersBatch([42, 999], "integration-r");
        expect(result.degraded).toBe(true);
        expect(result.users.get(42)?.displayName).toBe("Synthetic Doctor");
        expect(result.users.has(999)).toBe(false);
    });
});
