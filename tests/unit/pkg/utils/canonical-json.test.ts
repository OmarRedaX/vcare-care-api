import { canonicalJson } from "../../../../src/pkg/utils/canonical-json";

describe("pkg/utils/canonicalJson", () => {
    it("should produce identical output when object keys differ only in order", () => {
        const a = { b: 1, a: { d: [1, 2], c: "x" } };
        const b = { a: { c: "x", d: [1, 2] }, b: 1 };
        expect(canonicalJson(a)).toBe(canonicalJson(b));
        expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[1,2]},"b":1}');
    });

    it("should keep array order when arrays differ", () => {
        expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    });

    it("should drop undefined properties when serializing objects", () => {
        expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    });

    it("should render null for null and undefined when given at the top level", () => {
        expect(canonicalJson(null)).toBe("null");
        expect(canonicalJson(undefined)).toBe("null");
    });

    it("should render dates as ISO strings when a Date is nested", () => {
        expect(canonicalJson({ at: new Date("2026-01-02T03:04:05.000Z") })).toBe('{"at":"2026-01-02T03:04:05.000Z"}');
    });

    it("should throw when the value is cyclic", () => {
        const cyclic: Record<string, unknown> = { a: 1 };
        cyclic.self = cyclic;
        expect(() => canonicalJson(cyclic)).toThrow(TypeError);
    });

    it("should not treat a repeated non-cyclic reference as a cycle when the same object appears twice", () => {
        const shared = { x: 1 };
        expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
    });

    it.each([
        ["a BigInt", BigInt(1)],
        ["a function", () => 1],
        ["a non-finite number", Number.NaN],
    ])("should throw TypeError when the value contains %s", (_label, value) => {
        expect(() => canonicalJson({ value })).toThrow(TypeError);
    });
});
