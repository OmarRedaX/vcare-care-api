import * as errors from "../../../../src/lib/error/errors";
import { AppError } from "../../../../src/lib/error/AppError";
import { contractErrorCodes } from "../../../helpers/contract";

/** Contract conformance: every exported error is a contract `ErrorCode` with the spec §3.4.3 status/message. */
describe("lib/error/errors", () => {
    const expected: Record<string, [number, string]> = {
        ValidationFailed: [400, "Request validation failed"],
        Unauthorized: [401, "Authentication required"],
        Forbidden: [403, "You are not allowed to perform this action"],
        NotFound: [404, "Resource not found"],
        Conflict: [409, "The resource already exists"],
        IdempotencyConflict: [422, "The idempotency key was already used with a different request"],
        RateLimited: [429, "Too many requests"],
        InternalError: [500, "An unexpected error occurred"],
    };

    it("should export exactly the spec error constants when the module loads", () => {
        expect(Object.keys(errors).sort()).toEqual(Object.keys(expected).sort());
    });

    it.each(Object.entries(expected))(
        "should declare %s with a contract ErrorCode, its status, and its message",
        (name, [status, message]) => {
            const error = (errors as Record<string, unknown>)[name];
            expect(error).toBeInstanceOf(AppError);
            const appError = error as AppError;
            expect(contractErrorCodes()).toContain(appError.code);
            expect(appError.code).toBe(name);
            expect(appError.status).toBe(status);
            expect(appError.message).toBe(message);
            expect(appError.details).toEqual([]);
        },
    );
});
