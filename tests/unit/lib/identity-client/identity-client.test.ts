import { FakeIdentityServer } from "../../../helpers/fake-identity-server";
import { IdentityClient } from "../../../../src/lib/identity-client/identity-client";
import { getEnv } from "../../../../src/lib/config/env";
import { createUnreachableRedis } from "../../../helpers/redis";
import { Logger } from "../../../../src/lib/logger/logger";

describe("IdentityClient", () => {
    let fake: FakeIdentityServer;
    let url: string;
    beforeEach(async () => { fake = new FakeIdentityServer(); url = await fake.start(); fake.users.set(1, { id: 1, fullName: "Private Name", avatarUrl: null, status: "pending" }); });
    afterEach(async () => { await fake.close(); });
    const make = (url: string, overrides: ConstructorParameters<typeof IdentityClient>[0] = {}): IdentityClient =>
        new IdentityClient({ env: { ...getEnv(), IDENTITY_INTERNAL_URL: url }, redis: createUnreachableRedis(), ...overrides });

    it("single flights tokens, forwards request id, and refreshes on 401", async () => {
        const client = make(url);
        await Promise.all([client.setUserStatus(1, "active", "review", 7, "request-1", 1), client.setUserStatus(1, "active", "review", 7, "request-1", 1)]);
        expect(fake.calls.filter((call) => call.path === "/internal/auth/token")).toHaveLength(1);
        expect(fake.calls.every((call) => call.requestId === "request-1")).toBe(true);
        fake.options.forceUnauthorized = 1;
        expect(await client.setUserStatus(1, "active", "review", 7, "request-2", 1)).toEqual({ outcome: "applied" });
        expect(fake.calls.filter((call) => call.path === "/internal/auth/token")).toHaveLength(2);
    });

    it("distinguishes applied, rejected transition, and retryable errors", async () => {
        const client = make(url, { sleep: () => Promise.resolve(), random: () => 0 });
        expect(await client.setUserStatus(1, "active", "review", 7, "r", 1)).toEqual({ outcome: "applied" });
        fake.options.forceConflict = true;
        expect(await client.setUserStatus(1, "rejected", "review", 7, "r")).toEqual({ outcome: "rejected-transition" });
        fake.options.forceConflict = false;
        expect(await client.setUserStatus(99, "active", "review", 7, "r", 2)).toEqual({ outcome: "transient", errorCode: "HTTP_404" });
        expect(fake.calls.filter((call) => call.path === "/internal/users/99/status")).toHaveLength(2);
        fake.options.statusFailures = 2;
        expect(await client.setUserStatus(1, "active", "review", 7, "r", 2)).toEqual({ outcome: "transient", errorCode: "HTTP_500" });
    });

    it("deduplicates and chunks, then degrades on provider failure", async () => {
        const client = make(url, { sleep: () => Promise.resolve() });
        const result = await client.getUsersBatch([1, 1, ...Array.from({ length: 101 }, (_, i) => i + 2)], "batch-r");
        expect(result.users.get(1)?.displayName).toBe("Private Name");
        expect(result.degraded).toBe(false);
        expect(fake.calls.filter((call) => call.path.startsWith("/internal/users?"))).toHaveLength(2);
        fake.options.batchFailures = 2;
        const degraded = await client.getUsersBatch([1], "batch-r");
        expect(degraded.degraded).toBe(true);
        expect(degraded.users.size).toBe(0);
    });

    it("refreshes 30 seconds before expiry and bounds retry delays", async () => {
        let now = 0;
        const delays: number[] = [];
        const client = make(url, { now: () => now, random: () => 0,
            sleep: (ms) => { delays.push(ms); return Promise.resolve(); } });
        expect((await client.setUserStatus(1, "active", "review", 7, "r", 1)).outcome).toBe("applied");
        now = 269_999;
        await client.setUserStatus(1, "active", "review", 7, "r", 1);
        expect(fake.calls.filter((call) => call.path === "/internal/auth/token")).toHaveLength(1);
        now = 270_000;
        await client.setUserStatus(1, "active", "review", 7, "r", 1);
        expect(fake.calls.filter((call) => call.path === "/internal/auth/token")).toHaveLength(2);
        fake.options.statusFailures = 3;
        expect(await client.setUserStatus(1, "active", "review", 7, "r")).toEqual({ outcome: "transient", errorCode: "HTTP_500" });
        expect(delays).toEqual([160, 320]);
    });

    it("treats 429, 401 after refresh, malformed success, and timeouts as transient", async () => {
        const client = make(url, { sleep: () => Promise.resolve() });
        fake.options.statusFailures = 2;
        fake.options.statusFailureCode = 429;
        expect(await client.setUserStatus(1, "active", "review", 7, "r", 2)).toEqual({ outcome: "transient", errorCode: "HTTP_429" });
        fake.options.forceUnauthorized = 2;
        expect(await client.setUserStatus(1, "active", "review", 7, "r", 1)).toEqual({ outcome: "transient", errorCode: "HTTP_401" });
        fake.options.malformed = true;
        expect(await client.setUserStatus(1, "active", "review", 7, "r", 1)).toEqual({ outcome: "transient", errorCode: "MalformedResponse" });
        fake.options.malformed = false;
        fake.options.slowMs = 2_100;
        expect((await client.setUserStatus(1, "active", "review", 7, "r", 1)).outcome).toBe("transient");
    }, 8_000);

    it("degrades on malformed batch responses without logging borrowed data or reason", async () => {
        const lines: string[] = [];
        const safeLogger = new Logger({ level: "debug", service: "care-service", write: (line) => { lines.push(line); } });
        const client = make(url, { logger: safeLogger, sleep: () => Promise.resolve() });
        fake.options.malformed = true;
        expect(await client.getUsersBatch([1], "r")).toEqual({ users: new Map(), degraded: true });
        expect(lines.join(" ")).toContain("identity_hydration_degraded");
        expect(lines.join(" ")).not.toMatch(/Private Name|fake-token|synthetic reason/);
    });
});
