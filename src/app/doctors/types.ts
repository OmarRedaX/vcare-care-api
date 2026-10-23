import type { UserPolicy } from "../../lib/rbac/types";
import type { DoctorProfile } from "./entity/doctor-profile.entity";
import type { ConsultationType } from "../schedules/entity/consultation-type.entity";
import type { IdentitySyncStatus, VerificationStatus, DoctorProfileField, DoctorChangeKind, CandidateOrder } from "./enums";

export interface SlotDoctor { profileId: number; userId: number; timezone: string; bookableBase: boolean }
export interface SlotDoctorRow { id: number; user_id: number; timezone: string; verification_status: VerificationStatus; identity_sync_status: IdentitySyncStatus; suspended_at: Date | null; is_accepting_patients: boolean }
export interface DoctorChangedEvent { doctorUserId: number; kind: DoctorChangeKind }
export interface DoctorChangeListener { onDoctorChanged(event: DoctorChangedEvent): Promise<void> }

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
/** The doctor as booking needs it: identity of the profile, its zone, and the Domain rule 6 verdict computed under the lock. */
export interface BookingDoctor { profileId: number; userId: number; timezone: string; isBookable: boolean }
export interface SpecialtyLink { specialtyId: number; isPrimary: boolean }
export interface DoctorLanguageRow { language_code: string }
export interface DoctorSpecialtyLinkRow { specialty_id: number; is_primary: boolean }
export interface SpecialtyRef { id: number; slug: string; name: string; isPrimary: boolean }
export interface DoctorProfileView { profile: DoctorProfile; languages: string[]; specialties: SpecialtyRef[]; hasActiveConsultationType: boolean }
export interface DoctorProfileDiff { fields: DoctorProfileField[]; columns: DoctorProfileColumnChanges; languages?: string[]; specialtyIds?: number[]; primarySpecialtyId?: number }
export interface ApplyResult { view: DoctorProfileView; created: boolean; status?: 200 | 201 | 202; identitySync?: "pending" | "failed" }
export type DoctorsRoute = "apply" | "getMe" | "updateMe" | "getApplication";
export type DoctorsPolicies = Readonly<Record<DoctorsRoute, UserPolicy>>;

/** Narrow row of the discovery candidate and page statements. */
export interface CandidateRow { id: number; user_id: number; consultation_fee: number; years_experience: number }
/** One bookable doctor as search ranks it. */
export interface Candidate { profileId: number; userId: number; fee: number; years: number }
export interface IndexDoctorRow { id: number; user_id: number; timezone: string }
/** A bookable doctor as the rank index and free-map computation need it. */
export interface IndexDoctor { profileId: number; userId: number; timezone: string }
/**
 * Search filters of the candidate statements; `namePrefix` is already normalised (lower-case) and matches the headline. `nameMatchedUserIds` are the
 * doctors whose display name matched in the derived name index; they match in addition to the headline term (intersected with the candidates by the SQL).
 */
export interface CandidateFilters { specialty?: string; language?: string; minFee?: number; maxFee?: number; namePrefix?: string; nameMatchedUserIds?: readonly number[] }
export interface CandidateAfter { value: number; id: number }
export interface CandidatePageParams { order: CandidateOrder; after: CandidateAfter | null; fetch: number }
/** A read capped at `CANDIDATE_HARD_CAP` rows: `truncated` says the cap was hit. */
export interface CappedList<T> { items: T[]; truncated: boolean }
export interface DoctorLanguageBatchRow { doctor_profile_id: number; language_code: string }
export interface DoctorSpecialtyBatchRow { doctor_profile_id: number; specialty_id: number; is_primary: boolean }
export interface PublicDoctorView { profile: DoctorProfile; languages: string[]; specialties: SpecialtyRef[]; activeTypes: ConsultationType[]; bookable: boolean }
