import { AppError, isAppError } from "../../../../src/lib/error/AppError";
import { Conflict, InternalError, NotFound, ValidationFailed } from "../../../../src/lib/error/errors";

describe("lib/error/AppError", () => {
    it("should return a new instance and leave the constant untouched when withDetails is called", () => {
        const derived = ValidationFailed.withDetails([{ field: "name", issue: "is required" }]);

        expect(derived).not.toBe(ValidationFailed);
        expect(derived).toBeInstanceOf(AppError);
        expect(derived.details).toEqual([{ field: "name", issue: "is required" }]);
        expect(derived.code).toBe("ValidationFailed");
        expect(derived.status).toBe(400);
        expect(ValidationFailed.details).toEqual([]);
    });

    it("should merge extra members without mutating the constant when withExtra is called twice", () => {
        const derived = Conflict.withExtra({ a: 1 }).withExtra({ b: 2 });
        expect(derived.extra).toEqual({ a: 1, b: 2 });
        expect(Conflict.extra).toBeUndefined();
    });

    it("should keep code, status, details, and extra when withMessage is called", () => {
        const base = ValidationFailed.withDetails([{ field: "x", issue: "y" }]).withExtra({ k: true });
        const derived = base.withMessage("Other message");
        expect(derived.message).toBe("Other message");
        expect(derived.details).toEqual(base.details);
        expect(derived.extra).toEqual({ k: true });
        expect(base.message).toBe("Request validation failed");
    });

    it("should identify AppError instances when isAppError is called", () => {
        expect(isAppError(NotFound)).toBe(true);
        expect(isAppError(new Error("x"))).toBe(false);
        expect(isAppError({ code: "NotFound" })).toBe(false);
    });

    it.each([
        ["ValidationFailed", ValidationFailed, 400, "Request validation failed"],
        ["NotFound", NotFound, 404, "Resource not found"],
        ["Conflict", Conflict, 409, "The resource already exists"],
        ["InternalError", InternalError, 500, "An unexpected error occurred"],
    ] as const)("should expose %s with the contract status and message", (code, error, status, message) => {
        expect(error.code).toBe(code);
        expect(error.status).toBe(status);
        expect(error.message).toBe(message);
    });
});
