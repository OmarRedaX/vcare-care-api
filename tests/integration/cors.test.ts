import request from "supertest";
import { getEnv } from "../../src/lib/config/env";
import { buildTestApps } from "../helpers/app";
import { closeDb } from "../helpers/db";
import { closeRedis } from "../helpers/redis";

const ALLOWED = "http://localhost:5173";

/**
 * CORS is mounted only when NODE_ENV=development (F22). `.env.test` runs with NODE_ENV=test, so the memoized env
 * object is switched to development for the apps built inside these tests (jest.replaceProperty restores it).
 * This is configuration, not an infrastructure mock: the real apps and the real `cors()` middleware run.
 */
describe("dev CORS allowlist (integration)", () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    afterAll(async () => {
        await closeRedis();
        await closeDb();
    });

    it("should load .env.test with the allowlisted dev origin", () => {
        expect(getEnv().CORS_ORIGINS).toContain(ALLOWED);
    });

    it("should return allow-origin for an allowlisted origin when NODE_ENV is development (F22)", async () => {
        jest.replaceProperty(getEnv(), "NODE_ENV", "development");
        const { publicApp } = buildTestApps();

        const res = await request(publicApp).get("/api/health/live").set("Origin", ALLOWED);
        expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
        expect(res.headers.vary).toContain("Origin");
        expect(res.headers["access-control-expose-headers"]).toBe("X-Request-Id, Retry-After");

        const preflight = await request(publicApp)
            .options("/api/anything")
            .set("Origin", ALLOWED)
            .set("Access-Control-Request-Method", "POST")
            .set("Access-Control-Request-Headers", "Idempotency-Key");
        expect(preflight.status).toBe(204);
        expect(preflight.headers["access-control-allow-headers"]).toContain("Idempotency-Key");
        expect(preflight.headers["x-request-id"]).toBeDefined();
    });

    it("should return no CORS headers for an origin outside the allowlist in development (F22)", async () => {
        jest.replaceProperty(getEnv(), "NODE_ENV", "development");
        const { publicApp } = buildTestApps();
        const res = await request(publicApp).get("/api/health/live").set("Origin", "http://evil.example.test");
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("should return no CORS headers on the internal listener (F22)", async () => {
        jest.replaceProperty(getEnv(), "NODE_ENV", "development");
        const { internalApp } = buildTestApps();
        const res = await request(internalApp).get("/internal/health/live").set("Origin", ALLOWED);
        expect(res.status).toBe(200);
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();

        const preflight = await request(internalApp)
            .options("/internal/health/live")
            .set("Origin", ALLOWED)
            .set("Access-Control-Request-Method", "GET");
        expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
        expect(preflight.status).not.toBe(204);
    });

    it.each(["test", "production"] as const)(
        "should return no CORS headers even for an allowlisted origin when NODE_ENV is %s (F22)",
        async (nodeEnv) => {
            jest.replaceProperty(getEnv(), "NODE_ENV", nodeEnv);
            const { publicApp } = buildTestApps();
            const res = await request(publicApp).get("/api/health/live").set("Origin", ALLOWED);
            expect(res.headers["access-control-allow-origin"]).toBeUndefined();
        },
    );

    it("should not mount CORS in development when the allowlist is empty", async () => {
        jest.replaceProperty(getEnv(), "NODE_ENV", "development");
        jest.replaceProperty(getEnv(), "CORS_ORIGINS", []);
        const { publicApp } = buildTestApps();
        const res = await request(publicApp).get("/api/health/live").set("Origin", ALLOWED);
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });
});
