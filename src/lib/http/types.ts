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

export interface CorsOptions {
    origins: readonly string[];
}
