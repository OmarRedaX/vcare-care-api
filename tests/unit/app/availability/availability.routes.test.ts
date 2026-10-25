// Rules covered: AV-R2 (authorize on every route), AV-R26 (limiter pair per route, IP before the guard, user after authorize).
import type { RequestHandler, Router } from "express";
import { buildAvailabilityRouter } from "../../../../src/app/availability/routes";
import { assertRoutesAuthorized } from "../../../../src/lib/rbac/assert-routes-authorized";
import { isAuthorizeHandler, isGuardHandler, isPreAuthHandler } from "../../../../src/lib/rbac/markers";

interface Layer { route?: { path: string; stack: Array<{ method?: string; handle: RequestHandler }> } }

function chain(router: Router, method: string, path: string): RequestHandler[] {
    const layer = (router as unknown as { stack: Layer[] }).stack.find((item) => item.route?.path === path && item.route.stack.some((entry) => entry.method === method));
    if (layer?.route === undefined) throw new Error(`${method} ${path} missing`);
    return layer.route.stack.map((entry) => entry.handle);
}
const kind = (handler: RequestHandler): string => isPreAuthHandler(handler) ? "preauth" : isGuardHandler(handler) ? "guard" : isAuthorizeHandler(handler) ? "authorize" : "other";

describe("buildAvailabilityRouter", () => {
    const router = buildAvailabilityRouter();

    it.each(["/doctors", "/doctors/:doctorUserId", "/doctors/:doctorUserId/slots"])("should compose GET %s as IP limiter, guard, authorize, user limiter, handler", (path) => {
        expect(chain(router, "get", path).map(kind)).toEqual(["preauth", "guard", "authorize", "preauth", "other"]);
    });

    it("should expose only GET routes, with no idempotency", () => {
        const routes = (router as unknown as { stack: Layer[] }).stack.filter((item) => item.route !== undefined);
        expect(routes).toHaveLength(3);
        for (const layer of routes) expect(layer.route?.stack.every((entry) => entry.method === "get")).toBe(true);
    });

    it("should pass assertRoutesAuthorized and register no router.param", () => {
        expect(() => assertRoutesAuthorized(router)).not.toThrow();
        expect(Object.keys((router as unknown as { params?: object }).params ?? {})).toEqual([]);
    });
});
