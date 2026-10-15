import type { UserPolicy } from "../../lib/rbac/types";
import { parsePositiveId } from "../../pkg/utils/id";
import { doctorNotSuspendedCheck } from "../doctors/checks";
import type { DoctorsService } from "../doctors/service/doctors.service";
import type { PatientRelationshipChecker, PatientsPolicies } from "./types";

export const PATIENTS_POLICIES: PatientsPolicies = {
    getMe: { kind: "user", roles: ["patient"], owner: { kind: "self" }, audit: "clinical-read" },
    updateMe: { kind: "user", roles: ["patient"], owner: { kind: "self" }, audit: "clinical-write" },
};

/**
 * `GET /patients/{patientUserId}` (`x-ownership: consulted-patient-or-self`): the patient themself, or a doctor with a
 * booked/waiting/in_progress/completed consultation with that patient. Everyone else (a malformed id included) gets 404; an
 * admin never passes the role check; a locally suspended doctor is stopped by the check before ownership.
 */
export function buildPatientByIdPolicy(relationship: PatientRelationshipChecker, doctors: Pick<DoctorsService, "isLocallySuspended">): UserPolicy {
    return {
        kind: "user", roles: ["patient", "doctor"], audit: "clinical-read", checks: [doctorNotSuspendedCheck(doctors)],
        owner: {
            kind: "resolver", name: "consulted_patient_or_self",
            resolve: async ({ auth, params }) => {
                const patientUserId = parsePositiveId(params.patientUserId);
                if (patientUserId === undefined) return "deny-not-found";
                if (auth.role === "patient") return auth.userId === patientUserId ? "allow" : "deny-not-found";
                if (auth.role === "doctor") return await relationship.hasConsultationRelationship(auth.userId, patientUserId) ? "allow" : "deny-not-found";
                return "deny-forbidden";
            },
        },
    };
}
