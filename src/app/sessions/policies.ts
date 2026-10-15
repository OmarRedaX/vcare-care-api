import type { AccessContext, OwnershipDecision, OwnershipRule } from "../../lib/rbac/types";
import { parsePositiveId } from "../../pkg/utils/id";
import type { ConsultationRowsService } from "../consultations/service/consultation-rows.service";
import { doctorNotSuspendedCheck } from "../doctors/checks";
import type { DoctorsService } from "../doctors/service/doctors.service";
import type { SessionsPolicies } from "./types";

/** `x-ownership: participant`: the patient who booked it or the assigned doctor; anyone else is 404. */
function participantRule(rows: Pick<ConsultationRowsService, "isParticipant">): OwnershipRule {
    return {
        kind: "resolver", name: "consultation_participant",
        resolve: async ({ auth, params }: AccessContext): Promise<OwnershipDecision> => {
            const id = parsePositiveId(params.id);
            if (id === undefined) return "deny-not-found";
            return await rows.isParticipant(id, auth.userId) ? "allow" : "deny-not-found";
        },
    };
}

/** `x-ownership: assigned-doctor`: only the doctor on the row; other doctors are 404. */
function assignedDoctorRule(rows: Pick<ConsultationRowsService, "isAssignedDoctor">): OwnershipRule {
    return {
        kind: "resolver", name: "consultation_assigned_doctor",
        resolve: async ({ auth, params }: AccessContext): Promise<OwnershipDecision> => {
            const id = parsePositiveId(params.id);
            if (id === undefined) return "deny-not-found";
            return await rows.isAssignedDoctor(id, auth.userId) ? "allow" : "deny-not-found";
        },
    };
}

/** `x-ownership: assigned-doctor-or-admin`: an admin passes without a query (the service answers 404 for an unknown id). */
function assignedDoctorOrAdminRule(rows: Pick<ConsultationRowsService, "isAssignedDoctor">): OwnershipRule {
    return {
        kind: "resolver", name: "consultation_assigned_doctor_or_admin",
        resolve: async ({ auth, params }: AccessContext): Promise<OwnershipDecision> => {
            const id = parsePositiveId(params.id);
            if (id === undefined) return "deny-not-found";
            if (auth.role === "admin") return "allow";
            return await rows.isAssignedDoctor(id, auth.userId) ? "allow" : "deny-not-found";
        },
    };
}

/**
 * Roles, ownership, account state and audit class of the six session routes (mirrors `x-roles`, `x-ownership`, `x-account-state`,
 * `x-audit` of the contract). A locally suspended doctor is blocked at once; the admin no-show is exempt because the check
 * applies to doctors only.
 */
export function buildSessionsPolicies(doctors: Pick<DoctorsService, "isLocallySuspended">,
    rows: Pick<ConsultationRowsService, "isParticipant" | "isAssignedDoctor">): SessionsPolicies {
    const notSuspended = [doctorNotSuspendedCheck(doctors)];
    return {
        join: { kind: "user", roles: ["patient", "doctor"], owner: participantRule(rows), checks: notSuspended },
        start: { kind: "user", roles: ["doctor"], owner: assignedDoctorRule(rows), checks: notSuspended },
        complete: { kind: "user", roles: ["doctor"], owner: assignedDoctorRule(rows), checks: notSuspended },
        noShow: { kind: "user", roles: ["doctor", "admin"], owner: assignedDoctorOrAdminRule(rows), checks: notSuspended, audit: "admin-action" },
        waitingRoom: { kind: "user", roles: ["doctor"], owner: { kind: "self" }, checks: notSuspended },
        calendar: { kind: "user", roles: ["doctor"], owner: { kind: "self" }, checks: notSuspended },
    };
}
