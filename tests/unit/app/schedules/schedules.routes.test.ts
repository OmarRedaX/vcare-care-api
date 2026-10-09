import type { RequestHandler, Router } from "express";
import { buildSchedulesRouter } from "../../../../src/app/schedules/routes";
import { assertRoutesAuthorized } from "../../../../src/lib/rbac/assert-routes-authorized";
import { isAuthorizeHandler, isGuardHandler, isPreAuthHandler } from "../../../../src/lib/rbac/markers";

interface Layer { route?: { path: string; methods?: Record<string, boolean>; stack: Array<{ method?: string; handle: RequestHandler }> } }
const layers = (router: Router): Layer[] => (router as unknown as { stack: Layer[] }).stack;
const chain = (router: Router, method: string, path: string): RequestHandler[] => {
    const layer = layers(router).find((item) => item.route?.path === path && item.route.stack.some((entry) => entry.method === method));
    if (layer?.route === undefined) throw new Error(`${method} ${path} missing`);
    return layer.route.stack.map((entry) => entry.handle);
};
const kind = (handler: RequestHandler): string => isGuardHandler(handler) ? "guard" : isAuthorizeHandler(handler) ? "authorize" : isPreAuthHandler(handler) ? "limiter" : "other";

describe("buildSchedulesRouter", () => {
    const router = buildSchedulesRouter();

    it.each([["post", "/doctors/me/exceptions"], ["post", "/doctors/me/consultation-types"]])(
        "should compose %s %s as guard, authorize, limiter, idempotency and handler", (method, path) => {
            expect(chain(router, method, path).map(kind)).toEqual(["guard", "authorize", "limiter", "other", "other"]);
        });

    it.each([
        ["put", "/doctors/me/working-hours"], ["delete", "/doctors/me/exceptions/:id"], ["patch", "/doctors/me/consultation-types/:id"],
    ])("should compose the write %s %s as guard, authorize, limiter and handler", (method, path) => {
        expect(chain(router, method, path).map(kind)).toEqual(["guard", "authorize", "limiter", "other"]);
    });

    it.each([["/doctors/me/working-hours"], ["/doctors/me/exceptions"], ["/doctors/me/consultation-types"]])(
        "should compose GET %s as guard, authorize, limiter and handler", (path) => {
            expect(chain(router, "get", path).map(kind)).toEqual(["guard", "authorize", "limiter", "other"]);
        });

    it("should register exactly the eight routes", () => {
        const registered = layers(router).filter((layer) => layer.route !== undefined)
            .flatMap((layer) => layer.route!.stack.map((entry) => `${entry.method ?? ""} ${layer.route!.path}`));
        expect([...new Set(registered)].sort()).toEqual([
            "delete /doctors/me/exceptions/:id", "get /doctors/me/consultation-types", "get /doctors/me/exceptions", "get /doctors/me/working-hours",
            "patch /doctors/me/consultation-types/:id", "post /doctors/me/consultation-types", "post /doctors/me/exceptions", "put /doctors/me/working-hours",
        ]);
    });

    it("should pass assertRoutesAuthorized and register no router.param", () => {
        expect(() => assertRoutesAuthorized(router)).not.toThrow();
        expect(Object.keys((router as unknown as { params?: object }).params ?? {})).toEqual([]);
    });
});
