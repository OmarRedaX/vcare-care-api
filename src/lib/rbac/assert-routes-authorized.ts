import type { Router } from "express";
import { isAuthorizeHandler, isGuardHandler, isProbeExempt } from "./markers";
import type { RouteLayer } from "./types";

function stackOf(value: unknown): readonly RouteLayer[] | undefined {
    if (typeof value !== "function" && (typeof value !== "object" || value === null)) {
        return undefined;
    }
    const stack = (value as { stack?: unknown }).stack;
    return Array.isArray(stack) ? (stack as readonly RouteLayer[]) : undefined;
}

function methodsOf(layer: RouteLayer): string {
    const methods = layer.route?.methods ?? {};
    const names = Object.keys(methods)
        .filter((method) => methods[method] === true)
        .map((method) => method.toUpperCase());
    return names.length > 0 ? names.join(",") : "ALL";
}

function walk(value: unknown, basePath: string): void {
    const stack = stackOf(value);
    if (stack === undefined) {
        return;
    }

    for (const layer of stack) {
        if (layer.route !== undefined) {
            const handlers = (layer.route.stack ?? []).map((entry) => entry.handle);
            const path = typeof layer.route.path === "string" ? layer.route.path : "";
            const label = `${methodsOf(layer)} ${basePath}${path}`;
            const authorizeAt = handlers.findIndex(isAuthorizeHandler);
            if (authorizeAt === -1) {
                throw new Error(`route_without_policy: ${label}`);
            }
            if (!handlers.slice(0, authorizeAt).some(isGuardHandler)) {
                // A policy without a principal can only ever answer 401.
                throw new Error(`route_without_guard: ${label}`);
            }
            continue;
        }

        if (isProbeExempt(layer.handle)) {
            continue;
        }
        walk(layer.handle, basePath);
    }
}

/**
 * Boot-time fail-closed check (access spec §3.4.4): every route reachable from `router` must have an `authorize(...)`
 * handler, preceded by a guard. Health routers are skipped by `PROBE_EXEMPT_MARKER`. `createPublicApp` /
 * `createInternalApp` call it on `app.router` before mounting test-only `extraRouters`; a violation throws in EVERY
 * environment, so the process cannot start with an unguarded route. Mount prefixes are not recoverable from Express 5
 * layers, so the reported path is the route's own path (prefixed by `basePath`).
 */
export function assertRoutesAuthorized(router: Router, basePath = ""): void {
    walk(router, basePath);
}
