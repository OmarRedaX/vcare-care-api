import express from "express";
import request from "supertest";
import { cors } from "../../../../src/lib/http/cors";

const ALLOWED = "http://localhost:5173";

function harness() {
    const app = express();
    app.use(cors({ origins: [ALLOWED] }));
    app.all("/t", (_req, res) => {
        res.status(200).json({ reached: true });
    });
    return app;
}

const CORS_HEADERS = [
    "access-control-allow-origin",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "access-control-expose-headers",
    "access-control-max-age",
    "access-control-allow-credentials",
];

describe("lib/http/cors", () => {
    it("should set allow-origin and Vary when the origin is allowlisted (F22)", async () => {
        const res = await request(harness()).get("/t").set("Origin", ALLOWED);
        expect(res.status).toBe(200);
        expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
        expect(res.headers.vary).toContain("Origin");
        expect(res.headers["access-control-expose-headers"]).toBe("X-Request-Id, Retry-After");
        expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
        expect(res.body).toEqual({ reached: true });
    });

    it.each(["http://evil.example.test", "http://localhost:5174", "null"])(
        "should set no CORS headers when the origin %p is not allowlisted (F22)",
        async (origin) => {
            const res = await request(harness()).get("/t").set("Origin", origin);
            expect(res.status).toBe(200);
            for (const header of CORS_HEADERS) {
                expect(res.headers[header]).toBeUndefined();
            }
        },
    );

    it("should set no CORS headers when the Origin header is absent", async () => {
        const res = await request(harness()).get("/t");
        for (const header of CORS_HEADERS) {
            expect(res.headers[header]).toBeUndefined();
        }
    });

    it("should answer 204 with allow headers when a preflight comes from an allowed origin", async () => {
        const res = await request(harness())
            .options("/t")
            .set("Origin", ALLOWED)
            .set("Access-Control-Request-Method", "POST");

        expect(res.status).toBe(204);
        expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
        expect(res.headers["access-control-allow-methods"]).toBe("GET, POST, PATCH, DELETE");
        expect(res.headers["access-control-allow-headers"]).toBe(
            "Authorization, Content-Type, Idempotency-Key, X-Request-Id",
        );
        expect(res.headers["access-control-max-age"]).toBe("600");
        expect(res.text).toBe("");
    });

    it("should pass a preflight through without CORS headers when the origin is not allowed", async () => {
        const res = await request(harness())
            .options("/t")
            .set("Origin", "http://evil.example.test")
            .set("Access-Control-Request-Method", "POST");
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
        expect(res.headers["access-control-allow-methods"]).toBeUndefined();
        expect(res.body).toEqual({ reached: true });
    });

    it("should pass a plain OPTIONS without Access-Control-Request-Method to the route", async () => {
        const res = await request(harness()).options("/t").set("Origin", ALLOWED);
        expect(res.status).toBe(200);
        expect(res.headers["access-control-allow-methods"]).toBeUndefined();
        expect(res.body).toEqual({ reached: true });
    });
});
