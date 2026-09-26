import type { Request } from "express";
import { routeLabel, routePattern } from "../../../../src/lib/http/route-pattern";

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
