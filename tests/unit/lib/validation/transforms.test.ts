import { IsBoolean, IsInt } from "class-validator";
import { ToBoolean, ToInt } from "../../../../src/lib/validation/transforms";
import { validateQuery } from "../../../../src/lib/validation/validate";

class IntegerQueryDto {
    @ToInt()
    @IsInt()
    value!: number;
}

class BooleanQueryDto {
    @ToBoolean()
    @IsBoolean()
    value!: boolean;
}

describe("lib/validation/transforms", () => {
    it.each([
        ["0", 0],
        ["-0", -0],
        ["42", 42],
        ["-42", -42],
        ["9007199254740991", Number.MAX_SAFE_INTEGER],
        [42, 42],
    ])("should convert integer value %p when it is canonical or already numeric", async (input, expected) => {
        await expect(validateQuery(IntegerQueryDto, { value: input })).resolves.toMatchObject({ value: expected });
    });

    it.each(["", "01", "-01", "+1", "1e1", "0x10", " 5", "5 ", "1.5", "9007199254740992", "abc", true, null, ["1", "2"]])(
        "should reject integer value %p when it is not a canonical safe integer",
        async (value) => {
            await expect(validateQuery(IntegerQueryDto, { value })).rejects.toMatchObject({
                code: "ValidationFailed",
                details: [expect.objectContaining({ field: "value" })],
            });
        },
    );

    it.each([
        ["true", true],
        ["false", false],
        [true, true],
        [false, false],
    ])("should convert boolean value %p when it is exact or already boolean", async (input, expected) => {
        await expect(validateQuery(BooleanQueryDto, { value: input })).resolves.toMatchObject({ value: expected });
    });

    it.each(["TRUE", "False", "yes", "1", "", 1, 0, null, ["true", "false"]])(
        "should reject boolean value %p when it is not an exact boolean",
        async (value) => {
            await expect(validateQuery(BooleanQueryDto, { value })).rejects.toMatchObject({
                code: "ValidationFailed",
                details: [expect.objectContaining({ field: "value" })],
            });
        },
    );
});
