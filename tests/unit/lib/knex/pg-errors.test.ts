import { AppError } from "../../../../src/lib/error/AppError";
import { checkViolationConstraint, exclusionViolationConstraint, PG_CHECK_VIOLATION, PG_EXCLUSION_VIOLATION, PG_UNIQUE_VIOLATION, uniqueViolationConstraint } from "../../../../src/lib/knex/pg-errors";

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

describe("lib/knex/exclusionViolationConstraint", () => {
    it("should return the constraint when a pg-like error has the exclusion-violation code", () => {
        expect(PG_EXCLUSION_VIOLATION).toBe("23P01");
        expect(exclusionViolationConstraint({ code: "23P01", constraint: "excl_consultations_doctor_no_overlap" })).toBe("excl_consultations_doctor_no_overlap");
    });

    it.each([
        ["the code is a unique violation", { code: "23505", constraint: "uq_x" }],
        ["the code is missing", { constraint: "excl_x" }],
        ["the error is a string", "23P01"],
        ["the error is null", null],
        ["the constraint is missing", { code: "23P01" }],
        ["the constraint is a number", { code: "23P01", constraint: 1 }],
    ])("should return undefined when %s", (_condition, error) => {
        expect(exclusionViolationConstraint(error)).toBeUndefined();
    });
});

describe("lib/knex/checkViolationConstraint", () => {
    it("should return the constraint when a pg-like error has the check-violation code", () => {
        expect(PG_CHECK_VIOLATION).toBe("23514");
        expect(checkViolationConstraint({ code: "23514", constraint: "trg_medical_records_forbid_update_after_lock" })).toBe("trg_medical_records_forbid_update_after_lock");
    });

    it.each([
        ["the code is a unique violation", { code: "23505", constraint: "uq_x" }],
        ["the constraint is missing", { code: "23514" }],
        ["the constraint is a number", { code: "23514", constraint: 7 }],
        ["the error is null", null],
        ["the error is a string", "23514"],
    ])("should return undefined when %s", (_condition, error) => {
        expect(checkViolationConstraint(error)).toBeUndefined();
    });
});
