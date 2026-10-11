import type { UserPolicy } from "../../lib/rbac/types";
import type { Role } from "../../lib/types/types";
import type { BloodType, Gender, PatientProfileField } from "./enums";

export interface PatientProfileRow {
    id: number; user_id: number; date_of_birth: string | null; gender: Gender | null; blood_type: BloodType | null;
    allergies: string[]; chronic_conditions: string[]; timezone: string; created_at: Date; updated_at: Date;
}
export interface PatientProfileInput {
    dateOfBirth: string | null; gender: Gender | null; bloodType: BloodType | null;
    allergies: string[]; chronicConditions: string[]; timezone: string;
}
export interface PatientProfileChanges {
    dateOfBirth?: string | null; gender?: Gender | null; bloodType?: BloodType | null;
    allergies?: string[]; chronicConditions?: string[]; timezone?: string;
}
export interface PatientProfileColumnChanges {
    date_of_birth?: string | null; gender?: Gender | null; blood_type?: BloodType | null;
    allergies?: string[]; chronic_conditions?: string[]; timezone?: string;
}
export interface PatientProfileDiff { fields: PatientProfileField[]; columns: PatientProfileColumnChanges }
export interface PatientProfileViewer { userId: number; role: Role }
/**
 * Port: does this doctor have a booked/waiting/in_progress/completed consultation with this patient? Implemented by the
 * `consultations` module (bound to `TOKENS.PatientRelationship` in `bootstrap.ts`); `patients` never imports its repository.
 */
export interface PatientRelationshipChecker {
    hasConsultationRelationship(doctorUserId: number, patientUserId: number): Promise<boolean>;
}
export type PatientsRoute = "getMe" | "updateMe";
export type PatientsPolicies = Readonly<Record<PatientsRoute, UserPolicy>>;
