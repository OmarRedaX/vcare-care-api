import type { PatientProfile } from "../entity/patient-profile.entity";
import type { PatientProfileViewer } from "../types";

export class PatientProfileResponseDto {
    id!: number;
    userId!: number;
    dateOfBirth!: string | null;
    gender!: string | null;
    bloodType!: string | null;
    allergies!: string[];
    chronicConditions!: string[];
    timezone!: string;
    createdAt!: string;
    updatedAt!: string;
    /** Clinical fields leave only to the owning patient; any other viewer (admin included) is a programming error. */
    static from(entity: PatientProfile, viewer: PatientProfileViewer): PatientProfileResponseDto {
        if (viewer.role !== "patient" || viewer.userId !== entity.userId) throw new Error("patient_profile_viewer_not_permitted");
        return {
            id: entity.id, userId: entity.userId, dateOfBirth: entity.dateOfBirth, gender: entity.gender, bloodType: entity.bloodType,
            allergies: [...entity.allergies], chronicConditions: [...entity.chronicConditions], timezone: entity.timezone,
            createdAt: entity.createdAt.toISOString(), updatedAt: entity.updatedAt.toISOString(),
        };
    }
}
