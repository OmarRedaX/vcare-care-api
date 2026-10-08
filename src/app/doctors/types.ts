import type { UserPolicy } from "../../lib/rbac/types";
import type { DoctorProfile } from "./entity/doctor-profile.entity";
import type { IdentitySyncStatus, VerificationStatus, DoctorProfileField } from "./enums";

export interface DoctorProfileRow {
    id: number; user_id: number; headline: string; bio: string | null; years_experience: number;
    consultation_fee: number; currency: string; default_slot_minutes: number; timezone: string;
    is_accepting_patients: boolean; verification_status: VerificationStatus; submitted_at: Date | null;
    reviewed_by: number | null; review_note: string | null; decided_at: Date | null;
    identity_sync_status: IdentitySyncStatus; suspended_at: Date | null; suspended_by: number | null;
    suspension_reason: string | null; created_at: Date; updated_at: Date;
}
export interface MoneyInput { amount: number; currency: string }
export interface DoctorProfileInput {
    headline: string; bio?: string; yearsExperience: number; languages: string[]; specialtyIds: number[];
    primarySpecialtyId: number; consultationFee: MoneyInput; defaultSlotMinutes: number; timezone: string; submit: boolean;
}
export interface DoctorProfileChanges {
    headline?: string; bio?: string | null; yearsExperience?: number; languages?: string[]; specialtyIds?: number[];
    primarySpecialtyId?: number; consultationFee?: MoneyInput; defaultSlotMinutes?: number; timezone?: string;
    isAcceptingPatients?: boolean;
}
export interface DoctorProfileColumnChanges {
    headline?: string; bio?: string | null; years_experience?: number; consultation_fee?: number; currency?: string;
    default_slot_minutes?: number; timezone?: string; is_accepting_patients?: boolean;
}
export interface SpecialtyLink { specialtyId: number; isPrimary: boolean }
export interface DoctorLanguageRow { language_code: string }
export interface DoctorSpecialtyLinkRow { specialty_id: number; is_primary: boolean }
export interface SpecialtyRef { id: number; slug: string; name: string; isPrimary: boolean }
export interface DoctorProfileView { profile: DoctorProfile; languages: string[]; specialties: SpecialtyRef[]; hasActiveConsultationType: boolean }
export interface DoctorProfileDiff { fields: DoctorProfileField[]; columns: DoctorProfileColumnChanges; languages?: string[]; specialtyIds?: number[]; primarySpecialtyId?: number }
export interface ApplyResult { view: DoctorProfileView; created: boolean; status?: 200 | 201 | 202; identitySync?: "pending" | "failed" }
export type DoctorsRoute = "apply" | "getMe" | "updateMe" | "getApplication";
export type DoctorsPolicies = Readonly<Record<DoctorsRoute, UserPolicy>>;
