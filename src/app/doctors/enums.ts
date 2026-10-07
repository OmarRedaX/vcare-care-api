export enum VerificationStatus { Draft = "draft", Submitted = "submitted", Approved = "approved", Rejected = "rejected" }
export enum IdentitySyncStatus { NotRequired = "not_required", Pending = "pending", Synced = "synced", Failed = "failed" }
export enum DoctorAuditAction { ProfileCreated = "doctor.profile_created", ProfileUpdated = "doctor.profile_updated" }
export enum DoctorProfileField {
    Headline = "headline", Bio = "bio", YearsExperience = "yearsExperience", Languages = "languages",
    Specialties = "specialtyIds", PrimarySpecialty = "primarySpecialtyId", ConsultationFee = "consultationFee",
    DefaultSlotMinutes = "defaultSlotMinutes", Timezone = "timezone", IsAcceptingPatients = "isAcceptingPatients",
}
