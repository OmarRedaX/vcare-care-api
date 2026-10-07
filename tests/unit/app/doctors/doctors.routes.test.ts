import type { RequestHandler, Router } from "express";
import { buildDoctorsRouter } from "../../../../src/app/doctors/routes";
import { assertRoutesAuthorized } from "../../../../src/lib/rbac/assert-routes-authorized";
import { isAuthorizeHandler, isGuardHandler, isPreAuthHandler } from "../../../../src/lib/rbac/markers";

interface Layer { route?: { path: string; stack: Array<{ method?: string; handle: RequestHandler }> } }
const chain = (router: Router, method: string, path: string): RequestHandler[] => {
    const layer = (router as unknown as { stack: Layer[] }).stack.find((item) => item.route?.path === path && item.route.stack.some((entry) => entry.method === method));
    if (layer?.route === undefined) throw new Error(`${method} ${path} missing`);
    return layer.route.stack.map((entry) => entry.handle);
};
const kind = (handler: RequestHandler): string => isGuardHandler(handler) ? "guard" : isAuthorizeHandler(handler) ? "authorize" : isPreAuthHandler(handler) ? "limiter" : "other";

describe("buildDoctorsRouter", () => {
    const router = buildDoctorsRouter();
    it("should compose apply as guard, authorize, limiter, idempotency and handler", () => {
        expect(chain(router, "post", "/doctors/apply").map(kind)).toEqual(["guard", "authorize", "limiter", "other", "other"]);
    });
    it("should compose PATCH as guard, authorize, limiter and handler", () => {
        expect(chain(router, "patch", "/doctors/me").map(kind)).toEqual(["guard", "authorize", "limiter", "other"]);
    });
    it.each(["/doctors/me", "/doctors/me/application"])("should compose GET %s as guard, authorize, limiter and handler", (path) => {
        expect(chain(router, "get", path).map(kind)).toEqual(["guard", "authorize", "limiter", "other"]);
    });
    it("should authorize every route and register no router.param", () => {
        expect(() => assertRoutesAuthorized(router)).not.toThrow();
        expect(Object.keys((router as unknown as { params?: object }).params ?? {})).toEqual([]);
    });
});
