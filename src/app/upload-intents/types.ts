import type { Knex } from "knex";
import type { UploadIntentKind } from "./enums";

export interface UploadIntentRow { id: number; kind: string; target_id: number; owner_user_id: number; document_type: string | null; description: string | null; quarantine_key: string; max_bytes: number; expires_at: Date; consumed_at: Date | null; result_id: number | null; created_at: Date }
export interface UploadIntentResult { uploadId: number; url: string; fields: Record<string, string>; expiresAt: string; maxBytes: number }
export interface ExpiredIntentRef { id: number; quarantineKey: string }
/** What a module hands to `UploadIntentsService.create`; authorization of the target is the caller's. */
export interface NewIntent { kind: UploadIntentKind; targetId: number; ownerUserId: number; documentType: string | null; description: string | null }
/** The only content types `complete` accepts (detected from the stored bytes, never declared). */
export type DetectedFileType = "application/pdf" | "image/jpeg" | "image/png";
/** What `insertResult` receives inside the shared transaction: the re-read (locked) intent and the verified object. */
export interface UploadInsertInput { intent: UploadIntentRow; finalKey: string; fileType: DetectedFileType; sizeBytes: number }
export interface InsertedUpload<TRow> { row: TRow; id: number }
export interface CompletedUpload<TRow> { row: TRow; replay: boolean }
/**
 * One `complete` call. The shared flow owns the lock, the intent checks, the storage verification and the intent close;
 * the module supplies its target rules through the callbacks (statement and storage order are fixed by the service).
 */
export interface CompleteRequest<TRow, TTarget> {
    uploadId: number;
    kind: UploadIntentKind;
    ownerUserId: number;
    finalKeyPrefix: string;
    /** Resolves the intent's target and checks the caller may complete it; throws `NotFound`/`Forbidden`. */
    authorizeTarget(intent: UploadIntentRow, conn: Knex): Promise<TTarget>;
    /** Replay lookup of the row an earlier `complete` created (`undefined` = no longer live). */
    findResult(resultId: number, conn: Knex): Promise<TRow | undefined>;
    /** Module preconditions evaluated after the expiry check and before any storage inspection. */
    precheck(target: TTarget, conn: Knex): Promise<void>;
    /** Inserts the module's row (and its audit row) inside the shared short transaction. */
    insertResult(input: UploadInsertInput, trx: Knex.Transaction): Promise<InsertedUpload<TRow>>;
}
