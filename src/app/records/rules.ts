import type { MedicalRecord } from "./entity/medical-record.entity";
import { RecordField } from "./enums";
import type { RecordChanges, RecordColumnChanges, RecordDiff } from "./types";

/** The record members present in `changes`, in a fixed order: audit metadata lists field NAMES, never values. */
export function providedFields(changes: RecordChanges): RecordField[] {
    const fields: RecordField[] = [];
    if (changes.chiefComplaint !== undefined) fields.push(RecordField.ChiefComplaint);
    if (changes.examinationNotes !== undefined) fields.push(RecordField.ExaminationNotes);
    if (changes.diagnosisText !== undefined) fields.push(RecordField.DiagnosisText);
    if (changes.diagnosisCode !== undefined) fields.push(RecordField.DiagnosisCode);
    if (changes.treatmentPlan !== undefined) fields.push(RecordField.TreatmentPlan);
    if (changes.followUpInDays !== undefined) fields.push(RecordField.FollowUpInDays);
    return fields;
}

/**
 * Pre-lock diff (R-D7): the provided members whose value differs from the stored one (strict equality; a stored `null` against a value
 * counts). Equal members are dropped, so a request that changes nothing is a no-op with no write and no audit row.
 */
export function diffRecord(current: MedicalRecord, changes: RecordChanges): RecordDiff {
    const fields: RecordField[] = [];
    const columns: RecordColumnChanges = {};
    if (changes.chiefComplaint !== undefined && changes.chiefComplaint !== current.chiefComplaint) {
        fields.push(RecordField.ChiefComplaint); columns.chief_complaint = changes.chiefComplaint;
    }
    if (changes.examinationNotes !== undefined && changes.examinationNotes !== current.examinationNotes) {
        fields.push(RecordField.ExaminationNotes); columns.examination_notes = changes.examinationNotes;
    }
    if (changes.diagnosisText !== undefined && changes.diagnosisText !== current.diagnosisText) {
        fields.push(RecordField.DiagnosisText); columns.diagnosis_text = changes.diagnosisText;
    }
    if (changes.diagnosisCode !== undefined && changes.diagnosisCode !== current.diagnosisCode) {
        fields.push(RecordField.DiagnosisCode); columns.diagnosis_code = changes.diagnosisCode;
    }
    if (changes.treatmentPlan !== undefined && changes.treatmentPlan !== current.treatmentPlan) {
        fields.push(RecordField.TreatmentPlan); columns.treatment_plan = changes.treatmentPlan;
    }
    if (changes.followUpInDays !== undefined && changes.followUpInDays !== current.followUpInDays) {
        fields.push(RecordField.FollowUpInDays); columns.follow_up_in_days = changes.followUpInDays;
    }
    return { fields, columns };
}
