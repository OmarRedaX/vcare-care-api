import "reflect-metadata";
import { validate } from "class-validator";
import { CodePointLength, NoControlCharacters } from "../../../../src/lib/validation/string-decorators";

class StringFields {
    @CodePointLength(2, 100)
    @NoControlCharacters("all")
    name!: string;

    @CodePointLength(0, 2000)
    @NoControlCharacters("nul")
    description!: string;
}

describe("string validation decorators", () => {
    it.each([
        ["a\uFE0F", ""],
        ["😀".repeat(100), "a\u0001b"],
    ])("should accept the value when it sits on a code-point boundary or a description holds a non-NUL control", async (name, description) => {
        const fields = Object.assign(new StringFields(), { name, description });
        expect(await validate(fields)).toEqual([]);
    });

    it.each([
        ["a\uFE0F".repeat(100), "", "name"],
        ["a\u0000b", "", "name"],
        ["a\u0001b", "", "name"],
        ["Valid", "a\uFE0F".repeat(2000), "description"],
        ["Valid", "a\u0000b", "description"],
    ])("should reject the value when its code-point length or control characters are invalid", async (name, description, field) => {
        const fields = Object.assign(new StringFields(), { name, description });
        expect((await validate(fields)).map((error) => error.property)).toContain(field);
    });
});
