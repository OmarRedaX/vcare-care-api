import { truncateCodePoints } from "../../../../src/pkg/utils/code-points";

const EMOJI = String.fromCodePoint(0x1f600);
const count = (value: string): number => [...value].length;

describe("truncateCodePoints", () => {
    it("should return the value untouched when it is within the limit", () => {
        expect(truncateCodePoints("abc", 3)).toBe("abc");
        expect(truncateCodePoints("abc", 10)).toBe("abc");
        expect(truncateCodePoints("", 5)).toBe("");
    });

    it("should keep exactly max code points when the value is longer", () => {
        expect(truncateCodePoints("abcdef", 4)).toBe("abcd");
        expect(count(truncateCodePoints("x".repeat(600), 500))).toBe(500);
    });

    it("should never split a surrogate pair", () => {
        const result = truncateCodePoints(EMOJI.repeat(600), 500);
        expect(count(result)).toBe(500);
        expect(result.length).toBe(1000);
        expect(result).toBe(EMOJI.repeat(500));
        expect(truncateCodePoints(`a${EMOJI}b`, 2)).toBe(`a${EMOJI}`);
        expect(truncateCodePoints(`a${EMOJI}b`, 1)).toBe("a");
    });

    it("should treat combining sequences as separate code points", () => {
        expect(truncateCodePoints("éé", 3)).toBe("ée");
    });

    it.each([0, -1])("should return an empty string for a limit of %i", (max) => {
        expect(truncateCodePoints("abc", max)).toBe("");
    });
});
