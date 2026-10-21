import "reflect-metadata";
import { RECORD_ATTACHMENT_MAX_PER_RECORD } from "../../../src/app/record-attachments/constants";
import { RecordAttachmentResponseDto } from "../../../src/app/record-attachments/dto/record-attachments.response.dto";
import { RecordAttachmentIntentDto } from "../../../src/app/record-attachments/dto/record-attachments.request.dto";
import * as errors from "../../../src/app/record-attachments/errors";
import { RecordAttachmentAuditAction } from "../../../src/app/record-attachments/enums";
import { RecordLocked } from "../../../src/app/records/errors";
import { MAX_UPLOAD_BYTES } from "../../../src/app/upload-intents/constants";
import { ERROR_CODES } from "../../../src/lib/error/types";
import { attachmentEntity } from "../app/record-attachments/record-attachments.fixtures";
import { contractErrorCodes, contractOperationBlock, contractResponseCodes, headerBlock, inlineLists, responseBlock, schemaBlock } from "../../helpers/contract";
import { validateBody } from "../../../src/lib/validation/validate";

type Method = "post" | "delete";
/** [operationId, path, method, roles, ownership, response codes, audit class (undefined = none), audit actions] */
const OPERATIONS: Array<[string, string, Method, string[], string, string[], string | undefined, string[]]> = [
    ["createRecordAttachmentUploadIntent", "/api/records/{id}/attachments/uploads", "post", ["doctor"], "record-author", ["201", "400", "401", "403", "404", "409", "429", "500"], undefined, []],
    ["completeRecordAttachmentUpload", "/api/records/{id}/attachments/uploads/{uploadId}/complete", "post", ["doctor"], "record-author", ["200", "201", "400", "401", "403", "404", "409", "410", "429", "500"], "clinical-write", ["attachment.added"]],
    ["getRecordAttachmentDownloadUrl", "/api/records/{id}/attachments/{attachmentId}/download-url", "post", ["patient", "doctor"], "consulted-patient-or-self", ["200", "400", "401", "403", "404", "429", "500"], "clinical-read", ["attachment.url_issued"]],
    ["deleteRecordAttachment", "/api/records/{id}/attachments/{attachmentId}", "delete", ["doctor"], "record-author", ["204", "400", "401", "403", "404", "409", "429", "500"], "clinical-write", ["attachment.removed"]],
];

/** Property names declared one level under `properties:` of a schema block. */
function propertyNames(block: string): string[] {
    const lines = block.split(/\r?\n/);
    const start = lines.findIndex((line) => line === "      properties:");
    if (start < 0) throw new Error("no properties block");
    const names: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (line.trim().length > 0 && !line.startsWith("        ")) break;
        const match = /^ {8}([A-Za-z]+):\s*$/.exec(line);
        if (match?.[1] !== undefined) names.push(match[1]);
    }
    return names;
}

describe("record-attachments contract: operations", () => {
    it.each(OPERATIONS)("should declare %s with its roles, ownership, response set, audit class and no idempotency parameter or 422", (operationId, apiPath, method, roles, ownership, codes, auditClass, actions) => {
        const block = contractOperationBlock(apiPath, method);
        expect(block).toContain(`operationId: ${operationId}`);
        expect(block).toContain("bearerUser");
        expect(inlineLists(block, "x-roles")).toEqual([roles]);
        expect(block).toContain(`x-ownership: ${ownership}`);
        expect([...contractResponseCodes(apiPath, method)].sort()).toEqual([...codes].sort());
        if (auditClass === undefined) expect(block).not.toContain("x-audit: ");
        else expect(block).toContain(`x-audit: ${auditClass}`);
        expect(inlineLists(block, "x-audit-actions")).toEqual([actions]);
        expect(block).not.toContain("components/parameters/IdempotencyKey");
        expect(block).not.toContain("Idempotency-Key:");
        expect(contractResponseCodes(apiPath, method)).not.toContain("422");
    });

    it("should never list the admin role on any attachment operation", () => {
        for (const [, apiPath, method] of OPERATIONS) expect(inlineLists(contractOperationBlock(apiPath, method), "x-roles")[0]).not.toContain("admin");
    });

    it("should declare the account state of the three writes (not locally suspended) and of the download (a suspended doctor gets 404)", () => {
        for (const [, apiPath, method] of OPERATIONS.filter(([, , , , ownership]) => ownership === "record-author")) {
            expect(contractOperationBlock(apiPath, method)).toContain("x-account-state: 'status active; not locally suspended'");
        }
        expect(contractOperationBlock("/api/records/{id}/attachments/{attachmentId}/download-url", "post")).toContain("x-account-state: 'status active; a locally suspended doctor receives 404'");
    });

    it("should answer the intent and complete 409 with AttachmentLimitReached and complete additionally with Conflict, plus 410 UploadIntentExpired", () => {
        expect(contractOperationBlock("/api/records/{id}/attachments/uploads", "post")).toContain("#/components/responses/AttachmentLimitReached");
        const complete = contractOperationBlock("/api/records/{id}/attachments/uploads/{uploadId}/complete", "post");
        expect(complete).toContain("#/components/responses/RecordAttachmentCompleteConflict");
        expect(complete).toContain("#/components/responses/UploadIntentExpired");
        expect(responseBlock("AttachmentLimitReached")).toContain("code: AttachmentLimitReached");
        const conflict = responseBlock("RecordAttachmentCompleteConflict");
        expect(conflict).toContain("code: AttachmentLimitReached");
        expect(conflict).toContain("code: Conflict");
        expect(conflict).toContain("Retry-After");
        expect(responseBlock("UploadIntentExpired")).toContain("UploadIntentExpired");
    });

    it("should answer the delete 409 with RecordLocked and 204 with no content", () => {
        const block = contractOperationBlock("/api/records/{id}/attachments/{attachmentId}", "delete");
        expect(block).toContain("#/components/responses/RecordLocked");
        expect(block).toContain("#/components/responses/NoContent");
        expect(responseBlock("RecordLocked")).toContain("code: RecordLocked");
        expect(responseBlock("RecordLocked")).toContain("an attachment cannot be deleted after the 24 h lock");
    });

    it("should send Cache-Control no-store on the attachment error and success responses that carry record data", () => {
        for (const name of ["AttachmentLimitReached", "RecordAttachmentCompleteConflict", "RecordAttachmentOk", "RecordLocked", "UploadIntentCreated", "DownloadUrlOk"]) {
            expect([name, responseBlock(name)]).toEqual([name, expect.stringContaining("CacheControlNoStore")]);
        }
    });

    it("should document the 200 replay and 201 creation of complete with the same attachment body", () => {
        const block = contractOperationBlock("/api/records/{id}/attachments/uploads/{uploadId}/complete", "post");
        expect(block).toMatch(/'200':\s*\n\s+\$ref: '#\/components\/responses\/RecordAttachmentOk'/);
        expect(block).toMatch(/'201':\s*\n\s+\$ref: '#\/components\/responses\/RecordAttachmentOk'/);
        expect(responseBlock("RecordAttachmentOk")).toContain("#/components/schemas/RecordAttachment");
    });

    it("should document the check order, the audit-before-URL rule and that no route honours an Idempotency-Key", () => {
        const flat = (apiPath: string, method: Method) => contractOperationBlock(apiPath, method).replace(/\s+/g, " ");
        const download = flat("/api/records/{id}/attachments/{attachmentId}/download-url", "post");
        for (const text of ["`attachment.url_issued` audit row is committed **before** the URL is signed", "the request fails (`500`) and no URL is issued", "presigned GET valid 60 seconds", "`attachment` disposition"]) expect(download).toContain(text);
        const remove = flat("/api/records/{id}/attachments/{attachmentId}", "delete");
        for (const text of ["attachment absent, belonging to another record or already deleted → `404`", "`409 RecordLocked`", "the stored object is kept"]) expect(remove).toContain(text);
        const create = flat("/api/records/{id}/attachments/uploads", "post");
        for (const text of ["this route never answers `403 NotAssignedDoctor`", "`409 AttachmentLimitReached`", "`400 ValidationFailed`"]) expect(create).toContain(text);
        for (const [, apiPath, method] of OPERATIONS) expect(flat(apiPath, method)).toContain("`Idempotency-Key` is not honoured");
    });

    it.each([
        ["/api/records/{id}/attachments/uploads/{uploadId}/complete", "post", "{uploadId}"],
        ["/api/records/{id}/attachments/{attachmentId}/download-url", "post", "{attachmentId}"],
        ["/api/records/{id}/attachments/{attachmentId}", "delete", "{attachmentId}"],
    ] as Array<[string, Method, string]>)("should say why %s answers 400 (a request body) and that a bad %s is 404 after the rate limit", (apiPath, method, param) => {
        const text = contractOperationBlock(apiPath, method).replace(/\s+/g, " ");
        expect(text).toContain("a request body is not accepted");
        expect(text).toContain(`A non-numeric, zero or negative \`${param}\` is \`404 NotFound\`, not \`400\`, and is answered after the rate limit`);
    });

    it("should document the suspension re-check inside the complete write transaction", () => {
        const text = contractOperationBlock("/api/records/{id}/attachments/uploads/{uploadId}/complete", "post").replace(/\s+/g, " ");
        expect(text).toContain("The local suspension is checked again inside the write transaction");
        expect(text).toContain("`403 Forbidden`, no attachment or audit row is created, the promoted object is deleted and the intent stays open");
    });

    it("should list every Conflict cause of complete, give Retry-After only to the lock-held Conflict and carry the real Conflict message", () => {
        const block = responseBlock("RecordAttachmentCompleteConflict").replace(/\s+/g, " ");
        for (const text of ["the intent was closed or expired by the purge or a concurrent request between the lock read and the short transaction", "another request holds the intent lock",
            "`Retry-After: 1` is present only on the lock-held `Conflict`", "absent on `AttachmentLimitReached`"]) expect(block).toContain(text);
        expect(block).toContain("message: The resource already exists");
        expect(block).not.toContain("message: Conflict details");
        expect(errors.AttachmentLimitReached.extra).toBeUndefined();
    });

    it("should describe Retry-After on the lock-held complete Conflict and its absence on AttachmentLimitReached", () => {
        const header = headerBlock("RetryAfter").replace(/\s+/g, " ");
        expect(header).toContain("`409 Conflict` from an upload-intent `complete` while another request holds that intent's lock: always `1`, `Conflict` only");
        expect(header).toContain("Absent on every other 409 (for example `AttachmentLimitReached`");
    });

    it("should name the four paths under /api/records/{id}/attachments and none of the old upload-schema names", () => {
        for (const [, apiPath] of OPERATIONS) expect(apiPath.startsWith("/api/records/{id}/attachments")).toBe(true);
        expect(() => schemaBlock("RecordAttachmentUpload")).toThrow();
    });
});

describe("record-attachments contract: schemas", () => {
    it("should require every member the response DTO emits, in the DTO's order, and no other", () => {
        const required = inlineLists(schemaBlock("RecordAttachment"), "required")[0] ?? [];
        const dto = RecordAttachmentResponseDto.from(attachmentEntity(), { userId: 202, role: "doctor" });
        expect([...required]).toEqual(Object.keys(dto));
        expect(propertyNames(schemaBlock("RecordAttachment"))).toEqual(Object.keys(dto));
    });

    it("should carry no downloadUrl, url, object key or uploader member", () => {
        const block = schemaBlock("RecordAttachment");
        for (const name of ["downloadUrl", "url", "objectKey", "uploadedByUserId", "deletedAt"]) expect(propertyNames(block)).not.toContain(name);
        expect(block).toContain("no response carries a URL or an object key");
    });

    it("should enumerate exactly the three detected file types and bound the size at the shared maximum", () => {
        const block = schemaBlock("RecordAttachment");
        expect(inlineLists(block, "enum")[0]).toEqual(["application/pdf", "image/jpeg", "image/png"]);
        expect(block).toContain(`maximum: ${MAX_UPLOAD_BYTES}`);
        expect(block).toContain("minimum: 1");
    });

    it("should type the description as a nullable string of at most 500 characters", () => {
        const block = schemaBlock("RecordAttachment");
        expect(block).toContain("type: [string, 'null']");
        expect(block).toContain("maxLength: 500");
    });

    it("should declare the intent body as optional, closed, with only an optional bounded description", async () => {
        const block = schemaBlock("RecordAttachmentIntentCreate");
        expect(block).toContain("additionalProperties: false");
        expect(block).not.toContain("required:");
        expect(propertyNames(block)).toEqual(["description"]);
        expect(block).toContain("minLength: 1");
        expect(block).toContain("maxLength: 500");
        expect(block).toContain("JSON `null` is rejected");
        expect(contractOperationBlock("/api/records/{id}/attachments/uploads", "post")).toMatch(/requestBody:\s*\n\s+required: false/);
        const dto = await validateBody(RecordAttachmentIntentDto, {});
        expect(dto.toInput()).toEqual({ attachmentDescription: null });
    });

    it("should reuse the shared upload intent and download url schemas without a record-specific copy", () => {
        expect(responseBlock("UploadIntentCreated")).toContain("#/components/schemas/UploadIntent");
        expect(responseBlock("DownloadUrlOk")).toContain("#/components/schemas/DownloadUrl");
        expect(inlineLists(schemaBlock("UploadIntent"), "required")[0]).toEqual(["uploadId", "url", "fields", "expiresAt", "maxBytes"]);
        expect(inlineLists(schemaBlock("DownloadUrl"), "required")[0]).toEqual(["url", "expiresAt"]);
    });
});

describe("record-attachments contract: error codes and audit actions", () => {
    it("should declare AttachmentLimitReached in the ErrorCode enum, in ERROR_CODES and with status 409", () => {
        expect(contractErrorCodes()).toContain("AttachmentLimitReached");
        expect(ERROR_CODES).toContain("AttachmentLimitReached");
        expect(errors.AttachmentLimitReached.code).toBe("AttachmentLimitReached");
        expect(errors.AttachmentLimitReached.status).toBe(409);
        expect(errors.AttachmentLimitReached.message).toContain(String(RECORD_ATTACHMENT_MAX_PER_RECORD));
    });

    it("should keep the contract ErrorCode enum and the runtime ERROR_CODES identical", () => {
        expect([...contractErrorCodes()].sort()).toEqual([...ERROR_CODES].sort());
    });

    it("should declare every error owned by the module in the ErrorCode enum", () => {
        for (const value of Object.values(errors)) {
            const code = (value as { code?: string }).code;
            if (code !== undefined) expect(contractErrorCodes()).toContain(code);
        }
    });

    it("should reuse RecordLocked with its contract status for a delete after the lock", () => {
        expect([RecordLocked.code, RecordLocked.status]).toEqual(["RecordLocked", 409]);
        expect(contractErrorCodes()).toContain("RecordLocked");
    });

    it("should use the audit action names the contract lists", () => {
        const listed = OPERATIONS.flatMap((operation) => operation[7]).sort();
        expect(Object.values(RecordAttachmentAuditAction).sort()).toEqual(listed);
    });

    it("should describe the record view's attachments as metadata without URL or key, oldest first, in the contract text of the record reads", () => {
        const block = schemaBlock("MedicalRecord");
        expect(block).toContain("metadata only (no URL, no object key), oldest first");
        expect(inlineLists(block, "required")[0]).toContain("attachments");
    });
});
