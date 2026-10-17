export enum RecordAuditAction {
    Created = "record.created",
    Read = "record.read",
    Updated = "record.updated",
    Amended = "record.amended",
    TimelineListed = "patient_records.listed",
}

/** Wire names of the record members; `changedFields` / `providedFields` in audit metadata are lists of these (names, never values). */
export enum RecordField {
    ChiefComplaint = "chiefComplaint",
    ExaminationNotes = "examinationNotes",
    DiagnosisText = "diagnosisText",
    DiagnosisCode = "diagnosisCode",
    TreatmentPlan = "treatmentPlan",
    FollowUpInDays = "followUpInDays",
}
