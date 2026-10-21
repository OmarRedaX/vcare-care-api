import "reflect-metadata";
import { RecordAttachmentIntentDto } from "../../../../src/app/record-attachments/dto/record-attachments.request.dto";
import { RecordAttachmentResponseDto } from "../../../../src/app/record-attachments/dto/record-attachments.response.dto";
import type { AppError } from "../../../../src/lib/error/AppError";
import { validateBody } from "../../../../src/lib/validation/validate";
import { ATTACH_DESC, attachmentEntity, NOW, OBJECT_KEY } from "./record-attachments.fixtures";

const intent = (body: unknown) => validateBody(RecordAttachmentIntentDto, body);
async function failure(body: unknown): Promise<AppError> {
    try { await intent(body); } catch (error) { return error as AppError; }
    throw new Error("expected validation to fail");
}
const fieldsOf = async (body: unknown): Promise<string[]> => (await failure(body)).details.map((detail) => detail.field);
/** Two code points but four UTF-16 units: proves the length is counted in code points. */
const EMOJI = "\u{1F600}";

describe("RecordAttachmentIntentDto", () => {
    it("should accept an empty body and map it to a null description", async () => {
        expect((await intent({})).toInput()).toEqual({ attachmentDescription: null });
    });

    it("should accept a description and carry it to the service input", async () => {
        expect((await intent({ description: ATTACH_DESC })).toInput()).toEqual({ attachmentDescription: ATTACH_DESC });
    });

    it.each([
        ["one code point", "x", true], ["500 code points", "x".repeat(500), true], ["501 code points", "x".repeat(501), false],
        ["500 emoji (1000 UTF-16 units)", EMOJI.repeat(500), true], ["501 emoji", EMOJI.repeat(501), false],
        ["an empty string", "", false], ["whitespace only", "     ", false], ["tabs and newlines only", "\t\n \r\n", false],
        ["a NUL character", "scan\u0000page", false], ["a leading NUL", "\u0000scan", false],
        ["a newline inside", "line one\nline two", true], ["surrounding spaces around text", "  scan  ", true],
    ])("should judge a description of %s", async (_label, value, ok) => {
        const run = () => intent({ description: value });
        if (ok) await expect(run()).resolves.toBeDefined();
        else expect(await fieldsOf({ description: value })).toEqual(["description"]);
    });

    it.each([[null], [5], [true], [["a"]], [{}]])("should reject a description that is not a string (%j), including JSON null", async (value) => {
        expect(await fieldsOf({ description: value })).toEqual(["description"]);
    });

    it.each(["objectKey", "recordId", "uploadedByUserId", "fileType", "sizeBytes", "documentType", "id", "downloadUrl"])("should reject the unknown member %s as not allowed", async (name) => {
        const err = await failure({ [name]: 1 });
        expect(err.code).toBe("ValidationFailed");
        expect(err.details).toEqual([{ field: name, issue: "is not allowed" }]);
    });

    it.each([[null], [[]], ["text"], [5]])("should reject a body that is not a JSON object (%j)", async (body) => {
        expect(await fieldsOf(body)).toEqual(["body"]);
    });

    it("should never echo a rejected description in the error", async () => {
        const err = await failure({ description: `${ATTACH_DESC}\u0000` });
        expect(JSON.stringify(err.details)).not.toContain("SYNTHETIC");
        expect(JSON.stringify(err)).not.toContain(ATTACH_DESC);
    });
});

describe("RecordAttachmentResponseDto.from", () => {
    const FORBIDDEN_KEYS = ["objectKey", "downloadUrl", "url", "uploadedByUserId", "deletedAt", "attachmentDescription", "quarantineKey"];

    it.each([[{ userId: 101, role: "patient" as const }], [{ userId: 202, role: "doctor" as const }], [{ userId: 204, role: "doctor" as const }]])(
        "should render the same metadata shape for the viewer %j", (viewer) => {
            const dto = RecordAttachmentResponseDto.from(attachmentEntity(), viewer);
            expect(dto).toEqual({ id: 41, recordId: 9, fileType: "application/pdf", sizeBytes: 2048, description: ATTACH_DESC, createdAt: new Date(NOW).toISOString() });
            expect(Object.keys(dto)).toEqual(["id", "recordId", "fileType", "sizeBytes", "description", "createdAt"]);
        });

    it("should throw for an admin viewer (no DTO has an admin form) without leaking the description", () => {
        let thrown: unknown;
        try { RecordAttachmentResponseDto.from(attachmentEntity(), { userId: 303, role: "admin" }); } catch (error) { thrown = error; }
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toBe("record_attachment_viewer_not_permitted");
        expect((thrown as Error).message).not.toContain(ATTACH_DESC);
    });

    it("should render a null description as null", () => {
        expect(RecordAttachmentResponseDto.from(attachmentEntity({ attachmentDescription: null }), { userId: 101, role: "patient" }).description).toBeNull();
    });

    it("should render createdAt as an ISO-8601 UTC string", () => {
        const dto = RecordAttachmentResponseDto.from(attachmentEntity({ createdAt: new Date("2030-03-04T05:06:07.000Z") }), { userId: 101, role: "patient" });
        expect(dto.createdAt).toBe("2030-03-04T05:06:07.000Z");
    });

    it("should expose no object key, URL, uploader, deletion time or storage key anywhere in the serialised response", () => {
        const dto = RecordAttachmentResponseDto.from(attachmentEntity(), { userId: 202, role: "doctor" });
        for (const key of FORBIDDEN_KEYS) expect(dto).not.toHaveProperty(key);
        const text = JSON.stringify(dto);
        for (const value of [OBJECT_KEY, "record-attachments/", "quarantine/", "http", "202"]) expect(text).not.toContain(value);
    });

    it("should render from a summary that carries no uploader or key (the list path)", () => {
        const summary = { id: 5, recordId: 9, fileType: "image/png", sizeBytes: 10, attachmentDescription: null, createdAt: new Date(NOW) };
        expect(RecordAttachmentResponseDto.from(summary, { userId: 101, role: "patient" })).toEqual({ id: 5, recordId: 9, fileType: "image/png", sizeBytes: 10, description: null, createdAt: new Date(NOW).toISOString() });
    });
});
