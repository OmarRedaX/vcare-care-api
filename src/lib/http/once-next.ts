import type { NextFunction, Request, Response } from "express";
import { logger } from "../logger/logger";
import type { LogFields } from "../logger/types";
import { routeLabel } from "./route-pattern";
import type { OnceNext } from "./types";

/**
 * "Call `next` at most once" for middleware that finishes asynchronously (fix #11; review 2026-10-03, L6) — the one
 * home for it, used by `idempotency` and `rateLimit`:
 *  - `forward(error?)` calls `next` the first time only;
 *  - `fail(error)` is the terminal `.catch`: forwarded exactly once while the request has not moved on, otherwise
 *    logged as `lateErrorMessage { requestId, route, ...fields, error }` — a late error is never forwarded twice and
 *    never rejects unobserved;
 *  - `markResponded()` records that the middleware wrote the response itself, so `next` is never called afterwards.
 */
export function onceNext(
    req: Request,
    res: Response,
    next: NextFunction,
    lateErrorMessage: string,
    fields?: LogFields,
): OnceNext {
    let done = false;

    const forward = (error?: unknown): void => {
        if (done) {
            return;
        }
        done = true;
        next(error);
    };

    return {
        forward,
        fail: (error: unknown): void => {
            if (!done && !res.headersSent) {
                forward(error);
                return;
            }
            logger.error(lateErrorMessage, { requestId: req.requestId, route: routeLabel(req), ...fields, error });
        },
        markResponded: (): void => {
            done = true;
        },
    };
}
