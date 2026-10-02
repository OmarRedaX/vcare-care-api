import type { RequestHandler, Router } from "express";

/** Same symbol names as identity-service, so a route walk reads both services' markers alike. */
export const AUTHORIZE_MARKER = Symbol.for("vcare.authorize");
export const GUARD_MARKER = Symbol.for("vcare.guard");
export const PROBE_EXEMPT_MARKER = Symbol.for("vcare.probe-exempt");

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

export function isAuthorizeHandler(value: unknown): boolean {
    return hasMarker(value, AUTHORIZE_MARKER);
}

export function isGuardHandler(value: unknown): boolean {
    return hasMarker(value, GUARD_MARKER);
}

export function isProbeExempt(value: unknown): boolean {
    return hasMarker(value, PROBE_EXEMPT_MARKER);
}
