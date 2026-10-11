import "reflect-metadata";
import { IsArray } from "class-validator";
import { IsTextList } from "../../../../src/lib/validation/text-list-decorator";
import { validateBody } from "../../../../src/lib/validation/validate";

class ListBody { @IsArray() @IsTextList(5) items!: unknown[]; }
class LooseBody { @IsTextList(5) items!: unknown; }

const fails = (items: unknown): Promise<unknown> => expect(validateBody(ListBody, { items })).rejects.toMatchObject({ code: "ValidationFailed", details: [expect.objectContaining({ field: "items" })] });

describe("IsTextList", () => {
    it("should accept an empty list and preserve item order when every item is valid", async () => {
        expect((await validateBody(ListBody, { items: [] })).items).toEqual([]);
        expect((await validateBody(ListBody, { items: ["b", "a", "c"] })).items).toEqual(["b", "a", "c"]);
    });

    it("should accept an item of exactly the maximum length counted in code points", async () => {
        expect((await validateBody(ListBody, { items: ["abcde"] })).items).toEqual(["abcde"]);
        expect((await validateBody(ListBody, { items: ["\u{1F600}".repeat(5)] })).items).toHaveLength(1);
    });

    it("should reject an item one code point over the maximum when it contains astral characters", async () => {
        await fails(["\u{1F600}".repeat(6)]);
    });

    it.each([["empty", [""]], ["blank spaces", ["   "]], ["blank whitespace", [" \t"]], ["over length", ["abcdef"]],
        ["control character", ["a\u0001b"]], ["newline", ["a\nb"]], ["NUL", ["a\u0000"]], ["duplicate", ["a", "b", "a"]],
        ["number item", [1]], ["null item", [null]], ["object item", [{}]]])("should reject a list with a %s item", async (_label, items) => {
        await fails(items);
    });

    it("should treat case variants and padded variants as distinct items when matching duplicates exactly", async () => {
        expect((await validateBody(ListBody, { items: ["a", "A", "a "] })).items).toHaveLength(3);
    });

    it("should leave non-arrays to IsArray when the value is not a list", async () => {
        expect((await validateBody(LooseBody, { items: "not-a-list" })).items).toBe("not-a-list");
        await expect(validateBody(ListBody, { items: "not-a-list" })).rejects.toMatchObject({ code: "ValidationFailed" });
    });

    it("should never echo the rejected value when it reports the failure", async () => {
        const secret = "SYNTHETIC-SECRET-\u0001";
        try { await validateBody(LooseBody, { items: [secret] }); } catch (error) {
            expect(JSON.stringify(error)).not.toContain("SYNTHETIC-SECRET");
            return;
        }
        throw new Error("expected rejection");
    });
});
