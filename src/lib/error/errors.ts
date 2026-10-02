import { AppError } from "./AppError";

/**
 * Shared error constants. Messages match the contract examples.
 * `Unauthorized`, `TokenExpired`, `Forbidden`, and `EmailNotVerified` are emitted by `lib/auth` / `lib/rbac`.
 */
export const ValidationFailed = new AppError("ValidationFailed", 400, "Request validation failed");

export const Unauthorized = new AppError("Unauthorized", 401, "Authentication required");

/** Signature verified, `exp` (+ 30 s tolerance) passed — emitted by `lib/auth` only. */
export const TokenExpired = new AppError("TokenExpired", 401, "Access token expired");

export const Forbidden = new AppError("Forbidden", 403, "You are not allowed to perform this action");

/** A policy requires `ev=true` (booking). Modules may `withMessage` a route-specific text. */
export const EmailNotVerified = new AppError("EmailNotVerified", 403, "Verify your email before booking");

export const NotFound = new AppError("NotFound", 404, "Resource not found");

export const Conflict = new AppError("Conflict", 409, "The resource already exists");

export const IdempotencyConflict = new AppError(
    "IdempotencyConflict",
    422,
    "The idempotency key was already used with a different request",
);

export const RateLimited = new AppError("RateLimited", 429, "Too many requests");

export const InternalError = new AppError("InternalError", 500, "An unexpected error occurred");
