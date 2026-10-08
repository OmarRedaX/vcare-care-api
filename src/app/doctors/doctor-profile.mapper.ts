import { DoctorProfile } from "./entity/doctor-profile.entity";
import type { DoctorProfileRow } from "./types";

/** Shared by the doctors and verification repositories, which both read `doctor_profiles`: one column list, one mapper. */
export const DOCTOR_PROFILE_COLUMNS = ["id", "user_id", "headline", "bio", "years_experience", "consultation_fee", "currency",
    "default_slot_minutes", "timezone", "is_accepting_patients", "verification_status", "submitted_at", "reviewed_by", "review_note",
    "decided_at", "identity_sync_status", "suspended_at", "suspended_by", "suspension_reason", "created_at", "updated_at"] as const;

export function toDoctorProfile(row: DoctorProfileRow): DoctorProfile {
    return new DoctorProfile({ id: row.id, userId: row.user_id, headline: row.headline, bio: row.bio,
        yearsExperience: row.years_experience, consultationFeeAmount: row.consultation_fee, currency: row.currency,
        defaultSlotMinutes: row.default_slot_minutes, timezone: row.timezone, isAcceptingPatients: row.is_accepting_patients,
        verificationStatus: row.verification_status, submittedAt: row.submitted_at, reviewedBy: row.reviewed_by,
        reviewNote: row.review_note, decidedAt: row.decided_at, identitySyncStatus: row.identity_sync_status,
        suspendedAt: row.suspended_at, suspendedBy: row.suspended_by, suspensionReason: row.suspension_reason,
        createdAt: row.created_at, updatedAt: row.updated_at });
}
