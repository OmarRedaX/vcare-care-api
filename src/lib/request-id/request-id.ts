import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { isUuid } from "../../pkg/utils/uuid";
import { logger } from "../logger/logger";
import { requestContext } from "../logger/request-context";
import { markPreAuth } from "../rbac/markers";

/**
 * Mounted FIRST on both listeners: adopts a valid incoming `X-Request-Id` (any UUID version, lower-cased)
 * or generates one, sets the response header before `next()` so errors, 404s, and health responses all carry
 * it, and opens the AsyncLocalStorage context for the rest of the request.
 */
export function requestId(): RequestHandler {
    return markPreAuth((req, res, next) => {
        const incoming = req.get("X-Request-Id");
        const id = incoming !== undefined && isUuid(incoming) ? incoming.toLowerCase() : randomUUID();

        req.requestId = id;
        req.log = logger.child({ requestId: id });
        res.setHeader("X-Request-Id", id);

        requestContext.run({ requestId: id }, () => {
            next();
        });
    });
}
