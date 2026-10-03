import type { ErrorRequestHandler, Request, Response } from "express";
import { captureRoute, routeLabel, routePattern, sealRouter } from "../../../../src/lib/http/route-pattern";

function req(overrides: { method?: string; baseUrl?: string; path?: string; routePath?: unknown }): Request {
    return {
        method: overrides.method ?? "GET",
        baseUrl: overrides.baseUrl ?? "",
        path: overrides.path ?? "/",
        ...(overrides.routePath !== undefined ? { route: { path: overrides.routePath } } : {}),
    } as unknown as Request;
}

describe("lib/http/route-pattern", () => {
    it("should join the mount path and the matched pattern when a route matched", () => {
        expect(routePattern(req({ baseUrl: "/api/consultations", routePath: "/:id" }))).toBe("/api/consultations/:id");
    });

    it("should return undefined when no route matched", () => {
        expect(routePattern(req({ baseUrl: "/api", path: "/patients/42/records" }))).toBeUndefined();
    });

    it("should return undefined when the route path is not a string", () => {
        expect(routePattern(req({ routePath: /regex/ }))).toBeUndefined();
    });

    it("should prefix the method when building a label for a matched route", () => {
        expect(routeLabel(req({ method: "POST", baseUrl: "/api", routePath: "/consultations" }))).toBe(
            "POST /api/consultations",
        );
    });

    it("should never include the concrete path when building a label outside a route", () => {
        const label = routeLabel(req({ method: "POST", baseUrl: "/api", path: "/patients/42/records" }));
        expect(label).toBe("POST unmatched");
        expect(label).not.toContain("42");
    });
});

/** Foundation issue #6: the route label lost its mount prefix when a nested router's handler threw. */
describe("regression #6: lib/http/route-pattern capture", () => {
    function live(baseUrl: string, routePath: string) {
        const locals: Record<string, unknown> = {};
        const res = { locals } as unknown as Response;
        const request = { method: "GET", baseUrl, path: "/", route: { path: routePath }, res } as unknown as Request;
        return { request, res, locals };
    }

    it("should keep the first captured pattern", () => {
        const { request, res, locals } = live("/api/__test/nested/inner", "/boom/:id");
        captureRoute(request, res);
        (request as unknown as { baseUrl: string }).baseUrl = "/api";
        captureRoute(request, res);
        expect(locals.routePattern).toBe("/api/__test/nested/inner/boom/:id");
    });

    it("should prefer the captured pattern over the live baseUrl", () => {
        const { request, res } = live("/api/__test/nested/inner", "/boom/:id");
        captureRoute(request, res);
        // Express restores req.baseUrl when the error leaves the nested router.
        (request as unknown as { baseUrl: string }).baseUrl = "";
        expect(routePattern(request)).toBe("/api/__test/nested/inner/boom/:id");
        expect(routeLabel(request)).toBe("GET /api/__test/nested/inner/boom/:id");
    });

    it("should capture nothing outside a matched route", () => {
        const locals: Record<string, unknown> = {};
        const res = { locals } as unknown as Response;
        captureRoute({ method: "GET", baseUrl: "/api", path: "/x", res } as unknown as Request, res);
        expect(locals).toEqual({});
    });

    it("should label a throwing nested route with its full prefix through sealRouter", async () => {
        const express = (await import("express")).default;
        const supertest = (await import("supertest")).default;
        let label: string | undefined;
        const inner = express.Router();
        inner.get("/boom/:id", () => {
            throw new Error("synthetic nested failure");
        });
        const outer = express.Router();
        outer.use("/__test/nested/inner", sealRouter(inner));
        const app = express();
        app.use("/api", sealRouter(outer));
        app.use(((_err, req, res, _next) => {
            label = routeLabel(req);
            res.status(500).end();
        }) as ErrorRequestHandler);
        await supertest(app).get("/api/__test/nested/inner/boom/42");
        expect(label).toBe("GET /api/__test/nested/inner/boom/:id");
    });
});
