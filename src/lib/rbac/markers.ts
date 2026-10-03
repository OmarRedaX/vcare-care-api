import type { RequestHandler, Router } from "express";

/** Same symbol names as identity-service, so a route walk reads both services' markers alike. */
export const AUTHORIZE_MARKER = Symbol.for("vcare.authorize");
export const GUARD_MARKER = Symbol.for("vcare.guard");
export const PROBE_EXEMPT_MARKER = Symbol.for("vcare.probe-exempt");
export const PRE_AUTH_MARKER = Symbol.for("vcare.pre-auth");

function mark<T extends object>(target: T, marker: symbol): T {
    Object.defineProperty(target, marker, { value: true, enumerable: false });
    return target;
}

function hasMarker(value: unknown, marker: symbol): boolean {
    return typeof value === "function" && (value as unknown as Record<symbol, unknown>)[marker] === true;
}

export function markAuthorize(handler: RequestHandler): RequestHandler {
    return mark(handler, AUTHORIZE_MARKER);
}

/** Authentication handlers (`userGuard`, later `serviceGuard`) — must precede `authorize` on every route. */
export function markGuard(handler: RequestHandler): RequestHandler {
    return mark(handler, GUARD_MARKER);
}

/**
 * Infrastructure probes (health) are the only routes without a guard or a policy (foundation spec §3.1). Marking is
 * explicit, so "no policy" can never be an oversight.
 */
export function markProbeExempt(router: Router): Router {
    return mark(router, PROBE_EXEMPT_MARKER);
}

/**
 * Middleware that may run before authentication: request id, in-flight counting, request logging, security headers,
 * CORS, body parsing, the OPTIONS 404, `noStore()`, and `rateLimit()` (the IP limiter sheds floods before the guard).
 * It never answers a request on a route's behalf except to deny it. The boot assertion throws on every other
 * non-route, non-router layer, and on any non-guard handler placed before `authorize` — marking is the only way in,
 * applied where the middleware is defined (helmet and `express.json` are third-party, so `app.ts` marks them).
 */
export function markPreAuth(handler: RequestHandler): RequestHandler {
    return mark(handler, PRE_AUTH_MARKER);
}

export function isAuthorizeHandler(value: unknown): boolean {
    return hasMarker(value, AUTHORIZE_MARKER);
}

export function isGuardHandler(value: unknown): boolean {
    return hasMarker(value, GUARD_MARKER);
}

export function isProbeExempt(value: unknown): boolean {
    return hasMarker(value, PROBE_EXEMPT_MARKER);
}

export function isPreAuthHandler(value: unknown): boolean {
    return hasMarker(value, PRE_AUTH_MARKER);
}
