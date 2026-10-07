import { contractOperationBlock, contractResponseCodes, responseBlock, schemaBlock } from "../../helpers/contract";

describe("verification contract C1–C6", () => {
    const operations = [
        ["/api/doctors/me/documents/uploads", "post", "createVerificationUploadIntent", ["201", "409", "422"]],
        ["/api/doctors/me/documents/uploads/{uploadId}/complete", "post", "completeVerificationUpload", ["200", "201", "410"]],
        ["/api/doctors/me/documents/{documentId}/download-url", "post", "getMyVerificationDocumentDownloadUrl", ["200", "404"]],
        ["/api/doctors/me/documents/{documentId}", "delete", "deleteMyVerificationDocument", ["204", "409"]],
        ["/api/admin/applications/{id}/documents/{documentId}/download-url", "post", "getApplicationDocumentDownloadUrl", ["200", "404"]],
    ] as const;

    it.each(operations)("declares %s %s with policies, optional idempotency and expected responses", (path, method, operationId, codes) => {
        const block = contractOperationBlock(path, method);
        expect(block).toContain(`operationId: ${operationId}`);
        for (const key of ["x-roles", "x-ownership", "x-account-state", "x-audit-actions"]) expect(block).toContain(`${key}:`);
        expect(block).toContain("#/components/parameters/IdempotencyKeyOptional");
        expect(contractResponseCodes(path, method)).toEqual(expect.arrayContaining([...codes]));
    });

    it("exposes metadata-only documents and short-lived URLs as separate schemas", () => {
        const document = schemaBlock("VerificationDocument");
        expect(document).not.toContain("downloadUrl:");
        expect(document).not.toContain("objectKey:");
        expect(schemaBlock("UploadIntent")).toContain("required: [uploadId, url, fields, expiresAt, maxBytes]");
        expect(schemaBlock("DownloadUrl")).toContain("required: [url, expiresAt]");
        expect(responseBlock("UploadIntentExpired")).toContain("UploadIntentExpired");
        expect(responseBlock("ApplicationNotEditable")).toContain("ApplicationNotEditable");
    });
});
