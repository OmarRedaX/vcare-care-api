import { RecordField } from "../../../../src/app/records/enums";
import { diffRecord, providedFields } from "../../../../src/app/records/rules";
import { CHIEF, DX_TEXT, NOTES, PLAN, recordEntity } from "./records.fixtures";

describe("providedFields", () => {
    it("should list only the members present, in the fixed order, as wire names", () => {
        expect(providedFields({ followUpInDays: 3, chiefComplaint: CHIEF, treatmentPlan: PLAN, diagnosisCode: "A00", diagnosisText: DX_TEXT, examinationNotes: NOTES }))
            .toEqual([RecordField.ChiefComplaint, RecordField.ExaminationNotes, RecordField.DiagnosisText, RecordField.DiagnosisCode, RecordField.TreatmentPlan, RecordField.FollowUpInDays]);
        expect(providedFields({ treatmentPlan: PLAN })).toEqual(["treatmentPlan"]);
    });

    it("should return nothing for an empty change set and never include a value", () => {
        expect(providedFields({})).toEqual([]);
        expect(JSON.stringify(providedFields({ chiefComplaint: CHIEF, examinationNotes: NOTES }))).not.toContain("SYNTHETIC");
    });

    it("should count a member that is present with a falsy value (zero is still provided)", () => {
        expect(providedFields({ followUpInDays: 0 })).toEqual(["followUpInDays"]);
    });
});

describe("diffRecord (pre-lock no-op rule, R-D7)", () => {
    const current = recordEntity({ chiefComplaint: CHIEF, examinationNotes: NOTES, diagnosisText: null, diagnosisCode: "A00", treatmentPlan: null, followUpInDays: 7 });

    it("should report no difference when every provided value equals the stored one", () => {
        expect(diffRecord(current, { chiefComplaint: CHIEF, examinationNotes: NOTES, diagnosisCode: "A00", followUpInDays: 7 })).toEqual({ fields: [], columns: {} });
        expect(diffRecord(current, {})).toEqual({ fields: [], columns: {} });
    });

    it("should report only the members that differ, with their snake_case columns", () => {
        expect(diffRecord(current, { chiefComplaint: "SYNTHETIC-CHIEF-OTHER", examinationNotes: NOTES, followUpInDays: 8 })).toEqual({
            fields: ["chiefComplaint", "followUpInDays"], columns: { chief_complaint: "SYNTHETIC-CHIEF-OTHER", follow_up_in_days: 8 },
        });
    });

    it("should count a value against a stored null as a change", () => {
        expect(diffRecord(current, { diagnosisText: DX_TEXT, treatmentPlan: PLAN })).toEqual({
            fields: ["diagnosisText", "treatmentPlan"], columns: { diagnosis_text: DX_TEXT, treatment_plan: PLAN },
        });
    });

    it("should compare strictly: a different case or trailing space is a change", () => {
        expect(diffRecord(current, { diagnosisCode: "a00" }).fields).toEqual(["diagnosisCode"]);
        expect(diffRecord(current, { chiefComplaint: `${CHIEF} ` }).fields).toEqual(["chiefComplaint"]);
    });

    it("should never touch the stored record", () => {
        const before = JSON.stringify(current);
        diffRecord(current, { chiefComplaint: "SYNTHETIC-CHIEF-OTHER" });
        expect(JSON.stringify(current)).toBe(before);
    });
});
