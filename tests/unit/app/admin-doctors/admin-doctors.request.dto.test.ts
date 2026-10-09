import "reflect-metadata";
import { DoctorUserIdParamsDto, ReinstateDoctorDto, SuspendDoctorDto } from "../../../../src/app/admin-doctors/dto/admin-doctors.request.dto";
import type { AppError } from "../../../../src/lib/error/AppError";
import { validateBody, validateParams } from "../../../../src/lib/validation/validate";

const EMOJI = String.fromCodePoint(0x1f600);

async function failure(work: () => Promise<unknown>): Promise<AppError> {
    try { await work(); } catch (error) { return error as AppError; }
    throw new Error("expected validation to fail");
}

describe.each([["SuspendDoctorDto", SuspendDoctorDto], ["ReinstateDoctorDto", ReinstateDoctorDto]] as const)("%s", (_name, Dto) => {
    it.each([3, 20, 2000])("should accept a reason of %i characters", async (length) => {
        const dto = await validateBody(Dto, { reason: "r".repeat(length) });
        expect(dto.reason).toHaveLength(length);
    });

    it.each([0, 1, 2])("should reject a reason of %i characters", async (length) => {
        const error = await failure(() => validateBody(Dto, { reason: "r".repeat(length) }));
        expect(error.code).toBe("ValidationFailed");
        expect(error.details.map((detail) => detail.field)).toContain("reason");
    });

    it("should reject a reason of 2001 characters", async () => {
        expect((await failure(() => validateBody(Dto, { reason: "r".repeat(2001) }))).code).toBe("ValidationFailed");
    });

    it("should count code points, not UTF-16 units, against the 2000 limit", async () => {
        await expect(validateBody(Dto, { reason: EMOJI.repeat(2000) })).resolves.toBeDefined();
        expect((await failure(() => validateBody(Dto, { reason: EMOJI.repeat(2001) }))).code).toBe("ValidationFailed");
        await expect(validateBody(Dto, { reason: EMOJI.repeat(3) })).resolves.toBeDefined();
        expect((await failure(() => validateBody(Dto, { reason: EMOJI.repeat(2) }))).code).toBe("ValidationFailed");
    });

    it.each(["bad\u0000reason", "bad\u0007reason", "bad\nreason", "bad\treason", "bad\u007freason"])("should reject control characters in %j", async (reason) => {
        const error = await failure(() => validateBody(Dto, { reason }));
        expect(error.details.map((detail) => detail.field)).toContain("reason");
    });

    it.each([{}, { reason: null }, { reason: 123 }, { reason: ["abc"] }])("should reject a missing or non-string reason (%j)", async (body) => {
        expect((await failure(() => validateBody(Dto, body))).code).toBe("ValidationFailed");
    });

    it("should reject unknown properties", async () => {
        const error = await failure(() => validateBody(Dto, { reason: "valid reason", doctorUserId: 5 }));
        expect(error.code).toBe("ValidationFailed");
        expect(error.details.map((detail) => detail.field)).toContain("doctorUserId");
    });

    it("should reject a non-object body", async () => {
        expect((await failure(() => validateBody(Dto, undefined))).code).toBe("ValidationFailed");
    });
});

describe("DoctorUserIdParamsDto", () => {
    it.each([["1", 1], ["202", 202]])("should convert the path value %s to the number %i", async (value, expected) => {
        await expect(validateParams(DoctorUserIdParamsDto, { doctorUserId: value })).resolves.toMatchObject({ doctorUserId: expected });
    });

    it.each(["0", "-1", "abc", "1.5", "", "1e3x"])("should reject the path value %j", async (value) => {
        const error = await failure(() => validateParams(DoctorUserIdParamsDto, { doctorUserId: value }));
        expect(error.code).toBe("ValidationFailed");
        expect(error.details.map((detail) => detail.field)).toContain("doctorUserId");
    });
});
