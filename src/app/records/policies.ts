import type { AccessContext, OwnershipDecision, OwnershipRule } from "../../lib/rbac/types";
import { parsePositiveId } from "../../pkg/utils/id";
import type { ConsultationRowsService } from "../consultations/service/consultation-rows.service";
import { doctorNotSuspendedCheck } from "../doctors/checks";
import type { DoctorsService } from "../doctors/service/doctors.service";
import type { PatientRelationshipChecker } from "../patients/types";
import type { RecordLinksService } from "./service/record-links.service";
import type { RecordParties, RecordsPolicies } from "./types";

/**
 * Write resolvers (`x-ownership: assigned-doctor`): visible to the assigned doctor OR to a doctor who holds a booked/waiting/in_progress/
 * completed consultation with the patient. The service then answers `NotAssignedDoctor` (403) for the latter; an unrelated doctor gets
 * `404`. A related doctor can already read the patient whole timeline, so the 403 reveals nothing new.
 */
function writeResolver(name: string, find: (id: number) => Promise<RecordParties | undefined>, relationship: PatientRelationshipChecker): OwnershipRule {
    return {
        kind: "resolver", name,
        resolve: async ({ auth, params }: AccessContext): Promise<OwnershipDecision> => {
            const id = parsePositiveId(params.id);
            if (id === undefined) return "deny-not-found";
            const row = await find(id);
            if (row === undefined) return "deny-not-found";
            if (row.doctorUserId === auth.userId) return "allow";
            return await relationship.hasConsultationRelationship(auth.userId, row.patientUserId) ? "allow" : "deny-not-found";
        },
    };
}

/**
 * Read resolvers fold local suspension into ownership (R-D5): a suspended doctor gets `404` on every read, authored records included,
 * while the patient and other consulted doctors still read them. Admins are absent from the role lists, so they never reach a resolver.
 */
async function isSuspended(userId: number, doctors: Pick<DoctorsService, "isLocallySuspended">): Promise<boolean> {
    return doctors.isLocallySuspended(userId);
}

/** `x-ownership: record-reader`: the record patient, its author, or a doctor with a consultation relationship to the patient. */
function recordReaderRule(doctors: Pick<DoctorsService, "isLocallySuspended">, links: Pick<RecordLinksService, "findAccessRow">,
    relationship: PatientRelationshipChecker): OwnershipRule {
    return {
        kind: "resolver", name: "record_reader",
        resolve: async ({ auth, params }: AccessContext): Promise<OwnershipDecision> => {
            const id = parsePositiveId(params.id);
            if (id === undefined) return "deny-not-found";
            const row = await links.findAccessRow(id);
            if (row === undefined) return "deny-not-found";
            if (auth.role === "patient") return row.patientUserId === auth.userId ? "allow" : "deny-not-found";
            if (auth.role !== "doctor") return "deny-forbidden";
            if (await isSuspended(auth.userId, doctors)) return "deny-not-found";
            if (row.doctorUserId === auth.userId) return "allow";
            return await relationship.hasConsultationRelationship(auth.userId, row.patientUserId) ? "allow" : "deny-not-found";
        },
    };
}

/**
 * `x-ownership: consulted-patient-or-self`: the patient themself, or a doctor with a relationship to that patient. Separate from
 * `consulted_patient_or_self` of `patients` because a suspended doctor is answered `404` here (R-D5), not `403`. `me` and any other
 * non-numeric id is `404`.
 */
function timelineReaderRule(doctors: Pick<DoctorsService, "isLocallySuspended">, relationship: PatientRelationshipChecker): OwnershipRule {
    return {
        kind: "resolver", name: "records_timeline_reader",
        resolve: async ({ auth, params }: AccessContext): Promise<OwnershipDecision> => {
            const patientUserId = parsePositiveId(params.patientUserId);
            if (patientUserId === undefined) return "deny-not-found";
            if (auth.role === "patient") return auth.userId === patientUserId ? "allow" : "deny-not-found";
            if (auth.role !== "doctor") return "deny-forbidden";
            if (await isSuspended(auth.userId, doctors)) return "deny-not-found";
            return await relationship.hasConsultationRelationship(auth.userId, patientUserId) ? "allow" : "deny-not-found";
        },
    };
}

/**
 * Roles, ownership, account state and audit class of the four record routes (mirrors `x-roles`, `x-ownership`, `x-account-state`,
 * `x-audit` of the contract). Admins are absent from every role list: `403` at the role step, before any lookup. Writes carry the live
 * local-suspension check (`403 Forbidden`); reads fold it into the resolver (`404`). Patients need `status=active` only.
 */
export function buildRecordsPolicies(doctors: Pick<DoctorsService, "isLocallySuspended">, rows: Pick<ConsultationRowsService, "findParties">,
    links: Pick<RecordLinksService, "findAccessRow">, relationship: PatientRelationshipChecker): RecordsPolicies {
    const notSuspended = [doctorNotSuspendedCheck(doctors)];
    return {
        create: { kind: "user", roles: ["doctor"], owner: writeResolver("record_write_consultation", (id) => rows.findParties(id), relationship), checks: notSuspended, audit: "clinical-write" },
        update: { kind: "user", roles: ["doctor"], owner: writeResolver("record_write_record", (id) => links.findAccessRow(id), relationship), checks: notSuspended, audit: "clinical-write" },
        get: { kind: "user", roles: ["patient", "doctor"], owner: recordReaderRule(doctors, links, relationship), audit: "clinical-read" },
        timeline: { kind: "user", roles: ["patient", "doctor"], owner: timelineReaderRule(doctors, relationship), audit: "clinical-read" },
    };
}
