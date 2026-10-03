import type { RequestHandler } from "express";
import { markPreAuth } from "../rbac/markers";

/** `Cache-Control: no-store` — required on every clinical and consultation response. */
export function noStore(): RequestHandler {
    return markPreAuth((_req, res, next) => {
        res.setHeader("Cache-Control", "no-store");
        next();
    });
}
