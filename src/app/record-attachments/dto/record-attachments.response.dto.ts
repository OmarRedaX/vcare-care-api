import type { AttachmentViewer, RecordAttachmentSummary } from "../types";

/**
 * Metadata only. An admin viewer is a programming error (no DTO has an admin form, Domain rule 19); patients and doctors get the same
 * shape. `uploadedByUserId`, `objectKey` and `deletedAt` are never emitted, and no URL ever appears here (ADR 0014).
 */
export class RecordAttachmentResponseDto {
    id!: number;
    recordId!: number;
    fileType!: string;
    sizeBytes!: number;
    description!: string | null;
    createdAt!: string;

    static from(source: RecordAttachmentSummary, viewer: AttachmentViewer): RecordAttachmentResponseDto {
        if (viewer.role === "admin") throw new Error("record_attachment_viewer_not_permitted");
        return {
            id: source.id, recordId: source.recordId, fileType: source.fileType, sizeBytes: source.sizeBytes,
            description: source.attachmentDescription, createdAt: source.createdAt.toISOString(),
        };
    }
}
