export class MedicalRecord {
    id!: number;
    consultationId!: number;
    /** Identity user id, copied from the consultation. */
    patientUserId!: number;
    /** Identity user id, copied from the consultation. */
    doctorUserId!: number;
    /** Clinical text: never logged, never in an admin response (no admin form exists). */
    chiefComplaint!: string;
    examinationNotes!: string | null;
    diagnosisText!: string | null;
    diagnosisCode!: string | null;
    treatmentPlan!: string | null;
    followUpInDays!: number | null;
    lockedAt!: Date;
    /** `locked_at <= NOW()`, derived in SQL with the database clock (the trigger's clock), never with Node's. */
    isLocked!: boolean;
    createdAt!: Date;
    updatedAt!: Date;

    constructor(data: Partial<MedicalRecord>) { Object.assign(this, data); }
}
