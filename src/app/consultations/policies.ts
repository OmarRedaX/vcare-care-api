import type { AccessContext, OwnershipDecision, OwnershipRule } from "../../lib/rbac/types";
import { parsePositiveId } from "../../pkg/utils/id";
import { doctorNotSuspendedCheck } from "../doctors/checks";
import type { DoctorsService } from "../doctors/service/doctors.service";
import { isParticipant, isPatientOwner } from "./repository/consultations.repo";
import type { ConsultationsPolicies } from "./types";

/** Ownership resolver: the patient who booked it, the assigned doctor, or any admin (`x-ownership: participant-or-admin`). */
const participantOrAdmin: OwnershipRule = {
    kind: "resolver", name: "consultation_participant_or_admin",
    resolve: async ({ auth, params }: AccessContext): Promise<OwnershipDecision> => {
        const id = parsePositiveId(params.id);
        if (id === undefined) return "deny-not-found";
        // An admin passes without a query; the service answers 404 for an id that does not exist.
        if (auth.role === "admin") return "allow";
        return await isParticipant(id, auth.userId) ? "allow" : "deny-not-found";
    },
};

/** Ownership resolver: the patient who booked it, or any admin (`x-ownership: patient-owner-or-admin`). A doctor is never allowed. */
const patientOwnerOrAdmin: OwnershipRule = {
    kind: "resolver", name: "consultation_patient_or_admin",
    resolve: async ({ auth, params }: AccessContext): Promise<OwnershipDecision> => {
        const id = parsePositiveId(params.id);
        if (id === undefined) return "deny-not-found";
        if (auth.role === "admin") return "allow";
        return auth.role === "patient" && await isPatientOwner(id, auth.userId) ? "allow" : "deny-not-found";
    },
};

/**
 * Roles, ownership, account state and audit class of the five routes (mirrors `x-roles`, `x-ownership`, `x-account-state`,
 * `x-audit` of the contract). Booking needs `status=active` and a verified email; cancel adds the live local-suspension
 * check for a doctor. List and get-one keep working for a locally suspended doctor (own rows).
 */
export function buildConsultationsPolicies(doctors: Pick<DoctorsService, "isLocallySuspended">): ConsultationsPolicies {
    return {
        book: { kind: "user", roles: ["patient"], owner: { kind: "self" }, accountState: { emailVerified: true } },
        list: { kind: "user", roles: ["patient", "doctor", "admin"], owner: { kind: "none" } },
        get: { kind: "user", roles: ["patient", "doctor", "admin"], owner: participantOrAdmin, audit: "clinical-read" },
        reschedule: { kind: "user", roles: ["patient", "admin"], owner: patientOwnerOrAdmin, audit: "admin-action" },
        cancel: { kind: "user", roles: ["patient", "doctor", "admin"], owner: participantOrAdmin, checks: [doctorNotSuspendedCheck(doctors)], audit: "admin-action" },
    };
}
