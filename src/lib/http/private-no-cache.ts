import type { RequestHandler } from "express";
import { markPreAuth } from "../rbac/markers";

/**
 * `Cache-Control: private, no-cache` — for per-audience, non-clinical content (help articles): shared caches must not reuse it,
 * and a browser must revalidate before reuse so an edit shows up at once. Clinical responses use `noStore()` instead.
 */
export function privateNoCache(): RequestHandler {
    return markPreAuth((_req, res, next) => {
        res.setHeader("Cache-Control", "private, no-cache");
        next();
    });
}
