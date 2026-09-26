import type { RequestHandler } from "express";
import { routePattern } from "../http/route-pattern";
import { logger } from "./logger";

/**
 * One `request_completed` line per request. NEVER logs the URL, query string, headers, or body —
 * only the matched route pattern, method, status, error code, and duration.
 */
export function requestLogger(): RequestHandler {
    return (req, res, next) => {
        const startedAt = performance.now();
        let settled = false;

        res.on("finish", () => {
            if (settled) {
                return;
            }
            settled = true;
            const route = routePattern(req) ?? "unmatched";
            const status = res.statusCode;
            const code = (res.locals as { errorCode?: string }).errorCode;
            const fields = {
                requestId: req.requestId,
                ...(req.auth ? { userId: req.auth.userId, role: req.auth.role } : {}),
                method: req.method,
                route,
                status,
                ...(code !== undefined ? { code } : {}),
                durationMs: Number((performance.now() - startedAt).toFixed(1)),
            };
            const log = req.log ?? logger;
            if (status >= 500) {
                log.error("request_completed", fields);
            } else if (route.includes("/health/")) {
                log.debug("request_completed", fields);
            } else {
                log.info("request_completed", fields);
            }
        });

        res.on("close", () => {
            if (settled) {
                return;
            }
            settled = true;
            (req.log ?? logger).warn("request_aborted", {
                requestId: req.requestId,
                method: req.method,
                route: routePattern(req) ?? "unmatched",
                durationMs: Number((performance.now() - startedAt).toFixed(1)),
            });
        });

        next();
    };
}
