import type { RequestHandler, Router } from "express";
import { buildHelpArticlesRouter } from "../../../../src/app/help-articles/routes";
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

describe("buildHelpArticlesRouter", () => {
    const router = buildHelpArticlesRouter();

    // rateLimit() is a pre-auth-marked handler; it runs after authorize here, so only admins/readers reach it.
    it.each([
        ["get", "/help-articles", ["guard", "authorize", "preauth", "other"]],
        ["get", "/help-articles/:id", ["guard", "authorize", "preauth", "other"]],
        ["post", "/help-articles", ["guard", "authorize", "preauth", "other", "other"]],
        ["patch", "/help-articles/:id", ["guard", "authorize", "preauth", "other"]],
        ["delete", "/help-articles/:id", ["guard", "authorize", "preauth", "other"]],
    ])("should compose %s %s as guard, authorize, rate limit, [idempotency,] handler", (method, path, expected) => {
        expect(chain(router, method, path).map(kind)).toEqual(expected);
    });

    it("should have no per-IP limiter before the guard on any route (HA-D2)", () => {
        for (const [method, path] of [["get", "/help-articles"], ["get", "/help-articles/:id"], ["post", "/help-articles"], ["patch", "/help-articles/:id"], ["delete", "/help-articles/:id"]] as const) {
            expect(kind(chain(router, method, path)[0] as RequestHandler)).toBe("guard");
        }
    });

    it("should pass assertRoutesAuthorized (every route is guard then authorize)", () => {
        expect(() => assertRoutesAuthorized(router)).not.toThrow();
    });

    it("should register exactly the five documented routes and no router.param", () => {
        const layers = (router as unknown as { stack: Layer[] }).stack;
        const routes = layers.flatMap((l) => (l.route === undefined ? [] : l.route.stack.map((s) => `${s.method} ${l.route?.path}`)));
        expect([...new Set(routes)].sort()).toEqual([
            "delete /help-articles/:id",
            "get /help-articles",
            "get /help-articles/:id",
            "patch /help-articles/:id",
            "post /help-articles",
        ]);
        expect(Object.keys((router as unknown as { params?: object }).params ?? {})).toEqual([]);
    });
});
