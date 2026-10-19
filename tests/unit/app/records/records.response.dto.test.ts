import "reflect-metadata";
import { BloodType, Gender } from "../../../../src/app/patients/enums";
import { PatientProfile } from "../../../../src/app/patients/entity/patient-profile.entity";
import { MedicalRecordAmendmentResponseDto, MedicalRecordResponseDto, PatientTimelineResponseDto } from "../../../../src/app/records/dto/records.response.dto";
import { amendmentEntity, CHIEF, DX_TEXT, NOTES, NOW, PLAN, REASON, recordEntity } from "./records.fixtures";

const patientViewer = { userId: 101, role: "patient" as const };
const doctorViewer = { userId: 202, role: "doctor" as const };
const otherDoctorViewer = { userId: 204, role: "doctor" as const };
const otherPatientViewer = { userId: 102, role: "patient" as const };
const adminViewer = { userId: 303, role: "admin" as const };
const ALLERGEN = "SYNTHETIC-ALLERGEN-5521";

const RECORD_KEYS = ["amendments", "attachments", "chiefComplaint", "consultationId", "createdAt", "diagnosisCode", "diagnosisText", "doctorUserId", "examinationNotes",
    "followUpInDays", "id", "isLocked", "lockedAt", "patientUserId", "treatmentPlan", "updatedAt"];
const AMENDMENT_KEYS = ["authorUserId", "chiefComplaint", "createdAt", "diagnosisCode", "diagnosisText", "examinationNotes", "followUpInDays", "id", "reason", "recordId", "treatmentPlan"];

const profile = (): PatientProfile => new PatientProfile({
    id: 4, userId: 101, dateOfBirth: "1990-01-02", gender: Gender.Female, bloodType: BloodType.OPositive, allergies: [ALLERGEN], chronicConditions: [], timezone: "Africa/Cairo",
    createdAt: new Date(NOW), updatedAt: new Date(NOW),
});

describe("MedicalRecordResponseDto", () => {
    it("should render the contract members with ISO instants, null for absent optional fields and an empty attachments list", () => {
        const dto = MedicalRecordResponseDto.from(recordEntity(), [], [], doctorViewer);
        expect(Object.keys(dto).sort()).toEqual(RECORD_KEYS);
        expect(dto).toMatchObject({ id: 9, consultationId: 7, patientUserId: 101, doctorUserId: 202, chiefComplaint: CHIEF, examinationNotes: NOTES,
            diagnosisText: null, diagnosisCode: null, treatmentPlan: null, followUpInDays: null, isLocked: false, amendments: [], attachments: [],
            lockedAt: new Date(NOW + 86_400_000).toISOString(), createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() });
    });

    it("should give the owning patient, the author and a consulted doctor the same shape", () => {
        const shapes = [patientViewer, doctorViewer, otherDoctorViewer].map((viewer) => JSON.stringify(MedicalRecordResponseDto.from(recordEntity(), [amendmentEntity()], [], viewer)));
        expect(new Set(shapes).size).toBe(1);
    });

    it("should refuse an admin viewer because no DTO has an admin form", () => {
        expect(() => MedicalRecordResponseDto.from(recordEntity(), [], [], adminViewer)).toThrow("medical_record_viewer_not_permitted");
    });

    it("should refuse a patient viewer who is not the record patient", () => {
        expect(() => MedicalRecordResponseDto.from(recordEntity(), [], [], otherPatientViewer)).toThrow("medical_record_viewer_not_permitted");
    });

    it("should carry the lock flag exactly as the entity holds it (computed by the database, never by the DTO)", () => {
        expect(MedicalRecordResponseDto.from(recordEntity({ isLocked: true, lockedAt: new Date(NOW - 1) }), [], [], doctorViewer).isLocked).toBe(true);
        expect(MedicalRecordResponseDto.from(recordEntity({ isLocked: false, lockedAt: new Date(NOW - 1) }), [], [], doctorViewer).isLocked).toBe(false);
    });

    it("should keep the amendments in the order given and render each with null for the fields that were not amended", () => {
        const first = amendmentEntity({ id: 1 });
        const second = amendmentEntity({ id: 2, diagnosisText: null, followUpInDays: 30 });
        const dto = MedicalRecordResponseDto.from(recordEntity({ isLocked: true }), [first, second], [], patientViewer);
        expect(dto.amendments.map((amendment) => amendment.id)).toEqual([1, 2]);
        expect(dto.amendments[0]).toMatchObject({ diagnosisText: DX_TEXT, chiefComplaint: null, examinationNotes: null, diagnosisCode: null, treatmentPlan: null, followUpInDays: null });
        expect(dto.amendments[1]).toMatchObject({ diagnosisText: null, followUpInDays: 30 });
    });

    it("should render the attachments given as metadata only, oldest first as passed, for the patient and the doctor alike", () => {
        const attachments = [
            { id: 1, recordId: 9, fileType: "application/pdf", sizeBytes: 100, attachmentDescription: null, createdAt: new Date(NOW) },
            { id: 2, recordId: 9, fileType: "image/png", sizeBytes: 200, attachmentDescription: "SYNTHETIC-ATTACH-DESC-0001", createdAt: new Date(NOW + 1000) },
        ];
        for (const viewer of [patientViewer, doctorViewer]) {
            const dto = MedicalRecordResponseDto.from(recordEntity(), [], attachments, viewer);
            expect(dto.attachments.map((attachment) => attachment.id)).toEqual([1, 2]);
            expect(dto.attachments[0]).toEqual({ id: 1, recordId: 9, fileType: "application/pdf", sizeBytes: 100, description: null, createdAt: new Date(NOW).toISOString() });
            expect(Object.keys(dto.attachments[1] ?? {}).sort()).toEqual(["createdAt", "description", "fileType", "id", "recordId", "sizeBytes"]);
            const json = JSON.stringify(dto);
            for (const forbidden of ["objectKey", "object_key", "uploadedByUserId", "downloadUrl", "deletedAt", "http"]) expect(json).not.toContain(forbidden);
        }
    });

    it("should render each timeline record with its own attachments", () => {
        const one = { id: 1, recordId: 12, fileType: "image/jpeg", sizeBytes: 5, attachmentDescription: null, createdAt: new Date(NOW) };
        const dto = PatientTimelineResponseDto.from(null, [{ record: recordEntity({ id: 12 }), amendments: [], attachments: [one] }, { record: recordEntity({ id: 11 }), amendments: [], attachments: [] }], doctorViewer);
        expect(dto.records.map((record) => record.attachments.length)).toEqual([1, 0]);
    });

    it("should never expose a url, object key, file field, deletion stamp or another internal member", () => {
        const json = JSON.stringify(MedicalRecordResponseDto.from(recordEntity({ deletedAt: new Date(NOW) } as never), [amendmentEntity()], [], doctorViewer));
        for (const forbidden of ["downloadUrl", "objectKey", "object_key", "url", "deletedAt", "deleted_at", "http"]) expect(json).not.toContain(forbidden);
    });
});

describe("MedicalRecordAmendmentResponseDto", () => {
    it("should render the contract members and show the reason to the patient and the doctor", () => {
        for (const viewer of [patientViewer, doctorViewer]) {
            const dto = MedicalRecordAmendmentResponseDto.from(amendmentEntity({ treatmentPlan: PLAN }), viewer);
            expect(Object.keys(dto).sort()).toEqual(AMENDMENT_KEYS);
            expect(dto).toMatchObject({ id: 31, recordId: 9, authorUserId: 202, diagnosisText: DX_TEXT, treatmentPlan: PLAN, reason: REASON,
                createdAt: new Date(NOW + 90_000_000).toISOString() });
        }
    });

    it("should refuse an admin viewer", () => {
        expect(() => MedicalRecordAmendmentResponseDto.from(amendmentEntity(), adminViewer)).toThrow("medical_record_viewer_not_permitted");
    });
});

describe("PatientTimelineResponseDto", () => {
    it("should render the profile and the records newest first as given, each with its amendments", () => {
        const dto = PatientTimelineResponseDto.from(profile(), [
            { record: recordEntity({ id: 12 }), amendments: [], attachments: [] }, { record: recordEntity({ id: 11, isLocked: true }), amendments: [amendmentEntity({ recordId: 11 })], attachments: [] },
        ], doctorViewer);
        expect(Object.keys(dto).sort()).toEqual(["patient", "records"]);
        expect(dto.records.map((record) => record.id)).toEqual([12, 11]);
        expect(dto.records[1]?.amendments).toHaveLength(1);
        expect(dto.patient).toMatchObject({ userId: 101, allergies: [ALLERGEN], timezone: "Africa/Cairo" });
    });

    it("should render patient null when the patient has no profile row yet", () => {
        const dto = PatientTimelineResponseDto.from(null, [{ record: recordEntity(), amendments: [], attachments: [] }], doctorViewer);
        expect(dto.patient).toBeNull();
        expect(dto.records).toHaveLength(1);
    });

    it("should render an empty page", () => {
        expect(PatientTimelineResponseDto.from(null, [], patientViewer)).toEqual({ patient: null, records: [] });
    });

    it("should refuse an admin viewer even for an empty page", () => {
        expect(() => PatientTimelineResponseDto.from(null, [], adminViewer)).toThrow("medical_record_viewer_not_permitted");
        expect(() => PatientTimelineResponseDto.from(profile(), [], adminViewer)).toThrow("medical_record_viewer_not_permitted");
    });

    it("should refuse a patient viewer who is not the patient of the profile or of a record", () => {
        expect(() => PatientTimelineResponseDto.from(profile(), [], otherPatientViewer)).toThrow();
        expect(() => PatientTimelineResponseDto.from(null, [{ record: recordEntity(), amendments: [], attachments: [] }], otherPatientViewer)).toThrow("medical_record_viewer_not_permitted");
    });
});
