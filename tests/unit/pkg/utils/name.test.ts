// Rules covered: AV-R27 (one normalisation for index members and the query).
import { normalizeName } from "../../../../src/pkg/utils/name";

describe("normalizeName", () => {
    it("should trim, collapse every whitespace run to one space and lower-case", () => {
        expect(normalizeName("  Dr.   ANNA \t\n Smith  ")).toBe("dr. anna smith");
    });

    it("should compose to NFC so a decomposed and a precomposed spelling compare equal", () => {
        const decomposed = "Cafe\u0301";
        expect(decomposed).not.toBe("Caf\u00e9");
        expect(normalizeName(decomposed)).toBe(normalizeName("Caf\u00e9"));
        expect(normalizeName(decomposed)).toBe("caf\u00e9");
    });

    it("should leave Arabic text unchanged and treat non-breaking and ideographic spaces as whitespace", () => {
        expect(normalizeName("د. سارة")).toBe("د. سارة");
        expect(normalizeName("أحمد\u00a0 \u3000علي")).toBe("أحمد علي");
    });

    it("should lower-case non-ASCII letters and keep astral characters intact", () => {
        expect(normalizeName("ÉLISE")).toBe("élise");
        expect(normalizeName("\u{1F600}A")).toBe("\u{1F600}a");
    });

    it("should be idempotent and return an empty string for blank input", () => {
        const once = normalizeName("  Mixed   CASE ");
        expect(normalizeName(once)).toBe(once);
        expect(normalizeName(" \t ")).toBe("");
    });
});
