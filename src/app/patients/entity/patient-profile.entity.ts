import type { BloodType, Gender } from "../enums";

export class PatientProfile {
    id!: number;
    userId!: number;
    dateOfBirth!: string | null;
    gender!: Gender | null;
    bloodType!: BloodType | null;
    allergies!: string[];
    chronicConditions!: string[];
    timezone!: string;
    createdAt!: Date;
    updatedAt!: Date;

    constructor(data: Partial<PatientProfile>) { Object.assign(this, data); }
}
