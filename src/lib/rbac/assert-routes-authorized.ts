import type { Router } from "express";
import { isAuthorizeHandler, isGuardHandler, isPreAuthHandler, isProbeExempt } from "./markers";
import type { RouteChain, RouteLayer } from "./types";

const ERROR_HANDLER_ARITY = 4;

function stackOf(value: unknown): readonly RouteLayer[] | undefined {
    if (typeof value !== "function" && (typeof value !== "object" || value === null)) {
        return undefined;
    }
    const stack = (value as { stack?: unknown }).stack;
    return Array.isArray(stack) ? (stack as readonly RouteLayer[]) : undefined;
}

/** A router's own stack, or — for an Express 5 sub-app mounted with `router.use(path, app)` — its `app.router` stack. */
function childStackOf(value: unknown): readonly RouteLayer[] | undefined {
    const own = stackOf(value);
    if (own !== undefined || typeof value !== "function") {
        return own;
    }
    return stackOf((value as { router?: unknown }).router);
}

/** An error handler (`(err, req, res, next)`) only runs after something failed; it can never serve a request first. */
function isErrorHandler(value: unknown): boolean {
    return typeof value === "function" && value.length === ERROR_HANDLER_ARITY;
}

/**
 * One chain per method, exactly as Express dispatches the route: entries registered for that verb plus the `.all`
 * entries (`method === undefined`), in registration order. A route with `.all` entries also gets an `ALL` chain — the
 * one every other verb dispatches.
 */
function chainsOf(layer: RouteLayer, basePath: string): RouteChain[] {
    const stack = layer.route?.stack ?? [];
    const path = typeof layer.route?.path === "string" ? layer.route.path : "";
    const verbs = [...new Set(stack.map((entry) => entry.method).filter((method) => method !== undefined))];
    const chains = verbs.map((verb) => ({
        label: `${verb.toUpperCase()} ${basePath}${path}`,
        handlers: stack.filter((entry) => entry.method === undefined || entry.method === verb).map((entry) => entry.handle),
    }));
    if (stack.some((entry) => entry.method === undefined) || chains.length === 0) {
        chains.push({
            label: `ALL ${basePath}${path}`,
            handlers: stack.filter((entry) => entry.method === undefined).map((entry) => entry.handle),
        });
    }
    return chains;
}

function assertChain(chain: RouteChain): void {
    const authorizeAt = chain.handlers.findIndex(isAuthorizeHandler);
    if (authorizeAt === -1) {
        throw new Error(`route_without_policy: ${chain.label}`);
    }
    const before = chain.handlers.slice(0, authorizeAt);
    if (!before.some(isGuardHandler)) {
        // A policy without a principal can only ever answer 401.
        throw new Error(`route_without_guard: ${chain.label}`);
    }
    if (!before.every((handler) => isGuardHandler(handler) || isPreAuthHandler(handler) || isErrorHandler(handler))) {
        // A handler that runs before authorize answers any authenticated caller, whatever the policy says.
        throw new Error(`handler_before_authorize: ${chain.label}`);
    }
}

function walk(value: unknown, basePath: string): void {
    const stack = childStackOf(value);
    if (stack === undefined) {
        return;
    }

    for (const layer of stack) {
        if (layer.route !== undefined) {
            for (const chain of chainsOf(layer, basePath)) {
                assertChain(chain);
            }
            continue;
        }

        const handle = layer.handle;
        if (isProbeExempt(handle)) {
            continue;
        }
        if (childStackOf(handle) !== undefined) {
            walk(handle, basePath);
            continue;
        }
        if (isPreAuthHandler(handle) || isErrorHandler(handle)) {
            continue;
        }
        // `router.use(path, fn)`: a terminal handler (or an Express wrapper we cannot see into, e.g. `mounted_app`)
        // that answers every method under its path without a guard or a policy.
        throw new Error(`middleware_without_policy: ${layer.name ?? "<anonymous>"} under ${basePath === "" ? "/" : basePath}`);
    }
}

/**
 * Boot-time fail-closed check (access spec §3.4.4): deny by default for every layer reachable from `router`.
 *  - Every route method chain (per verb, `.all` entries included) has `authorize(...)`, preceded by a guard, and only
 *    guard, pre-auth, or error handlers before it (`route_without_policy` / `route_without_guard` /
 *    `handler_before_authorize`).
 *  - Every non-route layer is a router (walked), a mounted Express sub-app (its `app.router` is walked), a probe-exempt
 *    router (health, skipped), an error handler, or middleware marked `markPreAuth` — anything else throws
 *    `middleware_without_policy`, so `router.use(path, handler)` cannot serve a request unpoliced.
 * `createPublicApp` / `createInternalApp` call it on `app.router` before mounting test-only `extraRouters`; a violation
 * throws in EVERY environment, so the process cannot start with an unguarded route. Mount prefixes are not recoverable
 * from Express 5 layers, so the reported path is the route's own path (prefixed by `basePath`).
 */
export function assertRoutesAuthorized(router: Router, basePath = ""): void {
    walk(router, basePath);
}
