import "reflect-metadata";
import { PatientProfileUpdateDto } from "../../../../src/app/patients/dto/patients.request.dto";
import type { AppError } from "../../../../src/lib/error/AppError";
import { validateBody } from "../../../../src/lib/validation/validate";

const valid = { dateOfBirth: "1990-05-17", gender: "female", bloodType: "AB-", allergies: ["TEST-ALLERGEN-A"],
    chronicConditions: ["TEST-CONDITION-A"], timezone: "Africa/Cairo" };

async function rejected(body: unknown, field: string): Promise<void> {
    try { await validateBody(PatientProfileUpdateDto, body); } catch (error) {
        const failure = error as AppError;
        expect(failure.code).toBe("ValidationFailed");
        expect(failure.details.map((detail) => detail.field)).toContain(field);
        expect(JSON.stringify(failure.details)).not.toContain("TEST-");
        return;
    }
    throw new Error(`expected ${field} to fail validation`);
}

describe("PatientProfileUpdateDto", () => {
    it("should accept a complete valid body and map it to changes", async () => {
        const dto = await validateBody(PatientProfileUpdateDto, valid);
        expect(dto.isEmpty()).toBe(false);
        expect(dto.toChanges()).toEqual(valid);
    });

    it("should report an empty body as empty when every member is absent", async () => {
        const dto = await validateBody(PatientProfileUpdateDto, {});
        expect(dto.isEmpty()).toBe(true);
        expect(dto.toChanges()).toEqual({});
    });

    it("should not treat explicit nulls as empty when clearing nullable members", async () => {
        const dto = await validateBody(PatientProfileUpdateDto, { dateOfBirth: null, gender: null, bloodType: null });
        expect(dto.isEmpty()).toBe(false);
        expect(dto.toChanges()).toEqual({ dateOfBirth: null, gender: null, bloodType: null });
    });

    it("should accept empty arrays so lists can be cleared", async () => {
        expect((await validateBody(PatientProfileUpdateDto, { allergies: [], chronicConditions: [] })).toChanges()).toEqual({ allergies: [], chronicConditions: [] });
    });

    it.each([["id"], ["userId"], ["fullName"], ["email"], ["diagnosis"]])("should reject unknown member %s", async (member) => {
        await rejected({ ...valid, [member]: 1 }, member);
    });

    it.each([
        ["null timezone", { timezone: null }, "timezone"],
        ["null allergies", { allergies: null }, "allergies"],
        ["null conditions", { chronicConditions: null }, "chronicConditions"],
        ["invalid zone", { timezone: "Not/AZone" }, "timezone"],
        ["long zone", { timezone: "x".repeat(65) }, "timezone"],
        ["numeric zone", { timezone: 5 }, "timezone"],
        ["bad gender", { gender: "unknown" }, "gender"],
        ["uppercase gender", { gender: "Female" }, "gender"],
        ["bad blood type", { bloodType: "C+" }, "bloodType"],
        ["lowercase blood type", { bloodType: "a+" }, "bloodType"],
        ["51 allergies", { allergies: Array.from({ length: 51 }, (_, i) => `TEST-A-${i}`) }, "allergies"],
        ["51 conditions", { chronicConditions: Array.from({ length: 51 }, (_, i) => `TEST-C-${i}`) }, "chronicConditions"],
        ["201 code point item", { allergies: ["x".repeat(201)] }, "allergies"],
        ["blank item", { allergies: ["   "] }, "allergies"],
        ["empty item", { chronicConditions: [""] }, "chronicConditions"],
        ["control character", { allergies: ["TEST-\u0007-A"] }, "allergies"],
        ["duplicate item", { chronicConditions: ["TEST-C", "TEST-C"] }, "chronicConditions"],
        ["non-string item", { allergies: [1] }, "allergies"],
        ["non-array allergies", { allergies: "TEST-A" }, "allergies"],
        ["non-calendar date", { dateOfBirth: "2027-02-30" }, "dateOfBirth"],
        ["datetime date", { dateOfBirth: "1990-05-17T00:00:00Z" }, "dateOfBirth"],
        ["slashed date", { dateOfBirth: "17/05/1990" }, "dateOfBirth"],
        ["numeric date", { dateOfBirth: 19900517 }, "dateOfBirth"],
    ] as const)("should reject %s without echoing the value", async (_label, change, field) => {
        await rejected({ ...valid, ...change }, field);
    });

    it("should accept the boundary of 50 items and 200 code points", async () => {
        const allergies = Array.from({ length: 50 }, (_, i) => `TEST-${i}`);
        expect((await validateBody(PatientProfileUpdateDto, { allergies, chronicConditions: ["\u{1F600}".repeat(200)] })).toChanges().allergies).toHaveLength(50);
    });

    it.each(["female", "male", "other", "undisclosed"])("should accept gender %s", async (gender) => {
        expect((await validateBody(PatientProfileUpdateDto, { gender })).gender).toBe(gender);
    });

    it.each(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown"])("should accept blood type %s", async (bloodType) => {
        expect((await validateBody(PatientProfileUpdateDto, { bloodType })).bloodType).toBe(bloodType);
    });

    it("should reject a non-object body", async () => {
        for (const body of [[], "text", 5, null]) await expect(validateBody(PatientProfileUpdateDto, body)).rejects.toMatchObject({ code: "ValidationFailed" });
    });
});
