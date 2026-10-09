import type { DoctorProfile } from "../doctors/entity/doctor-profile.entity";
import type { IdentitySyncJobKind, IdentitySyncJobStatus } from "./enums";

export type IdentityTargetStatus = "active" | "rejected" | "pending" | "suspended";

export interface IdentitySyncJobRow { id: number; doctor_profile_id: number; doctor_user_id: number; kind: IdentitySyncJobKind; target_status: IdentityTargetStatus; reason: string | null; actor_user_id: number; request_id: string | null; status: IdentitySyncJobStatus; attempts: number; consecutive_failures: number; last_error_code: string | null; next_attempt_at: Date; succeeded_at: Date | null; created_at: Date; updated_at: Date }

/** What a decision transaction hands the engine to open a job. `next_attempt_at` is stamped by the engine from its timing. */
export interface EnqueueSyncJob { profile: Pick<DoctorProfile, "id" | "userId">; kind: IdentitySyncJobKind; targetStatus: IdentityTargetStatus; reason: string; actorUserId: number; requestId: string }

/** `attempt` outcome: which profile was synced, and whether this caller held the per-doctor lock (false = someone else is syncing). */
export interface SyncAttempt { profileId: number; locked: boolean }

/** What an inline caller reports back: the profile after the attempt and the HTTP-level outcome (200 synced, 202 pending/failed). */
export interface SyncReport { profile: DoctorProfile; status: 200 | 202; identitySync?: "pending" | "failed" }

/** Clock and randomness of the engine; production uses `SYSTEM_SYNC_TIMING`, tests a fake. */
export interface SyncTiming { now(): number; random(): number }

export interface TransientFailureContext { job: IdentitySyncJobRow; consecutiveFailures: number; lastErrorCode: string; nowMs: number }
export interface SyncAlert { message: string; fields: Record<string, string | number> }
/** Per-kind behaviour; the engine selects `policies[job.kind]` and knows nothing else about a kind. */
export interface SyncKindPolicy { alertOnTransient(context: TransientFailureContext): SyncAlert | null }
export type SyncPolicies = Record<IdentitySyncJobKind, SyncKindPolicy>;
