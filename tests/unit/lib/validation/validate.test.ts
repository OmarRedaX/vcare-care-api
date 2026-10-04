import { Type } from "class-transformer";
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from "class-validator";
import type { AppError } from "../../../../src/lib/error/AppError";
import { ToInt } from "../../../../src/lib/validation/transforms";
import { validateBody, validateParams, validateQuery } from "../../../../src/lib/validation/validate";

class AddressDto {
    @IsString()
    @MaxLength(5)
    city!: string;
}

class PersonDto {
    @IsString()
    @MaxLength(20)
    name!: string;

    @IsInt()
    @Min(1)
    @Max(10)
    count!: number;

    @ValidateNested()
    @Type(() => AddressDto)
    address!: AddressDto;
}

class QueryDto {
    @IsOptional()
    @ToInt()
    @IsInt()
    @Min(1)
    page?: number;

    @IsOptional()
    @IsString()
    q?: string;
}

class ParamsDto {
    @ToInt()
    @IsInt()
    @Min(1)
    id!: number;
}

class BooleanQueryDto {
    @IsBoolean()
    flag!: boolean;
}

const valid = { name: "synthetic", count: 3, address: { city: "Oslo" } };

async function failure(promise: Promise<unknown>): Promise<AppError> {
    try {
        await promise;
    } catch (error) {
        return error as AppError;
    }
    throw new Error("expected a ValidationFailed error");
}

describe("lib/validation/validate", () => {
    it("should return a typed instance when the body is valid", async () => {
        const dto = await validateBody(PersonDto, valid);
        expect(dto).toBeInstanceOf(PersonDto);
        expect(dto.address).toBeInstanceOf(AddressDto);
        expect(dto).toEqual(valid);
    });

    it('should throw ValidationFailed with "is not allowed" when an unknown property is present (F6)', async () => {
        const error = await failure(validateBody(PersonDto, { ...valid, isAdmin: true }));
        expect(error.code).toBe("ValidationFailed");
        expect(error.status).toBe(400);
        expect(error.details).toEqual([{ field: "isAdmin", issue: "is not allowed" }]);
    });

    it('should strip unknown members (top-level and nested) instead of rejecting them when unknownMembers is "strip"', async () => {
        const dto = await validateBody(
            PersonDto,
            { ...valid, isAdmin: true, address: { ...valid.address, extra: 1 } },
            { unknownMembers: "strip" },
        );
        expect(dto).toEqual(valid);
        expect(dto).not.toHaveProperty("isAdmin");
        expect(dto.address).not.toHaveProperty("extra");
    });

    it('should still reject invalid declared members when unknownMembers is "strip"', async () => {
        const error = await failure(validateBody(PersonDto, { ...valid, count: 99, isAdmin: true }, { unknownMembers: "strip" }));
        expect(error.details.map((detail) => detail.field)).toEqual(["count"]);
    });

    it("should report dotted paths when a nested property fails", async () => {
        const error = await failure(validateBody(PersonDto, { ...valid, address: { city: "Very long city" } }));
        expect(error.details).toEqual([{ field: "address.city", issue: expect.any(String) as string }]);
    });

    it("should report one entry per failing property sorted by field when several fail", async () => {
        const error = await failure(validateBody(PersonDto, { name: 5, count: 99, address: { city: "Oslo" }, zeta: 1 }));
        expect(error.details.map((detail) => detail.field)).toEqual(["count", "name", "zeta"]);
    });

    it("should not convert strings to numbers when validating a body", async () => {
        const error = await failure(validateBody(PersonDto, { ...valid, count: "3" }));
        expect(error.details.map((detail) => detail.field)).toEqual(["count"]);
    });

    it("should convert numeric query strings when validating a query", async () => {
        const dto = await validateQuery(QueryDto, { page: "2", q: "x" });
        expect(dto.page).toBe(2);
    });

    it("should convert numeric path params when validating params", async () => {
        await expect(validateParams(ParamsDto, { id: "42" })).resolves.toMatchObject({ id: 42 });
        const error = await failure(validateParams(ParamsDto, { id: "abc" }));
        expect(error.details.map((detail) => detail.field)).toEqual(["id"]);
    });

    it("should not convert a query string when Boolean design metadata exists without a transform", async () => {
        expect(Reflect.getMetadata("design:type", BooleanQueryDto.prototype, "flag")).toBe(Boolean);
        const error = await failure(validateQuery(BooleanQueryDto, { flag: "false" }));
        expect(error.code).toBe("ValidationFailed");
        expect(error.details.map((detail) => detail.field)).toEqual(["flag"]);
    });

    it("should not convert a query string when Boolean design metadata is removed", async () => {
        expect(Reflect.deleteMetadata("design:type", BooleanQueryDto.prototype, "flag")).toBe(true);
        const error = await failure(validateQuery(BooleanQueryDto, { flag: "false" }));
        expect(error.code).toBe("ValidationFailed");
        expect(error.details.map((detail) => detail.field)).toEqual(["flag"]);
    });

    it.each([
        ["an array", [valid]],
        ["missing", undefined],
        ["null", null],
        ["a string", "name=x"],
        ["a number", 7],
    ])('should throw "must be a JSON object" when the body is %s', async (_label, input) => {
        const error = await failure(validateBody(PersonDto, input));
        expect(error.code).toBe("ValidationFailed");
        expect(error.details).toEqual([{ field: "body", issue: "must be a JSON object" }]);
    });

    it("should not echo rejected values in details (F6)", async () => {
        const error = await failure(
            validateBody(PersonDto, {
                name: "SYNTHETIC-COMPLAINT-7731".repeat(3),
                count: 9999,
                address: { city: "synthetic.patient@example.test" },
                email: "synthetic.patient@example.test",
            }),
        );
        const rendered = JSON.stringify(error.details);
        expect(rendered).not.toContain("SYNTHETIC-COMPLAINT-7731");
        expect(rendered).not.toContain("synthetic.patient@example.test");
        expect(rendered).not.toContain("9999");
    });
});
