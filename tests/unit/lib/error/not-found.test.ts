import type { Request, Response } from "express";
import request from "supertest";
import { createPublicApp } from "../../../../src/app";
import { createInternalApp } from "../../../../src/internal-app";
import { getEnv } from "../../../../src/lib/config/env";
import { NotFound } from "../../../../src/lib/error/errors";
import { notFound, optionsNotFound } from "../../../../src/lib/error/not-found";

describe("lib/error/notFound", () => {
    it("should forward NotFound when no route matched", () => {
        const next = jest.fn();
        void notFound({} as Request, {} as Response, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(next).toHaveBeenCalledWith(NotFound);
    });
});

describe("lib/error/optionsNotFound", () => {
    it("should forward NotFound when the method is OPTIONS", () => {
        const next = jest.fn();
        void optionsNotFound({ method: "OPTIONS" } as Request, {} as Response, next);
        expect(next).toHaveBeenCalledWith(NotFound);
    });

    it.each(["GET", "HEAD", "POST", "PATCH", "DELETE"])("should call next without an error when the method is %s", (method) => {
        const next = jest.fn();
        void optionsNotFound({ method } as Request, {} as Response, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(next).toHaveBeenCalledWith(undefined);
    });
});

/**
 * The real apps: an OPTIONS request is answered before any router, so no Postgres or Redis is touched.
 * (Regression for bug 4 / QA case 23: Express 5 used to answer 200 text/plain "GET, HEAD" itself.)
 */
describe("OPTIONS on a known path (both listeners)", () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it.each([
        ["public", "/api/health/live"],
        ["public", "/api/health/ready"],
        ["internal", "/internal/health/live"],
        ["internal", "/internal/health/ready"],
    ] as const)("should return the 404 NotFound envelope when OPTIONS hits %s %s", async (listener, path) => {
        const app = listener === "public" ? createPublicApp() : createInternalApp();
        const res = await request(app).options(path);

        expect(res.status).toBe(404);
        expect(res.headers["content-type"]).toMatch(/^application\/json/);
        expect(res.headers.allow).toBeUndefined();
        expect(res.body).toEqual({
            success: false,
            error: { code: "NotFound", message: "Resource not found", details: [], requestId: res.headers["x-request-id"] },
        });
    });

    it("should still answer an allowed dev preflight with 204 when CORS is enabled", async () => {
        const origin = getEnv().CORS_ORIGINS[0];
        expect(origin).toBeDefined();
        jest.replaceProperty(getEnv(), "NODE_ENV", "development");
        const res = await request(createPublicApp())
            .options("/api/health/live")
            .set("Origin", origin ?? "")
            .set("Access-Control-Request-Method", "GET");
        expect(res.status).toBe(204);
        expect(res.headers["access-control-allow-origin"]).toBe(origin);
    });
});
