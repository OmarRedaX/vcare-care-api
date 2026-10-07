import { isRedactedKey, redact } from "../../../../src/lib/logger/redact";

describe("doctor field redaction", () => {
    it.each(["headline", "bio", "reviewNote"])("should redact %s when logging a doctor field", (field) => {
        expect(isRedactedKey(field)).toBe(true);
        expect(redact({ [field]: "SYNTHETIC-SENSITIVE-7731" })).toEqual({ [field]: "[REDACTED]" });
    });
});
