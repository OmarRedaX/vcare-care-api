import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";
import { timestampCursorSelect } from "../../../lib/http/pagination/timestamp-cursor";
import { DOCTOR_PROFILE_COLUMNS, toDoctorProfile } from "../../doctors/doctor-profile.mapper";
import type { DoctorProfile } from "../../doctors/entity/doctor-profile.entity";
import { IdentitySyncStatus, VerificationStatus } from "../../doctors/enums";
import type { DoctorProfileRow } from "../../doctors/types";
import { VerificationDocument } from "../entity/verification-document.entity";
import { IdentitySyncJobStatus } from "../enums";
import type { IdentitySyncJobRow, ProfileDecisionChanges, QueuePosition, QueueQuery, QueueRow, QueueRowShape, UploadIntentRow, VerificationDocumentRow } from "../types";

export const QUEUE_NULL_TIMESTAMP = "9999-12-31T23:59:59.999999Z";
export const DOCUMENT_COLUMNS = ["id", "doctor_profile_id", "type", "object_key", "file_type", "size_bytes", "status", "reviewed_by", "review_note", "created_at", "updated_at", "deleted_at"] as const;
export const INTENT_COLUMNS = ["id", "kind", "target_id", "owner_user_id", "document_type", "description", "quarantine_key", "max_bytes", "expires_at", "consumed_at", "result_id", "created_at"] as const;
export const JOB_COLUMNS = ["id", "doctor_profile_id", "doctor_user_id", "kind", "target_status", "reason", "actor_user_id", "request_id", "status", "attempts", "consecutive_failures", "last_error_code", "next_attempt_at", "succeeded_at", "created_at", "updated_at"] as const;

function toEntity(row: VerificationDocumentRow): VerificationDocument { return new VerificationDocument({ id: row.id, doctorProfileId: row.doctor_profile_id, type: row.type, objectKey: row.object_key, fileType: row.file_type, sizeBytes: row.size_bytes, status: row.status, reviewedBy: row.reviewed_by, reviewNote: row.review_note, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at }); }
export async function findDocument(id: number, conn: Knex = db): Promise<VerificationDocument | undefined> { const row: VerificationDocumentRow | undefined = await conn<VerificationDocumentRow>("verification_documents").select(...DOCUMENT_COLUMNS).where({ id }).whereNull("deleted_at").first(); return row && toEntity(row); }
export async function findDocumentForUpdate(id: number, conn: Knex = db): Promise<VerificationDocument | undefined> { const row: VerificationDocumentRow | undefined = await conn<VerificationDocumentRow>("verification_documents").select(...DOCUMENT_COLUMNS).where({ id }).whereNull("deleted_at").forUpdate().first(); return row && toEntity(row); }
export async function listDocuments(profileId: number, conn: Knex = db): Promise<VerificationDocument[]> { const rows: VerificationDocumentRow[] = await conn<VerificationDocumentRow>("verification_documents").select(...DOCUMENT_COLUMNS).where("doctor_profile_id", profileId).whereNull("deleted_at").orderBy("id"); return rows.map(toEntity); }
export async function listDocumentsBatch(profileIds: number[], conn: Knex = db): Promise<Map<number, VerificationDocument[]>> { const result = new Map<number, VerificationDocument[]>(); if (!profileIds.length) return result; const rows: VerificationDocumentRow[] = await conn<VerificationDocumentRow>("verification_documents").select(...DOCUMENT_COLUMNS).whereRaw("doctor_profile_id = ANY(?::bigint[])", [profileIds]).whereNull("deleted_at").orderBy("id"); for (const row of rows) { const list = result.get(row.doctor_profile_id) ?? []; list.push(toEntity(row)); result.set(row.doctor_profile_id, list); } return result; }
export async function insertDocument(row: Pick<VerificationDocumentRow, "doctor_profile_id" | "type" | "object_key" | "file_type" | "size_bytes" | "status">, conn: Knex = db): Promise<VerificationDocument> { const rows: VerificationDocumentRow[] = await conn<VerificationDocumentRow>("verification_documents").insert(row).returning([...DOCUMENT_COLUMNS]); const inserted = rows[0]; if (!inserted) throw new Error("document_insert_empty"); return toEntity(inserted); }
export async function softDeleteDocument(id: number, conn: Knex = db): Promise<void> { await conn("verification_documents").where({ id }).whereNull("deleted_at").update({ deleted_at: conn.fn.now(), updated_at: conn.fn.now() }); }

export async function insertIntent(row: Pick<UploadIntentRow, "kind" | "target_id" | "owner_user_id" | "document_type" | "description" | "quarantine_key" | "max_bytes" | "expires_at">, conn: Knex = db): Promise<UploadIntentRow> { const rows: UploadIntentRow[] = await conn<UploadIntentRow>("upload_intents").insert(row).returning([...INTENT_COLUMNS]); const inserted = rows[0]; if (!inserted) throw new Error("intent_insert_empty"); return inserted; }
export async function findIntent(id: number, conn: Knex = db): Promise<UploadIntentRow | undefined> { return conn<UploadIntentRow>("upload_intents").select(...INTENT_COLUMNS).where({ id }).first(); }
export async function findIntentForUpdate(id: number, conn: Knex = db): Promise<UploadIntentRow | undefined> { return conn<UploadIntentRow>("upload_intents").select(...INTENT_COLUMNS).where({ id }).forUpdate().first(); }
export async function closeIntent(id: number, resultId: number | null = null, conn: Knex = db): Promise<void> { await conn("upload_intents").where({ id }).whereNull("consumed_at").update({ consumed_at: conn.fn.now(), result_id: resultId }); }
export async function listExpiredOpenIntents(limit = 500, conn: Knex = db): Promise<UploadIntentRow[]> { return conn<UploadIntentRow>("upload_intents").select(...INTENT_COLUMNS).where("kind", "verification_document").whereNull("consumed_at").where("expires_at", "<=", conn.fn.now()).orderBy("expires_at").limit(Math.min(500, Math.max(1, limit))); }
export async function deleteIntentsOlderThan(cutoff: Date, limit = 500, conn: Knex = db): Promise<number> { const ids: { id: number }[] = await conn<{ id: number }>("upload_intents").select("id").where("created_at", "<", cutoff).whereNotNull("consumed_at").orderBy("created_at").limit(Math.min(500, Math.max(1, limit))); if (!ids.length) return 0; return conn("upload_intents").whereIn("id", ids.map((row) => row.id)).delete(); }

export async function insertSyncJob(row: Pick<IdentitySyncJobRow, "doctor_profile_id" | "doctor_user_id" | "kind" | "target_status" | "reason" | "actor_user_id" | "request_id" | "status" | "next_attempt_at">, conn: Knex = db): Promise<IdentitySyncJobRow> { const rows: IdentitySyncJobRow[] = await conn<IdentitySyncJobRow>("identity_sync_jobs").insert(row).returning([...JOB_COLUMNS]); const inserted = rows[0]; if (!inserted) throw new Error("job_insert_empty"); return inserted; }
export async function findSyncJob(id: number, conn: Knex = db): Promise<IdentitySyncJobRow | undefined> { return conn<IdentitySyncJobRow>("identity_sync_jobs").select(...JOB_COLUMNS).where({ id }).first(); }
export async function findPendingSyncJob(profileId: number, conn: Knex = db): Promise<IdentitySyncJobRow | undefined> { return conn<IdentitySyncJobRow>("identity_sync_jobs").select(...JOB_COLUMNS).where({ doctor_profile_id: profileId, status: IdentitySyncJobStatus.Pending }).first(); }
export async function supersedePendingSyncJob(profileId: number, conn: Knex = db): Promise<void> { await conn("identity_sync_jobs").where({ doctor_profile_id: profileId, status: IdentitySyncJobStatus.Pending }).update({ status: IdentitySyncJobStatus.Superseded, updated_at: conn.fn.now() }); }
export async function updateSyncJob(id: number, changes: Partial<IdentitySyncJobRow>, conn: Knex = db): Promise<void> { await conn("identity_sync_jobs").where({ id }).update({ ...changes, updated_at: conn.fn.now() }); }
/** Due = pending and past `next_attempt_at`. A plain read: the per-doctor lock plus the due re-check in the service are the claim. */
export async function listDuePendingJobs(limit = 50, conn: Knex = db): Promise<IdentitySyncJobRow[]> { return conn<IdentitySyncJobRow>("identity_sync_jobs").select(...JOB_COLUMNS).where("status", IdentitySyncJobStatus.Pending).where("kind", "verification").where("next_attempt_at", "<=", conn.fn.now()).orderBy("next_attempt_at").limit(Math.min(50, Math.max(1, limit))); }

export async function findProfileById(id: number, conn: Knex = db, lock = false): Promise<DoctorProfile | undefined> { let query = conn<DoctorProfileRow>("doctor_profiles").select(...DOCTOR_PROFILE_COLUMNS).where({ id }).whereNull("deleted_at"); if (lock) query = query.forUpdate(); const row = await query.first(); return row ? toDoctorProfile(row) : undefined; }
export async function findProfileByUserId(userId: number, conn: Knex = db, lock = false): Promise<DoctorProfile | undefined> { let query = conn<DoctorProfileRow>("doctor_profiles").select(...DOCTOR_PROFILE_COLUMNS).where({ user_id: userId }).whereNull("deleted_at"); if (lock) query = query.forUpdate(); const row = await query.first(); return row ? toDoctorProfile(row) : undefined; }
export async function touchProfile(id: number, conn: Knex = db): Promise<void> { await conn("doctor_profiles").where({ id }).whereNull("deleted_at").update({ updated_at: conn.fn.now() }); }
export async function isProfileLocallySuspended(userId: number, conn: Knex = db): Promise<boolean> { const row: { id: number } | undefined = await conn<{ id: number }>("doctor_profiles").select("id").where("user_id", userId).whereNull("deleted_at").whereNotNull("suspended_at").first(); return row !== undefined; }
function queueBase(query: QueueQuery, conn: Knex): Knex.QueryBuilder {
    return conn<QueueRowShape>("doctor_profiles").select(...DOCTOR_PROFILE_COLUMNS, timestampCursorSelect(conn, "submitted_at", "cursor_timestamp")).whereNull("deleted_at").where("verification_status", query.status);
}
function toQueueRows(rows: QueueRowShape[]): QueueRow[] { return rows.map((row) => ({ profile: toDoctorProfile(row), cursorTimestamp: row.cursor_timestamp ?? QUEUE_NULL_TIMESTAMP })); }

/**
 * Keyset page in index order `(submitted_at ASC NULLS LAST, id ASC)`, fetched in two index-friendly phases instead of one
 * `COALESCE`/`OR` predicate (which Postgres can only apply as a filter, reading every earlier row of the status):
 * 1. rows with a timestamp: a bare row comparison `(submitted_at, id) > (?, ?)` is an index condition (NULL never matches it);
 * 2. only if the page is not full: the NULL tail (`submitted_at IS NULL`), ordered by id.
 */
export async function listQueue(query: QueueQuery, position: QueuePosition | undefined, conn: Knex = db): Promise<QueueRow[]> {
    const wanted = query.limit + 1;
    const inNullTail = position?.timestamp === QUEUE_NULL_TIMESTAMP;
    const rows: QueueRow[] = [];
    if (!inNullTail) {
        let timestamped = queueBase(query, conn).whereNotNull("submitted_at");
        if (position) timestamped = timestamped.whereRaw("(submitted_at, id) > (?::timestamptz, ?)", [position.timestamp, position.id]);
        const found: unknown = await timestamped.orderBy([{ column: "submitted_at", order: "asc" }, { column: "id", order: "asc" }]).limit(wanted);
        rows.push(...toQueueRows(found as QueueRowShape[]));
    }
    if (rows.length < wanted) {
        let tail = queueBase(query, conn).whereNull("submitted_at");
        if (position && inNullTail) tail = tail.where("id", ">", position.id);
        const found: unknown = await tail.orderBy("id", "asc").limit(wanted - rows.length);
        rows.push(...toQueueRows(found as QueueRowShape[]));
    }
    return rows;
}

export async function markProfileSubmitted(id: number, resubmit: boolean, conn: Knex = db): Promise<void> {
    await conn("doctor_profiles").where({ id }).whereNull("deleted_at").update({ verification_status: VerificationStatus.Submitted, submitted_at: conn.fn.now(), reviewed_by: null, review_note: null, decided_at: null,
        identity_sync_status: resubmit ? IdentitySyncStatus.Pending : IdentitySyncStatus.NotRequired, updated_at: conn.fn.now() });
}
/** Records an admin decision and parks the account sync as pending until the Identity job succeeds. */
export async function applyProfileDecision(id: number, changes: ProfileDecisionChanges, conn: Knex = db): Promise<void> {
    await conn("doctor_profiles").where({ id }).whereNull("deleted_at").update({ verification_status: changes.verificationStatus, identity_sync_status: IdentitySyncStatus.Pending,
        reviewed_by: changes.reviewedBy, review_note: changes.reviewNote, decided_at: changes.stampDecidedAt ? conn.fn.now() : null,
        ...(changes.stampSubmittedAt ? { submitted_at: conn.fn.now() } : {}), updated_at: conn.fn.now() });
}
export async function setProfileIdentitySync(id: number, status: IdentitySyncStatus, conn: Knex = db): Promise<void> { await conn("doctor_profiles").where({ id }).whereNull("deleted_at").update({ identity_sync_status: status, updated_at: conn.fn.now() }); }
