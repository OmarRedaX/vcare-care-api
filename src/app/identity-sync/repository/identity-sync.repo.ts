import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";
import { DOCTOR_PROFILE_COLUMNS, toDoctorProfile } from "../../doctors/doctor-profile.mapper";
import type { DoctorProfile } from "../../doctors/entity/doctor-profile.entity";
import type { IdentitySyncStatus } from "../../doctors/enums";
import type { DoctorProfileRow } from "../../doctors/types";
import { IDENTITY_SYNC_BATCH } from "../constants";
import { IdentitySyncJobKind, IdentitySyncJobStatus } from "../enums";
import type { IdentitySyncJobRow } from "../types";

export const JOB_COLUMNS = ["id", "doctor_profile_id", "doctor_user_id", "kind", "target_status", "reason", "actor_user_id", "request_id", "status", "attempts", "consecutive_failures", "last_error_code", "next_attempt_at", "succeeded_at", "created_at", "updated_at"] as const;

export async function insertSyncJob(row: Pick<IdentitySyncJobRow, "doctor_profile_id" | "doctor_user_id" | "kind" | "target_status" | "reason" | "actor_user_id" | "request_id" | "status" | "next_attempt_at">, conn: Knex = db): Promise<IdentitySyncJobRow> { const rows: IdentitySyncJobRow[] = await conn<IdentitySyncJobRow>("identity_sync_jobs").insert(row).returning([...JOB_COLUMNS]); const inserted = rows[0]; if (!inserted) throw new Error("job_insert_empty"); return inserted; }
export async function findSyncJob(id: number, conn: Knex = db): Promise<IdentitySyncJobRow | undefined> { return conn<IdentitySyncJobRow>("identity_sync_jobs").select(...JOB_COLUMNS).where({ id }).first(); }
export async function findPendingSyncJob(profileId: number, conn: Knex = db): Promise<IdentitySyncJobRow | undefined> { return conn<IdentitySyncJobRow>("identity_sync_jobs").select(...JOB_COLUMNS).where({ doctor_profile_id: profileId, status: IdentitySyncJobStatus.Pending }).first(); }
/** Latest job of a profile, any status (no-op re-reports). Served by `idx_identity_sync_jobs_doctor_profile_id_created_at` (`doctor_profile_id, created_at DESC`); `id DESC` only breaks ties. */
export async function findLatestSyncJob(profileId: number, conn: Knex = db): Promise<IdentitySyncJobRow | undefined> { return conn<IdentitySyncJobRow>("identity_sync_jobs").select(...JOB_COLUMNS).where("doctor_profile_id", profileId).orderBy([{ column: "created_at", order: "desc" }, { column: "id", order: "desc" }]).first(); }
export async function supersedePendingSyncJob(profileId: number, conn: Knex = db): Promise<void> { await conn("identity_sync_jobs").where({ doctor_profile_id: profileId, status: IdentitySyncJobStatus.Pending }).update({ status: IdentitySyncJobStatus.Superseded, updated_at: conn.fn.now() }); }
/** `updated_at` defaults to the DB clock; the engine passes its own timing value on transient failures so alert windows follow the injected clock. */
export async function updateSyncJob(id: number, changes: Partial<IdentitySyncJobRow>, conn: Knex = db): Promise<void> { await conn("identity_sync_jobs").where({ id }).update({ updated_at: conn.fn.now(), ...changes }); }
/**
 * Due = pending and past `now`. A plain read: the per-doctor lock plus the due re-check in the service are the claim.
 * Suspension jobs first (a black-hole outage can make a tick slow; the security-critical kind must not queue behind the rest).
 * Filter: `idx_identity_sync_jobs_pending_next_attempt_at`; the sort runs on the small due set.
 */
export async function listDuePendingJobs(limit: number, now: Date, conn: Knex = db): Promise<IdentitySyncJobRow[]> { return conn<IdentitySyncJobRow>("identity_sync_jobs").select(...JOB_COLUMNS).where("status", IdentitySyncJobStatus.Pending).where("next_attempt_at", "<=", now).orderByRaw("(kind = ?) DESC, next_attempt_at ASC, id ASC", [IdentitySyncJobKind.Suspension]).limit(Math.min(IDENTITY_SYNC_BATCH, Math.max(1, limit))); }

export async function findProfileForSync(id: number, conn: Knex = db, lock = false): Promise<DoctorProfile | undefined> { let query = conn<DoctorProfileRow>("doctor_profiles").select(...DOCTOR_PROFILE_COLUMNS).where({ id }).whereNull("deleted_at"); if (lock) query = query.forUpdate(); const row = await query.first(); return row ? toDoctorProfile(row) : undefined; }
export async function setProfileIdentitySync(id: number, status: IdentitySyncStatus, conn: Knex = db): Promise<void> { await conn("doctor_profiles").where({ id }).whereNull("deleted_at").update({ identity_sync_status: status, updated_at: conn.fn.now() }); }
