import { MedicalRecordAmendment } from "../../../../src/app/records/entity/medical-record-amendment.entity";
import { MedicalRecord } from "../../../../src/app/records/entity/medical-record.entity";
import type { AuthContext } from "../../../../src/lib/types/types";

/** Synthetic markers: they must never reach audit metadata, logs or an error body. */
export const CHIEF = "SYNTHETIC-CHIEF-6601";
export const NOTES = "SYNTHETIC-NOTES-6602";
export const DX_TEXT = "SYNTHETIC-DXTEXT-6603";
export const PLAN = "SYNTHETIC-PLAN-6604";
export const REASON = "SYNTHETIC-AMEND-REASON-6605";
export const CLINICAL_MARKERS = [CHIEF, NOTES, DX_TEXT, PLAN, REASON];

export const NOW = Date.parse("2030-01-01T10:00:00Z");
export const patient: AuthContext = { userId: 101, role: "patient", status: "active", emailVerified: true };
export const otherPatient: AuthContext = { userId: 102, role: "patient", status: "active", emailVerified: true };
export const doctor: AuthContext = { userId: 202, role: "doctor", status: "active", emailVerified: true };
export const otherDoctor: AuthContext = { userId: 204, role: "doctor", status: "active", emailVerified: true };
export const admin: AuthContext = { userId: 303, role: "admin", status: "active", emailVerified: true };

export function recordEntity(changes: Partial<MedicalRecord> = {}): MedicalRecord {
    return new MedicalRecord({
        id: 9, consultationId: 7, patientUserId: 101, doctorUserId: 202, chiefComplaint: CHIEF, examinationNotes: NOTES, diagnosisText: null,
        diagnosisCode: null, treatmentPlan: null, followUpInDays: null, lockedAt: new Date(NOW + 86_400_000), isLocked: false,
        createdAt: new Date(NOW), updatedAt: new Date(NOW), ...changes,
    });
}

export function amendmentEntity(changes: Partial<MedicalRecordAmendment> = {}): MedicalRecordAmendment {
    return new MedicalRecordAmendment({
        id: 31, recordId: 9, authorUserId: 202, chiefComplaint: null, examinationNotes: null, diagnosisText: DX_TEXT, diagnosisCode: null,
        treatmentPlan: null, followUpInDays: null, reason: REASON, createdAt: new Date(NOW + 90_000_000), ...changes,
    });
}

/** A pg-like error carrying a SQLSTATE and a constraint name. */
export function pgError(code: string, constraint?: string): Error {
    return Object.assign(new Error("synthetic pg error"), constraint === undefined ? { code } : { code, constraint });
}
