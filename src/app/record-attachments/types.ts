import type { UserPolicy } from "../../lib/rbac/types";
import type { Role } from "../../lib/types/types";
import type { RecordAttachment } from "./entity/record-attachment.entity";

/** pg returns `TIMESTAMPTZ` as `Date`, `BIGINT` as number (type parser override) and `INT` as number. */
export interface RecordAttachmentRow {
    id: number; medical_record_id: number; uploaded_by_user_id: number; object_key: string; file_type: string; size_bytes: number;
    description: string | null; created_at: Date; deleted_at: Date | null;
}
/** The list path selects these six columns only: no `object_key`, no `uploaded_by_user_id`. */
export interface RecordAttachmentSummaryRow {
    id: number; medical_record_id: number; file_type: string; size_bytes: number; description: string | null; created_at: Date;
}
/** What the record views render; `RecordAttachment` satisfies it. */
export interface RecordAttachmentSummary {
    id: number; recordId: number; fileType: string; sizeBytes: number; attachmentDescription: string | null; createdAt: Date;
}
/** What `complete` inserts; the key and type come from the verified upload, the description from the intent. */
export interface NewRecordAttachment {
    recordId: number; uploadedByUserId: number; objectKey: string; fileType: string; sizeBytes: number; attachmentDescription: string | null;
}
/** A validated intent body. */
export interface RecordAttachmentIntentInput { attachmentDescription: string | null }

export interface AttachmentViewer { userId: number; role: Role }
export interface CompletedAttachment { attachment: RecordAttachment; replay: boolean }

export type RecordAttachmentsRoute = "createIntent" | "complete" | "downloadUrl" | "remove";
export type RecordAttachmentsPolicies = Readonly<Record<RecordAttachmentsRoute, UserPolicy>>;
