import type Redis from "ioredis";
import { getEnv } from "../../../../src/lib/config/env";
import { IdentityClient } from "../../../../src/lib/identity-client/identity-client";
import { FakeIdentityServer } from "../../../helpers/fake-identity-server";
import { fakeLogger } from "../../../helpers/fake-logger";

const ADDRESS = "synthetic.contact.one@example.test";
const NAME = "Synthetic Contact One";

describe("IdentityClient.getContacts (Case 5)", () => {
    let fake: FakeIdentityServer;
    let url: string;
    const redisCalls: string[] = [];
    const redis = new Proxy({}, { get: (_target, property) => { redisCalls.push(String(property)); return jest.fn(); } }) as unknown as Redis;

    beforeEach(async () => {
        fake = new FakeIdentityServer();
        url = await fake.start();
        redisCalls.length = 0;
        fake.contacts.set(1, { id: 1, email: ADDRESS, fullName: NAME, locale: "en", status: "active" });
        fake.contacts.set(2, { id: 2, email: "synthetic.contact.two@example.test", fullName: "Synthetic Contact Two", locale: "ar", status: "suspended" });
    });
    afterEach(async () => { await fake.close(); });

    function make(): { client: IdentityClient; log: ReturnType<typeof fakeLogger> } {
        const log = fakeLogger();
        const client = new IdentityClient({ env: { ...getEnv(), IDENTITY_INTERNAL_URL: url }, redis, logger: log.logger, sleep: () => Promise.resolve() });
        return { client, log };
    }
    const contactCalls = (): string[] => fake.calls.filter((call) => call.path.startsWith("/internal/users/contacts")).map((call) => call.path);

    it("should return the contacts and treat absent ids as unknown", async () => {
        const { client } = make();
        const result = await client.getContacts([1, 2, 3], "req-1");
        expect([...result.contacts.keys()].sort()).toEqual([1, 2]);
        expect(result.contacts.get(1)).toEqual({ email: ADDRESS, fullName: NAME, locale: "en", status: "active" });
        expect(result.contacts.get(2)?.status).toBe("suspended");
        expect(result.unavailable.size).toBe(0);
    });

    it("should chunk 250 ids into 3 calls of at most 100 and de-duplicate", async () => {
        const { client } = make();
        const ids = Array.from({ length: 250 }, (_, index) => index + 1);
        await client.getContacts([...ids, ...ids, -4, 0, 1.5], "req-2");
        const paths = contactCalls();
        expect(paths).toHaveLength(3);
        expect(paths.map((path) => path.split("=")[1]?.split(",").length)).toEqual([100, 100, 50]);
    });

    it("should make no call for an empty or invalid list", async () => {
        const { client } = make();
        const result = await client.getContacts([0, -1, Number.NaN], "req-3");
        expect(result.contacts.size + result.unavailable.size).toBe(0);
        expect(fake.calls).toHaveLength(0);
    });

    it("should request its own contact-scoped token and forward the request id", async () => {
        const { client } = make();
        await client.getContacts([1], "req-4");
        expect(fake.tokenScopes).toEqual(["users:contact:read"]);
        expect(fake.contactTokens).toEqual(["Bearer fake-contact-token"]);
        expect(fake.calls.filter((call) => call.path.startsWith("/internal/users/contacts")).every((call) => call.requestId === "req-4")).toBe(true);
    });

    it("should never request the contact scope from the status client path", async () => {
        const { client } = make();
        fake.users.set(1, { id: 1, fullName: "x", avatarUrl: null, status: "pending" });
        await client.setUserStatus(1, "active", "review", 7, "req-5", 1);
        expect(fake.tokenScopes).toEqual(["users:read users:status:write"]);
    });

    it("should refresh the contact token once on a 401", async () => {
        const { client } = make();
        fake.options.contactsForceUnauthorized = 1;
        const result = await client.getContacts([1], "req-6");
        expect(result.contacts.has(1)).toBe(true);
        expect(fake.tokenScopes).toEqual(["users:contact:read", "users:contact:read"]);
    });

    it("should mark a chunk unavailable after a second 401", async () => {
        const { client } = make();
        fake.options.contactsForceUnauthorized = 2;
        expect([...(await client.getContacts([1], "req-7")).unavailable]).toEqual([1]);
    });

    it.each([403, 429, 500, 503, 400])("should mark the chunk unavailable on HTTP %i", async (status) => {
        const { client, log } = make();
        fake.options.contactsFailures = Infinity;
        fake.options.contactsStatus = status;
        const result = await client.getContacts([1, 2], "req-8");
        expect([...result.unavailable].sort()).toEqual([1, 2]);
        expect(result.contacts.size).toBe(0);
        expect(log.warn).toHaveBeenCalledWith("notification_contacts_unavailable", { errorCode: `HTTP_${status}`, ids: 2 });
        expect(log.metric).toHaveBeenCalledWith("identity_call_failed", 1, { case: "contacts" });
        expect(contactCalls()).toHaveLength(1);
    });

    it("should mark the chunk unavailable on a network error", async () => {
        const { client } = make();
        fake.options.down = true;
        expect([...(await client.getContacts([1], "req-9")).unavailable]).toEqual([1]);
    });

    it("should mark the chunk unavailable on a timeout", async () => {
        const { client } = make();
        fake.options.slowMs = 2_500;
        expect([...(await client.getContacts([1], "req-10")).unavailable]).toEqual([1]);
    }, 10_000);

    it("should mark the chunk unavailable when the token lacks the contact scope", async () => {
        const { client } = make();
        fake.options.withholdContactScope = true;
        expect([...(await client.getContacts([1], "req-11")).unavailable]).toEqual([1]);
        expect(contactCalls()).toHaveLength(0);
    });

    it("should mark the chunk unavailable when the token endpoint fails", async () => {
        const { client } = make();
        fake.options.tokenFailures = 1;
        expect([...(await client.getContacts([1], "req-12")).unavailable]).toEqual([1]);
    });

    it("should mark the chunk unavailable on a malformed 200 body", async () => {
        const { client } = make();
        fake.options.malformed = true;
        expect([...(await client.getContacts([1], "req-13")).unavailable]).toEqual([1]);
    });

    it.each(["bad-email", "extra-id", "duplicate-id"] as const)("should reject the whole chunk on %s", async (mode) => {
        const { client } = make();
        fake.options.contactsMalformed = mode;
        const result = await client.getContacts([1, 2], "req-14");
        expect([...result.unavailable].sort()).toEqual([1, 2]);
        expect(result.contacts.size).toBe(0);
    });

    it("should fail only the failing chunk", async () => {
        const { client } = make();
        fake.options.contactsFailures = 1;
        const ids = [...Array.from({ length: 100 }, (_, index) => index + 3), 1];
        const result = await client.getContacts(ids, "req-15");
        expect(result.unavailable.size).toBe(100);
        expect(result.unavailable.has(1)).toBe(false);
        expect(result.contacts.has(1)).toBe(true);
    });

    it("should neither touch Redis nor log the address or name", async () => {
        const { client, log } = make();
        await client.getContacts([1, 2], "req-16");
        fake.options.contactsFailures = 1;
        await client.getContacts([1], "req-17");
        expect(redisCalls).toEqual([]);
        expect(log.text()).not.toContain("synthetic.contact");
        expect(log.text()).not.toContain(NAME);
    });
});
