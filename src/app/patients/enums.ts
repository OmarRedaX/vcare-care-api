export enum Gender { Female = "female", Male = "male", Other = "other", Undisclosed = "undisclosed" }
export enum BloodType {
    APositive = "A+", ANegative = "A-", BPositive = "B+", BNegative = "B-", AbPositive = "AB+", AbNegative = "AB-",
    OPositive = "O+", ONegative = "O-", Unknown = "unknown",
}
export enum PatientAuditAction { Read = "patient_profile.read", Updated = "patient_profile.updated" }
/** Wire names of the profile members. */
export enum PatientProfileField {
    DateOfBirth = "dateOfBirth", Gender = "gender", BloodType = "bloodType", Allergies = "allergies",
    ChronicConditions = "chronicConditions", Timezone = "timezone",
}
