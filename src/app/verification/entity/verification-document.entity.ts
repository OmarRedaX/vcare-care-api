import type { VerificationDocumentType, VerificationDocumentStatus } from "../enums";
export class VerificationDocument {
    id!: number; doctorProfileId!: number; type!: VerificationDocumentType; objectKey!: string;
    fileType!: string; sizeBytes!: number; status!: VerificationDocumentStatus;
    reviewedBy!: number | null; reviewNote!: string | null; createdAt!: Date; updatedAt!: Date; deletedAt!: Date | null;
    constructor(data: Partial<VerificationDocument>) { Object.assign(this, data); }
}
