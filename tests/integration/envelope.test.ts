import request from "supertest";
import { buildTestApps } from "../helpers/app";
import { expectErrorEnvelope, expectSuccessEnvelope } from "../helpers/contract";
import { closeDb, truncateAll } from "../helpers/db";
import { closeRedis, ensureRedisReady } from "../helpers/redis";
import { buildEnvelopeRouter } from "../helpers/test-routers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function apps() {
    return buildTestApps({
        publicRouters: [{ path: "/api", router: buildEnvelopeRouter() }],
        internalRouters: [{ path: "/internal", router: buildEnvelopeRouter() }],
    });
}

describe("error envelope, request id, security headers (integration)", () => {
    beforeAll(async () => {
        await ensureRedisReady();
        await truncateAll();
    });

    afterAll(async () => {
        await closeRedis();
        await closeDb();
    });

    it("should return a NotFound envelope with the request id when the path is unknown on either listener (F4, F11)", async () => {
        const { publicApp, internalApp } = apps();
        for (const [app, path] of [
            [publicApp, "/api/does-not-exist"],
            [publicApp, "/"],
            [publicApp, "/internal/anything"],
            [internalApp, "/internal/does-not-exist"],
            [internalApp, "/api/anything"],
        ] as const) {
            const res = await request(app).get(path);
            expect(res.status).toBe(404);
            expect(res.headers["x-request-id"]).toMatch(UUID);
            expectErrorEnvelope(res.body, "NotFound", res.headers["x-request-id"]);
            expect(res.body).toEqual({
                success: false,
                error: {
                    code: "NotFound",
                    message: "Resource not found",
                    details: [],
                    requestId: res.headers["x-request-id"] as string,
                },
            });
        }
    });

    it("should return 404 when a known path is called with an unmatched method", async () => {
        const { publicApp } = apps();
        const res = await request(publicApp).delete("/api/__test/echo");
        expect(res.status).toBe(404);
        expectErrorEnvelope(res.body, "NotFound");
    });

    it("should not serve test routes of one listener on the other (listener isolation)", async () => {
        const { publicApp, internalApp } = apps();
        expect((await request(publicApp).get("/internal/__test/context")).status).toBe(404);
        expect((await request(internalApp).get("/api/__test/context")).status).toBe(404);
        expect((await request(internalApp).get("/internal/__test/context")).status).toBe(200);
    });

    it("should echo a valid incoming X-Request-Id and replace an invalid one (F3)", async () => {
        const { publicApp } = apps();
        const valid = "9f1c2b3a-4d5e-4f60-8a7b-6c5d4e3f2a1b";

        const echoed = await request(publicApp).get("/api/nope").set("X-Request-Id", valid);
        expect(echoed.headers["x-request-id"]).toBe(valid);
        expect(echoed.body.error.requestId).toBe(valid);

        const upper = await request(publicApp).get("/api/nope").set("X-Request-Id", valid.toUpperCase());
        expect(upper.headers["x-request-id"]).toBe(valid);

        const invalid = await request(publicApp).get("/api/nope").set("X-Request-Id", "<script>alert(1)</script>");
        expect(invalid.headers["x-request-id"]).toMatch(UUID);
        expect(invalid.body.error.requestId).toBe(invalid.headers["x-request-id"]);
    });

    it("should carry X-Request-Id on success responses", async () => {
        const { publicApp } = apps();
        const res = await request(publicApp)
            .post("/api/__test/echo")
            .send({ name: "synthetic", count: 2, item: { label: "x" } });
        expect(res.status).toBe(201);
        expect(res.headers["x-request-id"]).toMatch(UUID);
        expect(expectSuccessEnvelope(res.body)).toEqual({ name: "synthetic", count: 2, label: "x" });
        expect(Object.keys(res.body)).not.toContain("meta");
    });

    it("should return 400 ValidationFailed when the JSON body is malformed (F5)", async () => {
        const { publicApp, internalApp } = apps();
        for (const [app, path] of [
            [publicApp, "/api/__test/echo"],
            [internalApp, "/internal/__test/echo"],
        ] as const) {
            const res = await request(app).post(path).set("Content-Type", "application/json").send('{"name": "x",');
            expect(res.status).toBe(400);
            expectErrorEnvelope(res.body, "ValidationFailed", res.headers["x-request-id"]);
            expect(res.body.error.details).toEqual([{ field: "body", issue: "must be valid JSON" }]);
        }
    });

    it("should return 400 ValidationFailed when a non-object JSON primitive is sent in strict mode (F5)", async () => {
        const { publicApp } = apps();
        const res = await request(publicApp).post("/api/__test/echo").set("Content-Type", "application/json").send('"x"');
        expect(res.status).toBe(400);
        expectErrorEnvelope(res.body, "ValidationFailed");
    });

    it("should return 400 ValidationFailed when the body exceeds 100kb (F5)", async () => {
        const { publicApp } = apps();
        const res = await request(publicApp)
            .post("/api/__test/echo")
            .set("Content-Type", "application/json")
            .send(JSON.stringify({ name: "x".repeat(101 * 1024) }));
        expect(res.status).toBe(400);
        expectErrorEnvelope(res.body, "ValidationFailed");
        expect(res.body.error.details).toEqual([{ field: "body", issue: "must not exceed 100kb" }]);
    });

    it("should return 500 InternalError without internals when a test route throws (F4)", async () => {
        const { publicApp, internalApp } = apps();
        for (const [app, path] of [
            [publicApp, "/api/__test/boom"],
            [internalApp, "/internal/__test/boom"],
        ] as const) {
            const res = await request(app).get(path);
            expect(res.status).toBe(500);
            expectErrorEnvelope(res.body, "InternalError", res.headers["x-request-id"]);
            expect(res.body.error.message).toBe("An unexpected error occurred");
            expect(res.body.error.details).toEqual([]);
            expect(res.text).not.toMatch(/SELECT|password_hash|secret_table|stack|at .*\.ts/);
        }
    });

    it("should validate a DTO and reject unknown properties on a test route (F6)", async () => {
        const { publicApp } = apps();
        const res = await request(publicApp)
            .post("/api/__test/echo")
            .send({ name: "synthetic", count: 2, item: { label: "x" }, role: "admin" });
        expect(res.status).toBe(400);
        expectErrorEnvelope(res.body, "ValidationFailed");
        expect(res.body.error.details).toEqual([{ field: "role", issue: "is not allowed" }]);
    });

    it("should report field paths without echoing rejected values when a DTO fails (F6)", async () => {
        const { publicApp } = apps();
        const res = await request(publicApp)
            .post("/api/__test/echo")
            .send({ name: 42, count: 987654321, item: { label: "SYNTHETIC-COMPLAINT-7731".repeat(4) } });
        expect(res.status).toBe(400);
        expect(res.body.error.details.map((detail: { field: string }) => detail.field)).toEqual([
            "count",
            "item.label",
            "name",
        ]);
        expect(res.text).not.toContain("SYNTHETIC-COMPLAINT-7731");
        expect(res.text).not.toContain("987654321");
    });

    it("should return 400 when the body is not a JSON object (array) (F6)", async () => {
        const { publicApp } = apps();
        const res = await request(publicApp).post("/api/__test/echo").send([{ name: "x" }]);
        expect(res.status).toBe(400);
        expect(res.body.error.details).toEqual([{ field: "body", issue: "must be a JSON object" }]);
    });

    it("should set helmet headers and never X-Powered-By on both listeners", async () => {
        const { publicApp, internalApp } = apps();
        for (const [app, path] of [
            [publicApp, "/api/health/live"],
            [publicApp, "/api/nope"],
            [internalApp, "/internal/health/live"],
        ] as const) {
            const res = await request(app).get(path);
            expect(res.headers["x-powered-by"]).toBeUndefined();
            expect(res.headers["x-content-type-options"]).toBe("nosniff");
            expect(res.headers["content-security-policy"]).toBeDefined();
            expect(res.headers["strict-transport-security"]).toBeDefined();
        }
    });
});
