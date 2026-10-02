import type { ErrorRequestHandler, Request, Response, Router } from "express";
import type { MatchedRequest, RouteLocals } from "./types";

/** `req.baseUrl + req.route.path` as seen right now, or `undefined` outside a matched route. */
function livePattern(req: Request): string | undefined {
    const path = (req as MatchedRequest).route?.path;
    return typeof path === "string" ? `${req.baseUrl}${path}` : undefined;
}

/**
 * Records the matched route pattern on `res.locals` while `req.baseUrl` still carries the full mount prefix (fix #6).
 * The first capture wins. Called by `userGuard`, `authorize`, `rateLimit`, `idempotency`, and every sealed router's
 * error layer — once a nested router's handler throws, Express restores `req.baseUrl` before `request_completed` is
 * logged, so a later read would lose the prefix.
 */
export function captureRoute(req: Request, res: Response): void {
    const locals = res.locals as RouteLocals;
    if (locals.routePattern !== undefined) {
        return;
    }
    const pattern = livePattern(req);
    if (pattern !== undefined) {
        locals.routePattern = pattern;
    }
}

/**
 * Appends an error layer that captures the route pattern and passes the error on unchanged. Every module `routes.ts`
 * and the health router return `sealRouter(router)` (access spec §12.2).
 */
export function sealRouter(router: Router): Router {
    const capture: ErrorRequestHandler = (err: unknown, req, res, next) => {
        captureRoute(req, res);
        next(err);
    };
    router.use(capture);
    return router;
}

/**
 * The matched route pattern (`req.baseUrl + req.route.path`, e.g. `/api/consultations/:id`), or `undefined`
 * when no route matched. The captured pattern wins over the live one. Log lines and metric labels use this — never the
 * concrete URL, which carries ids.
 */
export function routePattern(req: Request): string | undefined {
    const captured = (req.res?.locals as RouteLocals | undefined)?.routePattern;
    return captured ?? livePattern(req);
}

/** `METHOD pattern` for middleware log lines (`POST /api/consultations`); `METHOD unmatched` outside a route. */
export function routeLabel(req: Request): string {
    return `${req.method} ${routePattern(req) ?? "unmatched"}`;
}
