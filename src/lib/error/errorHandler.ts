import type { NextFunction, Request, Response } from "express";
import { logger } from "../logger/logger";
import { AppError } from "./AppError";
import { InternalError, ValidationFailed } from "./errors";
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

/**
 * The ONLY producer of error bodies. Never leaks stacks, SQL, request data, or the message of a
 * non-`AppError` error.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
    if (res.headersSent) {
        logger.error("error_after_headers_sent", { requestId: req.requestId, error: err });
        res.end();
        return;
    }

    let appError: AppError;
    if (err instanceof AppError) {
        appError = err;
        if (appError.status >= 500) {
            logger.error("unhandled_error", { requestId: req.requestId, code: appError.code, error: err });
        }
    } else {
        const detail = bodyParserDetail(err);
        if (detail !== undefined) {
            appError = ValidationFailed.withDetails([detail]);
        } else {
            appError = InternalError;
            logger.error("unhandled_error", { requestId: req.requestId, error: err });
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
