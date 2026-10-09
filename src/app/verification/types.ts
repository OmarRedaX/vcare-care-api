import type { UserPolicy } from "../../lib/rbac/types";
import type { VerificationStatus } from "../doctors/enums";
import type { DoctorProfile } from "../doctors/entity/doctor-profile.entity";
import type { DoctorProfileRow } from "../doctors/types";
import type { VerificationDocumentType, VerificationDocumentStatus } from "./enums";
import type { VerificationDocument } from "./entity/verification-document.entity";

export interface VerificationDocumentRow { id: number; doctor_profile_id: number; type: VerificationDocumentType; object_key: string; file_type: string; size_bytes: number; status: VerificationDocumentStatus; reviewed_by: number | null; review_note: string | null; created_at: Date; updated_at: Date; deleted_at: Date | null }
export interface UploadIntentRow { id: number; kind: string; target_id: number; owner_user_id: number; document_type: VerificationDocumentType | null; description: string | null; quarantine_key: string; max_bytes: number; expires_at: Date; consumed_at: Date | null; result_id: number | null; created_at: Date }
export interface VerificationApplicationView { profile: DoctorProfile; documents: VerificationDocument[]; doctor: { displayName: string | null; avatarUrl: string | null; profileHydrated: boolean }; specialties?: { id: number; slug: string; name: string; isPrimary: boolean }[]; missingRequirements?: string[] }
export interface QueueQuery { status: string; cursor?: string; limit: number }
export interface QueuePage { items: VerificationApplicationView[]; meta: { nextCursor: string | null; hasMore: boolean; count: number } }
export interface DocumentCompletion { document: VerificationDocument; replay: boolean }
export interface DecisionResult { view: VerificationApplicationView; status: 200 | 202; identitySync?: "pending" | "failed" }
export interface SubmitTransition { jobId: number | null }
export interface QueueCursorPayload { status: string; timestamp: string; id: number }
export interface QueuePosition { timestamp: string; id: number }
export type QueueRowShape = DoctorProfileRow & { cursor_timestamp: string | null };
export interface QueueRow { profile: DoctorProfile; cursorTimestamp: string }
export interface UploadIntentResult { uploadId: number; url: string; fields: Record<string, string>; expiresAt: string; maxBytes: number }
export interface ExpiredIntentRef { id: number; quarantineKey: string }
/** What a resubmit reports back to the doctors service: status only, never an Identity-hydrated view. */
export interface SubmitSyncResult { status: 200 | 202; identitySync?: "pending" | "failed" }
/** Admin decision written onto `doctor_profiles`; the repository stamps `decided_at` / `submitted_at` with the DB clock. */
export interface ProfileDecisionChanges { verificationStatus: VerificationStatus; reviewedBy: number | null; reviewNote: string | null; stampDecidedAt: boolean; stampSubmittedAt: boolean }
export interface VerificationPolicies { createIntent: UserPolicy; complete: UserPolicy; myDownload: UserPolicy; myDelete: UserPolicy; queue: UserPolicy; detail: UserPolicy; adminDownload: UserPolicy; approve: UserPolicy; reject: UserPolicy; reopen: UserPolicy }
