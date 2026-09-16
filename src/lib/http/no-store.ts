import type { RequestHandler } from "express";

/** `Cache-Control: no-store` — required on every clinical and consultation response. */
export function noStore(): RequestHandler {
    return (_req, res, next) => {
        res.setHeader("Cache-Control", "no-store");
        next();
    };
}
