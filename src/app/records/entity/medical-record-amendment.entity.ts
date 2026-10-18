export class MedicalRecordAmendment {
    id!: number;
    /** `medical_record_id`. */
    recordId!: number;
    /** Identity user id. */
    authorUserId!: number;
    /** Clinical text of the amended fields only; a field that was not amended is `null`. */
    chiefComplaint!: string | null;
    examinationNotes!: string | null;
    diagnosisText!: string | null;
    diagnosisCode!: string | null;
    treatmentPlan!: string | null;
    followUpInDays!: number | null;
    /** Clinical free text: never logged, never in audit metadata (only its length). */
    reason!: string;
    createdAt!: Date;

    constructor(data: Partial<MedicalRecordAmendment>) { Object.assign(this, data); }
}
