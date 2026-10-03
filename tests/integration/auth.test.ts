import type { Express } from "express";
import request from "supertest";
import { buildTestApps } from "../helpers/app";
import { expectErrorEnvelope, expectSuccessEnvelope } from "../helpers/contract";
import { closeDb, truncateAll } from "../helpers/db";
import { createTestClock, JWKS_PATH, startFakeJwks, withFakeJwksCache } from "../helpers/fake-jwks";
import { closeRedis, ensureRedisReady } from "../helpers/redis";
import { buildAccessTestRouter } from "../helpers/test-routers";
import { signExpiredUserToken, signUserToken, tamperToken } from "../helpers/tokens";
import type { FakeJwks } from "../helpers/types";

jest.setTimeout(20_000);

const MINUTE = 60_000;
const ANY = "/api/__test/access/any";

/**
 * User-token verification through the REAL wiring (userGuard → authorize → handler, real JwksCache + undici fetcher +
 * DTO validation). Only Identity is faked: a local JWKS HTTP server signing with fresh Ed25519 keys (spec §9.4).
 * The cache gets an injected clock so the 1-minute gate and the 1-hour cap are exercised without real waiting.
 */
describe("user-token authentication (integration: real wiring, fake Identity JWKS)", () => {
    let fake: FakeJwks;
    let app: Express;

    beforeAll(async () => {
        await ensureRedisReady();
        await truncateAll();
        fake = await startFakeJwks(["k1"]);
        app = buildTestApps({ publicRouters: [{ path: "/api", router: buildAccessTestRouter() }] }).publicApp;
    });

    beforeEach(() => {
        fake.requests.length = 0;
        fake.setMode("normal");
        fake.setBody(undefined);
    });

    afterAll(async () => {
        await fake.close();
        await closeRedis();
        await closeDb();
    });

    const call = (token?: string) => {
        const req = request(app).get(ANY);
        return token === undefined ? req : req.set("Authorization", `Bearer ${token}`);
    };

    it.each([
        ["patient", "101"],
        ["doctor", "202"],
        ["admin", "303"],
    ])("should return 200 with the token's userId and role for a %s (A2)", async (role, sub) => {
        await withFakeJwksCache(fake, async () => {
            const res = await call(await signUserToken(fake.key("k1"), { role, sub }));
            expect(res.status).toBe(200);
            expect(expectSuccessEnvelope(res.body)).toEqual({ userId: Number(sub), role });
        });
    });

    it("should return 401 Unauthorized for no token, a non-Bearer scheme, a tampered token, a wrong aud, a wrong iss, typ=service, or an unknown kid (A2)", async () => {
        await withFakeJwksCache(fake, async () => {
            const key = fake.key("k1");
            const valid = await signUserToken(key);
            const cases: Array<[string, () => Promise<request.Response>]> = [
                ["no token", () => call()],
                ["non-Bearer scheme", () => request(app).get(ANY).set("Authorization", `Basic ${valid}`)],
                ["tampered", () => call(tamperToken(valid))],
                ["wrong aud", async () => call(await signUserToken(key, { aud: ["vcare-identity"] }))],
                ["wrong iss", async () => call(await signUserToken(key, { iss: "evil-identity" }))],
                ["typ=service", async () => call(await signUserToken(key, { typ: "service" }))],
                ["unknown kid", async () => call(await signUserToken(key, undefined, { header: { kid: "k-ghost" } }))],
            ];
            for (const [label, make] of cases) {
                const res = await make();
                expect({ label, status: res.status }).toEqual({ label, status: 401 });
                expectErrorEnvelope(res.body, "Unauthorized", res.headers["x-request-id"]);
                expect(res.body.error.message).toBe("Authentication required");
            }
        });
    });

    it("should return 401 TokenExpired for an expired token (A3)", async () => {
        await withFakeJwksCache(fake, async () => {
            const res = await call(await signExpiredUserToken(fake.key("k1")));
            expect(res.status).toBe(401);
            expectErrorEnvelope(res.body, "TokenExpired", res.headers["x-request-id"]);
            expect(res.body.error.message).toBe("Access token expired");
        });
    });

    it("should ignore X-User-Id and X-Role headers (A1)", async () => {
        await withFakeJwksCache(fake, async () => {
            const res = await call(await signUserToken(fake.key("k1"), { sub: "101", role: "patient" }))
                .set("X-User-Id", "999")
                .set("X-Role", "admin")
                .set("X-Forwarded-User", "admin@example.test");
            expect(expectSuccessEnvelope(res.body)).toEqual({ userId: 101, role: "patient" });

            // Identity headers alone grant nothing.
            const headersOnly = await request(app).get("/api/__test/access/admin").set("X-User-Id", "1").set("X-Role", "admin");
            expect(headersOnly.status).toBe(401);
        });
    });

    it("should accept a token signed by a newly added key after exactly one extra JWKS request (A4)", async () => {
        const clock = createTestClock();
        await withFakeJwksCache(
            fake,
            async () => {
                expect(fake.requests).toHaveLength(1); // the priming boot fetch
                const rotated = await fake.addKey("k-rotated-1");
                clock.advance(MINUTE + 1);

                const res = await call(await signUserToken(rotated));
                expect(res.status).toBe(200);
                expect(fake.requests).toHaveLength(2);

                // Both keys now verify without further fetches.
                expect((await call(await signUserToken(fake.key("k1")))).status).toBe(200);
                expect((await call(await signUserToken(rotated))).status).toBe(200);
                expect(fake.requests).toHaveLength(2);
            },
            { clock },
        );
        fake.removeKey("k-rotated-1");
    });

    it("should make at most one JWKS request for two unknown-kid requests within a minute (A4)", async () => {
        const clock = createTestClock();
        await withFakeJwksCache(
            fake,
            async () => {
                clock.advance(MINUTE + 1);
                const key = fake.key("k1");
                const first = await call(await signUserToken(key, undefined, { header: { kid: "k-random-1" } }));
                const second = await call(await signUserToken(key, undefined, { header: { kid: "k-random-2" } }));
                clock.advance(30_000);
                const third = await call(await signUserToken(key, undefined, { header: { kid: "k-random-3" } }));
                expect([first.status, second.status, third.status]).toEqual([401, 401, 401]);
                expect(fake.requests).toHaveLength(2); // boot + one gated refetch
            },
            { clock },
        );
    });

    it("should reject a token whose kid was removed after the next refresh (A6)", async () => {
        const doomed = await fake.addKey("k-doomed");
        await withFakeJwksCache(fake, async ({ cache }) => {
            const token = await signUserToken(doomed);
            expect((await call(token)).status).toBe(200);

            fake.removeKey("k-doomed");
            expect(await cache.refresh("interval")).toBe(true); // the 5-minute tick
            const res = await call(token);
            expect(res.status).toBe(401);
            expectErrorEnvelope(res.body, "Unauthorized");
            expect((await call(await signUserToken(fake.key("k1")))).status).toBe(200);
        });
    });

    it("should keep the previous key set when the JWKS server answers with a malformed document (A6)", async () => {
        await withFakeJwksCache(fake, async ({ cache }) => {
            fake.setBody('{"keys": "not-an-array"}');
            expect(await cache.refresh("interval")).toBe(false);
            fake.setBody("<html>oops</html>", "text/html");
            expect(await cache.refresh("interval")).toBe(false);
            expect((await call(await signUserToken(fake.key("k1")))).status).toBe(200);
        });
    });

    it("should keep verifying with cached keys while the JWKS server fails, for at most 1 h (A5)", async () => {
        const clock = createTestClock();
        await withFakeJwksCache(
            fake,
            async ({ cache }) => {
                const token = await signUserToken(fake.key("k1"));
                fake.setMode("fail", { status: 503 });

                clock.advance(10 * MINUTE);
                expect(await cache.refresh("interval")).toBe(false);
                expect((await call(token)).status).toBe(200); // stale-if-error
                expect(cache.status()).toBe("down");

                clock.advance(50 * MINUTE); // exactly 1 h after the last success
                expect((await call(token)).status).toBe(200);

                clock.advance(1); // older than 1 h: nothing is trusted any more
                const res = await call(token);
                expect(res.status).toBe(401);
                expectErrorEnvelope(res.body, "Unauthorized");
            },
            { clock },
        );
    });

    it("should return 401 and never reach the handler when the JWKS server is down and no key is cached (A5)", async () => {
        fake.setMode("fail", { status: 500 });
        await withFakeJwksCache(
            fake,
            async () => {
                const res = await call(await signUserToken(fake.key("k1"), { role: "admin" }));
                expect(res.status).toBe(401);
                expectErrorEnvelope(res.body, "Unauthorized");
                expect(fake.requests).toHaveLength(1); // one demand fetch, which failed
            },
            { prime: false },
        );
    });

    it("should return 401 with the real container wiring when IDENTITY_JWKS_URL is unreachable (never skips verification)", async () => {
        // No override: the container's cache points at the unreachable .env.test placeholder.
        const res = await call(await signUserToken(fake.key("k1"), { role: "admin" }));
        expect(res.status).toBe(401);
        expectErrorEnvelope(res.body, "Unauthorized");
    });

    it("should forward X-Request-Id on a request-triggered JWKS fetch", async () => {
        await withFakeJwksCache(
            fake,
            async () => {
                const requestId = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
                const res = await call(await signUserToken(fake.key("k1"))).set("X-Request-Id", requestId);
                expect(res.status).toBe(200);
                expect(fake.requests).toHaveLength(1);
                expect(fake.requests[0]?.url).toBe(JWKS_PATH);
                expect(fake.requests[0]?.headers["x-request-id"]).toBe(requestId);
                expect(fake.requests[0]?.headers.accept).toBe("application/json");
            },
            { prime: false },
        );
    });
});
