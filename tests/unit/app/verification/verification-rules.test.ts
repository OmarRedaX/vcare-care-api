import { validateBody, validateParams, validateQuery } from "../../../../src/lib/validation/validate";
import { detectFileType } from "../../../../src/pkg/utils/detect-file-type";
import { ApplicationApproveDto, ApplicationQueueQueryDto, ApplicationRejectDto, UploadIdParamsDto, UploadVerificationIntentRequestDto } from "../../../../src/app/verification/dto/verification.request.dto";
import { VerificationApplicationResponseDto } from "../../../../src/app/verification/dto/verification.response.dto";
import { VerificationDocument } from "../../../../src/app/verification/entity/verification-document.entity";
import { DoctorProfile } from "../../../../src/app/doctors/entity/doctor-profile.entity";

describe("verification DTO and file rules", () => {
    it.each([
        ["PDF", [0x25, 0x50, 0x44, 0x46, 0x2d], "application/pdf"],
        ["JPEG", [0xff, 0xd8, 0xff], "image/jpeg"],
        ["PNG", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/png"],
    ] as const)("should detect %s when stored leading bytes match", (_name, bytes, expected) => {
        expect(detectFileType(Uint8Array.from(bytes))).toBe(expected);
        expect(detectFileType(Uint8Array.from(bytes.slice(0, -1)))).toBeNull();
    });

    it("completeRejectsFalsePdfAndWritesNoRow: should reject short and false PDF signatures", () => {
        expect(detectFileType(Buffer.from("not a PDF"))).toBeNull();
        expect(detectFileType(Buffer.from("%PDF"))).toBeNull();
    });

    it("should reject unknown request members and invalid document types", async () => {
        await expect(validateBody(UploadVerificationIntentRequestDto, { type: "license", ownerUserId: 12 })).rejects.toMatchObject({ code: "ValidationFailed" });
        await expect(validateBody(UploadVerificationIntentRequestDto, { type: "exe" })).rejects.toMatchObject({ code: "ValidationFailed" });
    });

    it("should count reason code points and reject control characters", async () => {
        await expect(validateBody(ApplicationRejectDto, { reason: "😀😀😀" })).resolves.toMatchObject({ reason: "😀😀😀" });
        await expect(validateBody(ApplicationRejectDto, { reason: "ab" })).rejects.toMatchObject({ code: "ValidationFailed" });
        await expect(validateBody(ApplicationRejectDto, { reason: "   " })).rejects.toMatchObject({ code: "ValidationFailed" });
        await expect(validateBody(ApplicationApproveDto, { note: "   " })).rejects.toMatchObject({ code: "ValidationFailed" });
        await expect(validateBody(ApplicationApproveDto, { note: "" })).resolves.toBeDefined();
        await expect(validateBody(ApplicationRejectDto, { reason: "synthetic\u0000reason" })).rejects.toMatchObject({ code: "ValidationFailed" });
        await expect(validateBody(ApplicationRejectDto, { reason: "x".repeat(2001) })).rejects.toMatchObject({ code: "ValidationFailed" });
    });

    it("should explicitly transform numeric path and query fields", async () => {
        expect((await validateParams(UploadIdParamsDto, { uploadId: "17" })).uploadId).toBe(17);
        expect((await validateQuery(ApplicationQueueQueryDto, { limit: "2" })).limit).toBe(2);
        await expect(validateParams(UploadIdParamsDto, { uploadId: "1.5" })).rejects.toMatchObject({ code: "ValidationFailed" });
        await expect(validateQuery(ApplicationQueueQueryDto, { limit: "101" })).rejects.toMatchObject({ code: "ValidationFailed" });
    });

    it("applicationViewsOmitStorageSecrets: should expose only document metadata and doctor-only requirements", () => {
        const profile = new DoctorProfile({ id: 1, userId: 22, verificationStatus: "draft" as DoctorProfile["verificationStatus"], identitySyncStatus: "not_required" as DoctorProfile["identitySyncStatus"] });
        const document = new VerificationDocument({ id: 3, doctorProfileId: 1, type: "license" as VerificationDocument["type"], status: "uploaded" as VerificationDocument["status"], objectKey: "verification-documents/synthetic-secret", fileType: "application/pdf", sizeBytes: 5, reviewNote: null, createdAt: new Date("2026-01-01T00:00:00Z") });
        const view = { profile, documents: [document], doctor: { displayName: null, avatarUrl: null, profileHydrated: false }, missingRequirements: ["id_document"] };
        const admin = VerificationApplicationResponseDto.from(view, "admin");
        const doctor = VerificationApplicationResponseDto.from(view, "doctor");
        expect(admin).not.toHaveProperty("missingRequirements");
        expect(doctor.missingRequirements).toEqual(["id_document"]);
        expect(JSON.stringify(admin)).not.toMatch(/objectKey|downloadUrl|synthetic-secret/);
    });
});
