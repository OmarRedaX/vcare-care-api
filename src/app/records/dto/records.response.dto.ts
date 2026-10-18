import { PatientProfileResponseDto } from "../../patients/dto/patients.response.dto";
import type { PatientProfile } from "../../patients/entity/patient-profile.entity";
import type { MedicalRecordAmendment } from "../entity/medical-record-amendment.entity";
import type { MedicalRecord } from "../entity/medical-record.entity";
import type { RecordViewer, RecordWithAmendments } from "../types";

/**
 * Clinical text leaves only to the record's patient and to doctors (the ownership policy decided which, before this runs). An admin
 * viewer is a programming error, and so is a patient who is not the record's patient: no DTO has an admin form (Domain rule 19).
 */
function assertClinicalViewer(viewer: RecordViewer, patientUserId: number): void {
    if (viewer.role === "admin" || (viewer.role === "patient" && viewer.userId !== patientUserId)) throw new Error("medical_record_viewer_not_permitted");
}

export class MedicalRecordAmendmentResponseDto {
    id!: number;
    recordId!: number;
    authorUserId!: number;
    chiefComplaint!: string | null;
    examinationNotes!: string | null;
    diagnosisText!: string | null;
    diagnosisCode!: string | null;
    treatmentPlan!: string | null;
    followUpInDays!: number | null;
    reason!: string;
    createdAt!: string;

    /** The record's patient sees the reason too. The viewer is checked against the record by `MedicalRecordResponseDto`, the create path passes the doctor. */
    static from(entity: MedicalRecordAmendment, viewer: RecordViewer): MedicalRecordAmendmentResponseDto {
        if (viewer.role === "admin") throw new Error("medical_record_viewer_not_permitted");
        return {
            id: entity.id, recordId: entity.recordId, authorUserId: entity.authorUserId, chiefComplaint: entity.chiefComplaint,
            examinationNotes: entity.examinationNotes, diagnosisText: entity.diagnosisText, diagnosisCode: entity.diagnosisCode,
            treatmentPlan: entity.treatmentPlan, followUpInDays: entity.followUpInDays, reason: entity.reason, createdAt: entity.createdAt.toISOString(),
        };
    }
}

export class MedicalRecordResponseDto {
    id!: number;
    consultationId!: number;
    patientUserId!: number;
    doctorUserId!: number;
    chiefComplaint!: string;
    examinationNotes!: string | null;
    diagnosisText!: string | null;
    diagnosisCode!: string | null;
    treatmentPlan!: string | null;
    followUpInDays!: number | null;
    lockedAt!: string;
    isLocked!: boolean;
    amendments!: MedicalRecordAmendmentResponseDto[];
    /** Always `[]` until the `record-attachments` module ships; no response carries a URL, an object key or a file field. */
    attachments!: never[];
    createdAt!: string;
    updatedAt!: string;

    /** `amendments` are the record's amendments, oldest first (empty on create and on a pre-lock no-op). */
    static from(entity: MedicalRecord, amendments: readonly MedicalRecordAmendment[], viewer: RecordViewer): MedicalRecordResponseDto {
        assertClinicalViewer(viewer, entity.patientUserId);
        return {
            id: entity.id, consultationId: entity.consultationId, patientUserId: entity.patientUserId, doctorUserId: entity.doctorUserId,
            chiefComplaint: entity.chiefComplaint, examinationNotes: entity.examinationNotes, diagnosisText: entity.diagnosisText,
            diagnosisCode: entity.diagnosisCode, treatmentPlan: entity.treatmentPlan, followUpInDays: entity.followUpInDays,
            lockedAt: entity.lockedAt.toISOString(), isLocked: entity.isLocked,
            amendments: amendments.map((amendment) => MedicalRecordAmendmentResponseDto.from(amendment, viewer)), attachments: [],
            createdAt: entity.createdAt.toISOString(), updatedAt: entity.updatedAt.toISOString(),
        };
    }
}

export class PatientTimelineResponseDto {
    patient!: PatientProfileResponseDto | null;
    records!: MedicalRecordResponseDto[];

    /** `patient` is `null` when the patient has no profile row yet (booking needs none); otherwise the profile as `GET /patients/{id}` renders it. */
    static from(profile: PatientProfile | null, items: readonly RecordWithAmendments[], viewer: RecordViewer): PatientTimelineResponseDto {
        if (viewer.role === "admin") throw new Error("medical_record_viewer_not_permitted");
        return {
            patient: profile === null ? null : PatientProfileResponseDto.from(profile, viewer),
            records: items.map((item) => MedicalRecordResponseDto.from(item.record, item.amendments, viewer)),
        };
    }
}
