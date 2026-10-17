import type { PageMeta, StringCursorPosition } from "../../lib/http/pagination/types";
import type { UserPolicy } from "../../lib/rbac/types";
import type { Role } from "../../lib/types/types";
import type { PatientProfile } from "../patients/entity/patient-profile.entity";
import type { MedicalRecordAmendment } from "./entity/medical-record-amendment.entity";
import type { MedicalRecord } from "./entity/medical-record.entity";
import type { RecordField } from "./enums";

/** pg returns `TIMESTAMPTZ` as `Date`, `BIGINT` as number (type parser override) and `INT` as number. `is_locked` is derived in SQL. */
export interface MedicalRecordRow {
    id: number; consultation_id: number; patient_user_id: number; doctor_user_id: number; chief_complaint: string;
    examination_notes: string | null; diagnosis_text: string | null; diagnosis_code: string | null; treatment_plan: string | null;
    follow_up_in_days: number | null; locked_at: Date; is_locked: boolean; created_at: Date; updated_at: Date;
}
/** A timeline row with the microsecond cursor text of `created_at`. */
export interface MedicalRecordTimelineRow extends MedicalRecordRow { created_at_cursor: string }

export interface AmendmentRow {
    id: number; medical_record_id: number; author_user_id: number; chief_complaint: string | null; examination_notes: string | null;
    diagnosis_text: string | null; diagnosis_code: string | null; treatment_plan: string | null; follow_up_in_days: number | null;
    reason: string; created_at: Date;
}

/** The record members a client may set; every member is optional because `PATCH` sends any subset. */
export interface RecordChanges {
    chiefComplaint?: string; examinationNotes?: string; diagnosisText?: string; diagnosisCode?: string; treatmentPlan?: string; followUpInDays?: number;
}
/** A validated create body: the chief complaint is the one required member. */
export interface RecordCreateInput extends RecordChanges { chiefComplaint: string }
/** A validated `PATCH` body: `reason` is required only after the lock, so it stays optional here. */
export interface RecordUpdateInput { changes: RecordChanges; reason?: string }

/** What the create transaction inserts; both user ids are copied from the consultation, never from the body. */
export interface NewRecord { consultationId: number; patientUserId: number; doctorUserId: number; input: RecordCreateInput }
/** Changed columns of an in-place update (snake_case, only the fields that differ). */
export interface RecordColumnChanges {
    chief_complaint?: string; examination_notes?: string; diagnosis_text?: string; diagnosis_code?: string; treatment_plan?: string; follow_up_in_days?: number;
}
export interface RecordDiff { fields: RecordField[]; columns: RecordColumnChanges }
export interface NewAmendment { recordId: number; authorUserId: number; changes: RecordChanges; reason: string }

/** `unchanged` is the pre-lock no-op (R-D7): nothing written, nothing audited. */
export type RecordUpdateResult =
    | { kind: "updated" | "unchanged"; record: MedicalRecord }
    | { kind: "amended"; amendment: MedicalRecordAmendment };

/** No clinical text: what the ownership resolvers and the other modules need to decide access. */
export interface RecordAccessRow { id: number; patientUserId: number; doctorUserId: number }

/** The two user ids a write resolver needs; both `ConsultationParties` and `RecordAccessRow` satisfy it. */
export interface RecordParties { doctorUserId: number; patientUserId: number }

export interface RecordWithAmendments { record: MedicalRecord; amendments: MedicalRecordAmendment[] }
export interface PatientTimelineResult { patient: PatientProfile | null; items: RecordWithAmendments[]; meta: PageMeta }

/** A validated `GET /patients/{patientUserId}/records` query. */
export interface TimelineQuery { cursor: string | undefined; limit: number | undefined }
/** The repository `WHERE`, built from the path id and the decoded cursor. */
export interface TimelineFilter { patientUserId: number; after: StringCursorPosition | null; fetch: number }
export interface MedicalRecordListEntry { record: MedicalRecord; cursorTimestamp: string }

export interface RecordViewer { userId: number; role: Role }

export type RecordsRoute = "create" | "get" | "update" | "timeline";
export type RecordsPolicies = Readonly<Record<RecordsRoute, UserPolicy>>;
