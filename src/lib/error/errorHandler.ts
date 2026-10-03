import type { NextFunction, Request, Response } from "express";
import { routeLabel } from "../http/route-pattern";
import { logger } from "../logger/logger";
import { AppError } from "./AppError";
import { InternalError, NotFound, ValidationFailed } from "./errors";
import type { ErrorDetail } from "./types";

/** body-parser failure types mapped to a readable `ValidationFailed` detail — never the raw parser message. */
const BODY_PARSER_DETAILS: Record<string, ErrorDetail> = {
    "entity.parse.failed": { field: "body", issue: "must be valid JSON" },
    "entity.too.large": { field: "body", issue: "must not exceed 100kb" },
    "encoding.unsupported": { field: "body", issue: "could not be read" },
    "charset.unsupported": { field: "body", issue: "could not be read" },
    "request.size.invalid": { field: "body", issue: "could not be read" },
    "stream.encoding.set": { field: "body", issue: "could not be read" },
    "request.aborted": { field: "body", issue: "could not be read" },
};

function bodyParserDetail(error: unknown): ErrorDetail | undefined {
    if (typeof error !== "object" || error === null) {
        return undefined;
    }
    const type = (error as { type?: unknown }).type;
    return typeof type === "string" ? BODY_PARSER_DETAILS[type] : undefined;
}

const PATH_DETAIL: ErrorDetail = { field: "path", issue: "must be valid percent-encoding" };
const REQUEST_DETAIL: ErrorDetail = { field: "request", issue: "could not be processed" };

/** A numeric 4xx `status`/`statusCode` set by Express, the router, or a library on a non-`AppError` error. */
function clientErrorStatus(error: unknown): number | undefined {
    if (typeof error !== "object" || error === null) {
        return undefined;
    }
    const candidate = error as { status?: unknown; statusCode?: unknown };
    const status = typeof candidate.status === "number" ? candidate.status : candidate.statusCode;
    return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 499 ? status : undefined;
}

/**
 * Non-`AppError` client errors (fix #5). A `URIError` is Express 5's router failing to decode a percent-encoded path
 * parameter: its message carries the raw value, so it is never logged. Other 4xx errors log only `name` and `status`.
 */
function mapClientError(error: unknown): AppError | undefined {
    if (error instanceof URIError) {
        return ValidationFailed.withDetails([PATH_DETAIL]);
    }
    const status = clientErrorStatus(error);
    if (status === undefined) {
        return undefined;
    }
    logger.warn("client_error_mapped", { name: error instanceof Error ? error.name : "NonError", status });
    return status === 404 ? NotFound : ValidationFailed.withDetails([REQUEST_DETAIL]);
}

/**
 * The ONLY producer of error bodies. Never leaks stacks, SQL, request data, or the message of a
 * non-`AppError` error.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
    if (res.headersSent) {
        logger.error("error_after_headers_sent", {
            requestId: req.requestId,
            route: routeLabel(req),
            status: res.statusCode,
            error: err,
        });
        res.end();
        return;
    }

    let appError: AppError;
    if (err instanceof AppError) {
        appError = err;
        if (appError.status >= 500) {
            logger.error("unhandled_error", {
                requestId: req.requestId,
                route: routeLabel(req),
                status: appError.status,
                code: appError.code,
                error: err,
            });
        }
    } else {
        const detail = bodyParserDetail(err);
        const clientError = detail === undefined ? mapClientError(err) : undefined;
        if (detail !== undefined) {
            appError = ValidationFailed.withDetails([detail]);
        } else if (clientError !== undefined) {
            appError = clientError;
        } else {
            appError = InternalError;
            logger.error("unhandled_error", {
                requestId: req.requestId,
                route: routeLabel(req),
                status: InternalError.status,
                error: err,
            });
        }
    }

    (res.locals as { errorCode?: string }).errorCode = appError.code;

    res.status(appError.status).json({
        success: false,
        error: {
            code: appError.code,
            message: appError.message,
            details: appError.details,
            requestId: req.requestId,
        },
        ...appError.extra,
    });
}
