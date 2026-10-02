import type { Request } from "express";
import type { MatchedRequest } from "./types";

/**
 * The matched route pattern (`req.baseUrl + req.route.path`, e.g. `/api/consultations/:id`), or `undefined`
 * when no route matched. Log lines and metric labels use this — never the concrete URL, which carries ids.
 */
export function routePattern(req: Request): string | undefined {
    const path = (req as MatchedRequest).route?.path;
    return typeof path === "string" ? `${req.baseUrl}${path}` : undefined;
}

/** `METHOD pattern` for middleware log lines (`POST /api/consultations`); `METHOD unmatched` outside a route. */
export function routeLabel(req: Request): string {
    return `${req.method} ${routePattern(req) ?? "unmatched"}`;
}
