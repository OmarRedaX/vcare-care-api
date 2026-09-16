import { AppError } from "./AppError";

/**
 * Shared error constants. Messages match the contract examples.
 * `Unauthorized` and `Forbidden` are emitted by `lib/auth` / `lib/rbac`, not by the foundation.
 */
export const ValidationFailed = new AppError("ValidationFailed", 400, "Request validation failed");

export const Unauthorized = new AppError("Unauthorized", 401, "Authentication required");

export const Forbidden = new AppError("Forbidden", 403, "You are not allowed to perform this action");

export const NotFound = new AppError("NotFound", 404, "Resource not found");

export const Conflict = new AppError("Conflict", 409, "The resource already exists");

export const IdempotencyConflict = new AppError(
    "IdempotencyConflict",
    422,
    "The idempotency key was already used with a different request",
);

export const RateLimited = new AppError("RateLimited", 429, "Too many requests");

export const InternalError = new AppError("InternalError", 500, "An unexpected error occurred");
