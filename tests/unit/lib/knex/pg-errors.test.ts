import { AppError } from "../../../../src/lib/error/AppError";
import { PG_UNIQUE_VIOLATION, uniqueViolationConstraint } from "../../../../src/lib/knex/pg-errors";

describe("lib/knex/uniqueViolationConstraint", () => {
    it("should return the constraint when a pg-like error has the unique-violation code", () => {
        expect(PG_UNIQUE_VIOLATION).toBe("23505");
        expect(uniqueViolationConstraint({ code: "23505", constraint: "uq_specialties_slug" })).toBe("uq_specialties_slug");
    });

    it.each([
        ["the code differs", { code: "23P01", constraint: "uq_specialties_slug" }],
        ["the code is missing", { constraint: "uq_specialties_slug" }],
        ["the error is a string", "23505"],
        ["the error is null", null],
        ["the constraint is a number", { code: "23505", constraint: 12 }],
        ["the constraint is missing", { code: "23505" }],
        ["the error is an AppError", new AppError("Conflict", 409, "Conflict")],
    ])("should return undefined when %s", (_condition, error) => {
        expect(uniqueViolationConstraint(error)).toBeUndefined();
    });
});
