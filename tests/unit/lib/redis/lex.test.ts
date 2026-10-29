// Rules covered: AV-R27 (prefix match on the name index), spec 12.3 (prefixRange bounds).
import { prefixRange } from "../../../../src/lib/redis/lex";

const NUL = String.fromCharCode(0);
/** Redis compares sorted-set members as bytes; UTF-8 byte order equals code point order. */
const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
const inRange = (member: string, prefix: string): boolean => {
    const [min, max] = prefixRange(prefix);
    return byBytes(member, min.slice(1)) >= 0 && byBytes(member, max.slice(1)) <= 0;
};

describe("prefixRange", () => {
    it("should return inclusive bounds from the prefix to the prefix plus the highest code point", () => {
        expect(prefixRange("ann")).toEqual(["[ann", "[ann\u{10FFFF}"]);
    });

    it("should include members that continue the prefix and exclude those that sort outside it, in plain text", () => {
        expect(inRange(`ann${NUL}7`, "ann")).toBe(true);
        expect(inRange(`anna${NUL}8`, "ann")).toBe(true);
        expect(inRange(`annz${NUL}9`, "ann")).toBe(true);
        expect(inRange(`ana${NUL}1`, "ann")).toBe(false);
        expect(inRange(`ano${NUL}2`, "ann")).toBe(false);
        expect(inRange(`an${NUL}3`, "ann")).toBe(false);
    });

    it("should order UTF-8 Arabic and CJK members correctly against the bounds", () => {
        expect(inRange(`سارة محمد${NUL}4`, "سارة")).toBe(true);
        expect(inRange(`سامي${NUL}5`, "سارة")).toBe(false);
        expect(inRange(`李明${NUL}6`, "李")).toBe(true);
        expect(inRange(`王明${NUL}6`, "李")).toBe(false);
        expect(inRange(`\u{1F600}x${NUL}6`, "\u{1F600}")).toBe(true);
    });

    it("should place a member whose next character is above every BMP character inside the range", () => {
        expect(inRange(`ann\u{10FFFE}${NUL}1`, "ann")).toBe(true);
        expect(inRange(`ann\uFFFF${NUL}1`, "ann")).toBe(true);
    });
});
