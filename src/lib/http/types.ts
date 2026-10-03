import type { Router } from "express";

export interface MountedRouter {
    path: string;
    router: Router;
}

/** Test-only seam: production callers pass nothing to `createPublicApp` / `createInternalApp`. */
export interface AppOptions {
    extraRouters?: MountedRouter[];
}

export interface SendSuccessOptions {
    status?: 200 | 201 | 202;
    meta?: Record<string, unknown>;
}

/** Express types `req.route` as `any`; this is the only part of it Care reads. */
export interface MatchedRequest {
    route?: { path?: unknown };
}

/** The members of `res.locals` written by `lib/http` (fix #6). */
export interface RouteLocals {
    routePattern?: string;
}

export interface CorsOptions {
    origins: readonly string[];
}

/** `onceNext(...)`: `next` runs at most once; late errors are logged with the route (lib/http/once-next.ts). */
export interface OnceNext {
    forward: (error?: unknown) => void;
    fail: (error: unknown) => void;
    markResponded: () => void;
}
