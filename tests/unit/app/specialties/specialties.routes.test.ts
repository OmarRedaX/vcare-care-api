import type { RequestHandler, Router } from "express";
import { buildSpecialtiesRouter } from "../../../../src/app/specialties/routes";
import { assertRoutesAuthorized } from "../../../../src/lib/rbac/assert-routes-authorized";
import { isAuthorizeHandler, isGuardHandler, isPreAuthHandler } from "../../../../src/lib/rbac/markers";

interface Layer {
    route?: { path: string; stack: Array<{ method?: string; handle: RequestHandler }> };
}

function chain(router: Router, method: string, path: string): RequestHandler[] {
    const layer = (router as unknown as { stack: Layer[] }).stack.find(
        (l) => l.route?.path === path && l.route.stack.some((s) => s.method === method),
    );
    if (layer?.route === undefined) throw new Error(`route ${method} ${path} missing`);
    return layer.route.stack.map((s) => s.handle);
}

const kind = (h: RequestHandler): string =>
    isPreAuthHandler(h) ? "preauth" : isGuardHandler(h) ? "guard" : isAuthorizeHandler(h) ? "authorize" : "other";

describe("buildSpecialtiesRouter", () => {
    const router = buildSpecialtiesRouter();

    it("should compose GET as pre-auth rateLimit, guard, authorize, rateLimit, handler", () => {
        expect(chain(router, "get", "/specialties").map(kind)).toEqual(["preauth", "guard", "authorize", "preauth", "other"]);
    });

    it("should compose POST as guard, authorize, idempotency, handler", () => {
        expect(chain(router, "post", "/specialties").map(kind)).toEqual(["guard", "authorize", "other", "other"]);
    });

    it("should compose PATCH as guard, authorize, handler with no idempotency or limiter", () => {
        expect(chain(router, "patch", "/specialties/:id").map(kind)).toEqual(["guard", "authorize", "other"]);
    });

    it("should pass assertRoutesAuthorized", () => {
        expect(() => assertRoutesAuthorized(router)).not.toThrow();
    });

    it("should expose no DELETE route and register no router.param", () => {
        const layers = (router as unknown as { stack: Layer[] }).stack;
        expect(layers.some((l) => l.route?.stack.some((s) => s.method === "delete"))).toBe(false);
        expect(Object.keys((router as unknown as { params?: object }).params ?? {})).toEqual([]);
    });
});
