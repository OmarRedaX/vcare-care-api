import "reflect-metadata";
import { isRedactedKey, redact } from "../../../../src/lib/logger/redact";
import { NO_STORE_PREFIXES } from "../../../../src/routes";
import { ATTACH_DESC, attachmentEntity, OBJECT_KEY } from "./record-attachments.fixtures";

describe("attachment text and keys in log objects (defence in depth; the code never logs them)", () => {
    it("should redact the description, the object key and the URL of an attachment entity or intent logged by mistake", () => {
        const text = JSON.stringify(redact({ attachment: attachmentEntity(), intent: { url: "https://storage.test/u", fields: { key: "quarantine/x" } }, downloadUrl: "https://storage.test/d" }));
        for (const secret of [ATTACH_DESC, OBJECT_KEY, "https://storage.test", "quarantine/x"]) expect(text).not.toContain(secret);
    });

    it.each(["attachmentDescription", "objectKey", "quarantineKey", "downloadUrl", "uploadUrl", "url", "fields"])("should redact the key %s", (key) => {
        expect(isRedactedKey(key)).toBe(true);
        expect((redact({ [key]: ATTACH_DESC }) as Record<string, unknown>)[key]).not.toBe(ATTACH_DESC);
    });

    it("should keep the audit metadata key names loggable so the audit recorder accepts them", () => {
        for (const key of ["recordId", "fileType", "sizeBytes", "afterLock", "viewerRole", "viewerIsAuthor"]) expect(isRedactedKey(key)).toBe(false);
    });
});

describe("no-store prefix of the attachment routes", () => {
    it("should cover /api/records so every attachment response is Cache-Control no-store", () => {
        expect(NO_STORE_PREFIXES).toContain("/api/records");
    });
});
