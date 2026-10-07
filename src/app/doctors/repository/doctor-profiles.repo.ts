import type { Knex } from "knex";
import { db } from "../../../lib/knex/knex";
import { DoctorProfile } from "../entity/doctor-profile.entity";
import { IdentitySyncStatus, VerificationStatus } from "../enums";
import type { DoctorProfileColumnChanges, DoctorProfileInput, DoctorProfileRow } from "../types";

export const DOCTOR_PROFILE_COLUMNS = ["id", "user_id", "headline", "bio", "years_experience", "consultation_fee", "currency",
    "default_slot_minutes", "timezone", "is_accepting_patients", "verification_status", "submitted_at", "reviewed_by", "review_note",
    "decided_at", "identity_sync_status", "suspended_at", "suspended_by", "suspension_reason", "created_at", "updated_at"] as const;

function toEntity(row: DoctorProfileRow): DoctorProfile {
    return new DoctorProfile({ id: row.id, userId: row.user_id, headline: row.headline, bio: row.bio,
        yearsExperience: row.years_experience, consultationFeeAmount: row.consultation_fee, currency: row.currency,
        defaultSlotMinutes: row.default_slot_minutes, timezone: row.timezone, isAcceptingPatients: row.is_accepting_patients,
        verificationStatus: row.verification_status, submittedAt: row.submitted_at, reviewedBy: row.reviewed_by,
        reviewNote: row.review_note, decidedAt: row.decided_at, identitySyncStatus: row.identity_sync_status,
        suspendedAt: row.suspended_at, suspendedBy: row.suspended_by, suspensionReason: row.suspension_reason,
        createdAt: row.created_at, updatedAt: row.updated_at });
}

export async function findProfileByUserId(userId: number, conn: Knex = db): Promise<DoctorProfile | undefined> {
    const row: DoctorProfileRow | undefined = await conn<DoctorProfileRow>("doctor_profiles")
        .select(...DOCTOR_PROFILE_COLUMNS).where("user_id", userId).whereNull("deleted_at").first();
    return row === undefined ? undefined : toEntity(row);
}

export async function findProfileByUserIdForUpdate(userId: number, conn: Knex.Transaction): Promise<DoctorProfile | undefined> {
    const row: DoctorProfileRow | undefined = await conn<DoctorProfileRow>("doctor_profiles")
        .select(...DOCTOR_PROFILE_COLUMNS).where("user_id", userId).whereNull("deleted_at").forUpdate().first();
    return row === undefined ? undefined : toEntity(row);
}

export async function insertProfile(userId: number, input: DoctorProfileInput, timezone: string, conn: Knex.Transaction): Promise<DoctorProfile> {
    const rows: DoctorProfileRow[] = await conn<DoctorProfileRow>("doctor_profiles").insert({
        user_id: userId, headline: input.headline, bio: input.bio ?? null, years_experience: input.yearsExperience,
        consultation_fee: input.consultationFee.amount, currency: input.consultationFee.currency,
        default_slot_minutes: input.defaultSlotMinutes, timezone, is_accepting_patients: true,
        verification_status: VerificationStatus.Draft, identity_sync_status: IdentitySyncStatus.NotRequired,
    }).returning([...DOCTOR_PROFILE_COLUMNS]);
    const row = rows[0];
    if (row === undefined) throw new Error("doctor_profile_insert_returned_no_row");
    return toEntity(row);
}

export async function updateProfile(id: number, changes: DoctorProfileColumnChanges, conn: Knex.Transaction): Promise<DoctorProfile> {
    const rows: DoctorProfileRow[] = await conn<DoctorProfileRow>("doctor_profiles")
        .where("id", id).whereNull("deleted_at").update({ ...changes, updated_at: conn.fn.now() })
        .returning([...DOCTOR_PROFILE_COLUMNS]);
    const row = rows[0];
    if (row === undefined) throw new Error("doctor_profile_update_returned_no_row");
    return toEntity(row);
}

export async function isUserLocallySuspended(userId: number, conn: Knex = db): Promise<boolean> {
    const row: Pick<DoctorProfileRow, "id"> | undefined = await conn<DoctorProfileRow>("doctor_profiles")
        .select("id").where("user_id", userId).whereNull("deleted_at").whereNotNull("suspended_at").first();
    return row !== undefined;
}
