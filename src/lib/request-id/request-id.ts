import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { logger } from "../logger/logger";
import { requestContext } from "../logger/request-context";

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mounted FIRST on both listeners: adopts a valid incoming `X-Request-Id` (any UUID version, lower-cased)
 * or generates one, sets the response header before `next()` so errors, 404s, and health responses all carry
 * it, and opens the AsyncLocalStorage context for the rest of the request.
 */
export function requestId(): RequestHandler {
    return (req, res, next) => {
        const incoming = req.get("X-Request-Id");
        const id = incoming !== undefined && UUID_PATTERN.test(incoming) ? incoming.toLowerCase() : randomUUID();

        req.requestId = id;
        req.log = logger.child({ requestId: id });
        res.setHeader("X-Request-Id", id);

        requestContext.run({ requestId: id }, () => {
            next();
        });
    };
}
