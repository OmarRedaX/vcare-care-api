import "reflect-metadata";
import { MedicalRecordResponseDto, PatientTimelineResponseDto } from "../../../../src/app/records/dto/records.response.dto";
import { isRedactedKey, redact } from "../../../../src/lib/logger/redact";
import { NO_STORE_PREFIXES } from "../../../../src/routes";
import { amendmentEntity, CHIEF, CLINICAL_MARKERS, DX_TEXT, NOTES, PLAN, REASON, recordEntity } from "./records.fixtures";

const doctorViewer = { userId: 202, role: "doctor" as const };

describe("record clinical text in log objects (defence in depth; the code never logs it)", () => {
    const full = recordEntity({ examinationNotes: NOTES, diagnosisText: DX_TEXT, diagnosisCode: "A00.1", treatmentPlan: PLAN, followUpInDays: 7, isLocked: true });

    it("should redact every clinical member of a record DTO that is logged by mistake", () => {
        const dto = MedicalRecordResponseDto.from(full, [amendmentEntity({ treatmentPlan: PLAN })], doctorViewer);
        const text = JSON.stringify(redact(dto));
        for (const marker of CLINICAL_MARKERS) expect(text).not.toContain(marker);
        expect(text).not.toContain("A00.1");
    });

    it("should redact the nested amendment reason through the amendments key", () => {
        const text = JSON.stringify(redact({ amendments: [{ id: 1, reason: REASON, diagnosisText: DX_TEXT }] }));
        expect(text).not.toContain(REASON);
        expect(text).not.toContain(DX_TEXT);
    });

    it("should redact the whole timeline DTO's clinical text", () => {
        const timeline = PatientTimelineResponseDto.from(null, [{ record: full, amendments: [amendmentEntity()] }], doctorViewer);
        const text = JSON.stringify(redact(timeline));
        for (const marker of CLINICAL_MARKERS) expect(text).not.toContain(marker);
    });

    it.each(["chiefComplaint", "followUpInDays", "amendments", "amendmentReason", "examinationNotes", "diagnosisText", "diagnosisCode", "treatmentPlan"])(
        "should redact the key %s", (key) => {
            expect(isRedactedKey(key)).toBe(true);
            expect((redact({ [key]: CHIEF }) as Record<string, unknown>)[key]).not.toBe(CHIEF);
        });

    it("should keep the bare reason key loggable because the access_denied line uses it and request bodies are never logged", () => {
        expect(isRedactedKey("reason")).toBe(false);
        expect(redact({ reason: "role" })).toEqual({ reason: "role" });
    });
});

describe("no-store prefixes", () => {
    it("should cover the records path so every record response is Cache-Control no-store, alongside the patient and consultation prefixes the other three routes live under", () => {
        expect(NO_STORE_PREFIXES).toEqual(expect.arrayContaining(["/api/records", "/api/consultations", "/api/patients"]));
    });
});
