import type { VerificationDocument } from "../entity/verification-document.entity";
import type { VerificationApplicationView } from "../types";

export class VerificationDocumentResponseDto {
    id!: number; type!: string; status!: string; fileType!: string; sizeBytes!: number; reviewNote!: string | null; uploadedAt!: string;
    static from(document: VerificationDocument): VerificationDocumentResponseDto { return { id: document.id, type: document.type, status: document.status, fileType: document.fileType, sizeBytes: document.sizeBytes, reviewNote: document.reviewNote, uploadedAt: document.createdAt.toISOString() }; }
}
export class VerificationApplicationResponseDto {
    id!: number; doctorUserId!: number; doctor!: VerificationApplicationView["doctor"]; status!: string; identitySyncStatus!: string;
    submittedAt!: string | null; decidedAt!: string | null; reviewedBy!: number | null; reviewNote!: string | null;
    documents!: VerificationDocumentResponseDto[]; specialties?: VerificationApplicationView["specialties"]; yearsExperience?: number; missingRequirements?: string[];
    static from(view: VerificationApplicationView, viewer: "doctor" | "admin"): VerificationApplicationResponseDto {
        const p = view.profile;
        return { id: p.id, doctorUserId: p.userId, doctor: view.doctor, status: p.verificationStatus, identitySyncStatus: p.identitySyncStatus,
            submittedAt: p.submittedAt?.toISOString() ?? null, decidedAt: p.decidedAt?.toISOString() ?? null, reviewedBy: p.reviewedBy,
            reviewNote: p.reviewNote, documents: view.documents.map((document) => VerificationDocumentResponseDto.from(document)),
            ...(view.specialties ? { specialties: view.specialties } : {}), yearsExperience: p.yearsExperience,
            ...(viewer === "doctor" ? { missingRequirements: view.missingRequirements ?? [] } : {}) };
    }
}
