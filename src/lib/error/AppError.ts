import type { ErrorCode, ErrorDetail } from "./types";

/**
 * The only error type the application throws. Rendered exclusively by `lib/error/errorHandler.ts`.
 * Instances exported from `errors.ts` are shared constants — every `with*` method returns a NEW instance
 * so a constant can never be mutated by one request and observed by another.
 */
export class AppError extends Error {
    constructor(
        readonly code: ErrorCode,
        readonly status: number,
        message: string,
        readonly details: readonly ErrorDetail[] = [],
        readonly extra?: Readonly<Record<string, unknown>>,
    ) {
        super(message);
        this.name = "AppError";
    }

    withDetails(details: ErrorDetail[]): AppError {
        return new AppError(this.code, this.status, this.message, details, this.extra);
    }

    /** Sibling members rendered next to `error` in the envelope (e.g. `ScheduleConflicts`, `SuspensionPending`). */
    withExtra(extra: Record<string, unknown>): AppError {
        return new AppError(this.code, this.status, this.message, this.details, {
            ...this.extra,
            ...extra,
        });
    }

    withMessage(message: string): AppError {
        return new AppError(this.code, this.status, message, this.details, this.extra);
    }
}

export function isAppError(value: unknown): value is AppError {
    return value instanceof AppError;
}
