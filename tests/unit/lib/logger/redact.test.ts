import { normalizeKey, REDACTED_KEYS, redact } from "../../../../src/lib/logger/redact";

/** One row per key: a later module that appends a key must append a row here (spec §3.4.4). */
const EXPECTED_KEYS = [
    "complaintText",
    "examinationNotes",
    "diagnosisText",
    "diagnosisCode",
    "treatmentPlan",
    "allergies",
    "chronicConditions",
    "bloodType",
    "dateOfBirth",
    "objectKey",
    "downloadUrl",
    "uploadUrl",
    "joinToken",
    "authorization",
    "cookie",
    "setCookie",
    "fullName",
    "displayName",
    "firstName",
    "lastName",
    "email",
    "phone",
    "password",
    "token",
    "accessToken",
    "refreshToken",
    "serviceToken",
    "clientSecret",
    "body",
    "requestBody",
    // access spec §7: database URLs carry credentials
    "connectionString",
    "databaseUrl",
    "migrationDatabaseUrl",
];

describe("lib/logger/redact", () => {
    it("should declare exactly the spec REDACTED_KEYS when the module loads", () => {
        expect([...REDACTED_KEYS].sort()).toEqual([...EXPECTED_KEYS].sort());
    });

    it.each(EXPECTED_KEYS)("should redact %s when present at the top level (F7)", (key) => {
        expect(redact({ [key]: "SYNTHETIC-SECRET-VALUE", keep: "visible" })).toEqual({
            [key]: "[REDACTED]",
            keep: "visible",
        });
    });

    it.each([
        ["complaint_text"],
        ["COMPLAINT-TEXT"],
        ["Complaint_Text"],
        ["set-cookie"],
        ["access_token"],
        ["DATE_OF_BIRTH"],
        ["Authorization"],
    ])("should redact the snake_case / kebab-case / upper-case variant %s when keys are normalised", (key) => {
        expect(redact({ [key]: "SYNTHETIC-SECRET-VALUE" })).toEqual({ [key]: "[REDACTED]" });
    });

    it("should normalise keys by lower-casing and removing _ and -", () => {
        expect(normalizeKey("Set-Cookie_Header")).toBe("setcookieheader");
    });

    it("should redact whole objects when a redacted key holds an object", () => {
        expect(redact({ body: { complaintText: "x", other: 1 } })).toEqual({ body: "[REDACTED]" });
    });

    it("should redact nested objects and arrays", () => {
        const input = {
            level1: {
                items: [{ email: "synthetic.patient@example.test", id: 1 }, { phone: "+10000000000", id: 2 }],
                deeper: { allergies: ["synthetic-allergen"] },
            },
        };
        expect(redact(input)).toEqual({
            level1: {
                items: [
                    { email: "[REDACTED]", id: 1 },
                    { phone: "[REDACTED]", id: 2 },
                ],
                deeper: { allergies: "[REDACTED]" },
            },
        });
    });

    it('should return "[Circular]" when a cycle exists', () => {
        const cyclic: Record<string, unknown> = { id: 1 };
        cyclic.self = cyclic;
        expect(redact(cyclic)).toEqual({ id: 1, self: "[Circular]" });
    });

    it("should not mark a shared non-cyclic reference as circular when it appears twice", () => {
        const shared = { id: 1 };
        expect(redact({ a: shared, b: shared })).toEqual({ a: { id: 1 }, b: { id: 1 } });
    });

    it('should return "[Truncated]" when depth exceeds 8', () => {
        let deep: Record<string, unknown> = { leaf: "bottom" };
        for (let index = 0; index < 10; index += 1) {
            deep = { next: deep };
        }
        const rendered = JSON.stringify(redact(deep));
        expect(rendered).toContain("[Truncated]");
        expect(rendered).not.toContain("bottom");

        // Exactly 8 nested objects below the root stay intact.
        let shallow: Record<string, unknown> = { leaf: "kept" };
        for (let index = 0; index < 7; index += 1) {
            shallow = { next: shallow };
        }
        expect(JSON.stringify(redact(shallow))).toContain("kept");
    });

    it("should leave the message string unchanged", () => {
        expect(redact({ message: "email token password" })).toEqual({ message: "email token password" });
        expect(redact("a plain string")).toBe("a plain string");
    });

    it("should convert dates to ISO strings and pass primitives through", () => {
        expect(redact({ at: new Date("2026-01-01T00:00:00.000Z"), n: 1, b: false, z: null })).toEqual({
            at: "2026-01-01T00:00:00.000Z",
            n: 1,
            b: false,
            z: null,
        });
    });
});
