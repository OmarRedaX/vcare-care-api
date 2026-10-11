import { BloodType, Gender } from "../../../../src/app/patients/enums";
import { PatientProfile } from "../../../../src/app/patients/entity/patient-profile.entity";
import { PatientProfileResponseDto } from "../../../../src/app/patients/dto/patients.response.dto";
import { inlineLists, schemaBlock } from "../../../helpers/contract";

const entity = (): PatientProfile => new PatientProfile({ id: 4, userId: 101, dateOfBirth: "1990-05-17", gender: Gender.Female, bloodType: BloodType.OPositive,
    allergies: ["TEST-ALLERGEN-A", "TEST-ALLERGEN-B"], chronicConditions: ["TEST-CONDITION-A"], timezone: "Africa/Cairo",
    createdAt: new Date("2026-10-11T10:00:00.123Z"), updatedAt: new Date("2026-10-11T11:00:00.456Z") });

describe("PatientProfileResponseDto", () => {
    it("should emit exactly the contract's PatientProfile required keys when the owner views it", () => {
        const [required = []] = inlineLists(schemaBlock("PatientProfile"), "required");
        expect(Object.keys(PatientProfileResponseDto.from(entity(), { userId: 101, role: "patient" })).sort()).toEqual([...required].sort());
    });

    it("should emit nullable members as null and millisecond ISO timestamps with Z", () => {
        const sparse = new PatientProfile({ ...entity(), dateOfBirth: null, gender: null, bloodType: null, allergies: [], chronicConditions: [] });
        const dto = PatientProfileResponseDto.from(sparse, { userId: 101, role: "patient" });
        expect(dto).toMatchObject({ dateOfBirth: null, gender: null, bloodType: null, allergies: [], chronicConditions: [],
            createdAt: "2026-10-11T10:00:00.123Z", updatedAt: "2026-10-11T11:00:00.456Z" });
    });

    it("should copy the lists and keep their stored order so later mutation cannot reach the entity", () => {
        const source = entity();
        const dto = PatientProfileResponseDto.from(source, { userId: 101, role: "patient" });
        expect(dto.allergies).toEqual(["TEST-ALLERGEN-A", "TEST-ALLERGEN-B"]);
        dto.allergies.push("x");
        expect(source.allergies).toHaveLength(2);
    });

    it.each([["admin", 101], ["doctor", 101], ["patient", 999]] as const)("should throw for a %s viewer with user id %s", (role, userId) => {
        expect(() => PatientProfileResponseDto.from(entity(), { userId, role })).toThrow("patient_profile_viewer_not_permitted");
    });
});
