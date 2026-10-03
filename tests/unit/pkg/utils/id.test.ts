import { parsePositiveId } from "../../../../src/pkg/utils/id";

describe("pkg/utils/parsePositiveId", () => {
    it.each([
        ["1", 1],
        ["42", 42],
        ["9007199254740991", 9007199254740991],
    ])("should parse %p", (input, expected) => {
        expect(parsePositiveId(input)).toBe(expected);
    });

    it.each([
        "0",
        "00",
        "01",
        "+1",
        "-1",
        "1.0",
        "1e3",
        " 1",
        "1 ",
        "0x10",
        "",
        "12345678901234567", // 17 digits
        "9007199254740992", // 16 digits, unsafe
        "9999999999999999", // 16 digits, unsafe
        "%31",
    ])("should reject %p", (input) => {
        expect(parsePositiveId(input)).toBeUndefined();
    });

    it.each<[unknown]>([[1], [1n], [null], [undefined], [{}], [["1"]]])("should reject the non-string %p", (input) => {
        expect(parsePositiveId(input)).toBeUndefined();
    });
});
