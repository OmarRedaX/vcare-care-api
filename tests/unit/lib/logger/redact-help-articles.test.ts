import { isRedactedKey, redact } from "../../../../src/lib/logger/redact";

describe("help-articles field redaction (HA-D6)", () => {
    it("should redact body in a help-articles-shaped payload", () => {
        const payload = { id: 7, title: "Synthetic Article 001", body: "SYNTHETIC-HELP-BODY-7731", category: "how-it-works" };
        expect(isRedactedKey("body")).toBe(true);
        expect(redact(payload)).toEqual({ id: 7, title: "Synthetic Article 001", body: "[REDACTED]", category: "how-it-works" });
    });

    it("should redact body nested in requestBody and in an array of articles", () => {
        expect(redact({ requestBody: { body: "SYNTHETIC-HELP-BODY-7731" } })).toEqual({ requestBody: "[REDACTED]" });
        expect(redact({ items: [{ id: 1, body: "SYNTHETIC-HELP-BODY-7731" }] })).toEqual({ items: [{ id: 1, body: "[REDACTED]" }] });
    });

    it("should leave title unredacted because the module never logs it and it is not sensitive", () => {
        expect(isRedactedKey("title")).toBe(false);
    });
});
