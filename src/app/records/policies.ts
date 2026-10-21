import type { AccessContext, OwnershipDecision, OwnershipRule } from "../../lib/rbac/types";
import { parsePositiveId } from "../../pkg/utils/id";
import type { ConsultationRowsService } from "../consultations/service/consultation-rows.service";
import { doctorNotSuspendedCheck } from "../doctors/checks";
import type { DoctorsService } from "../doctors/service/doctors.service";
import type { PatientRelationshipChecker } from "../patients/types";
import type { RecordLinksService } from "./service/record-links.service";
import type { RecordParties, RecordsPolicies } from "./types";

/**
 * `x-ownership: assigned-doctor` on create (`record_write_consultation`, owner decision M1): ONLY the consultation's assigned doctor passes.
 * Every other caller, whether or not they hold a relationship with the patient and whatever the consultation's status, gets `404`
 * identical to an absent id: the patient timeline lists only consultations that already have a record, so any other answer would be an
 * existence oracle for the patient's record-less consultations.
 */
function createResolver(rows: Pick<ConsultationRowsService, "findParties">): OwnershipRule {
    return {
        kind: "resolver", name: "record_write_consultation",
        resolve: async ({ auth, params }: AccessContext): Promise<OwnershipDecision> => {
            const id = parsePositiveId(params.id);
            if (id === undefined) return "deny-not-found";
            const row = await rows.findParties(id);
            return row !== undefined && row.doctorUserId === auth.userId ? "allow" : "deny-not-found";
        },
    };
}

/**
 * `x-ownership: assigned-doctor` on `PATCH /records/{id}` (`record_write_record`): visible to the record's author OR to a doctor who holds
 * a booked/waiting/in_progress/completed consultation with the patient. The service then answers `NotAssignedDoctor` (403) for the
 * latter; an unrelated doctor gets `404`. A related doctor already sees every record id in the patient's timeline, so the 403 reveals
 * nothing new.
 */
function updateResolver(find: (id: number) => Promise<RecordParties | undefined>, relationship: PatientRelationshipChecker): OwnershipRule {
    return {
        kind: "resolver", name: "record_write_record",
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

/** `x-ownership: consulted-patient-or-self` on `GET /records/{id}` (resolver `record_reader`): the record patient, its author, or a doctor with a consultation relationship to the patient. */
export function recordReaderRule(doctors: Pick<DoctorsService, "isLocallySuspended">, links: Pick<RecordLinksService, "findAccessRow">,
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
        create: { kind: "user", roles: ["doctor"], owner: createResolver(rows), checks: notSuspended, audit: "clinical-write" },
        update: { kind: "user", roles: ["doctor"], owner: updateResolver((id) => links.findAccessRow(id), relationship), checks: notSuspended, audit: "clinical-write" },
        get: { kind: "user", roles: ["patient", "doctor"], owner: recordReaderRule(doctors, links, relationship), audit: "clinical-read" },
        timeline: { kind: "user", roles: ["patient", "doctor"], owner: timelineReaderRule(doctors, relationship), audit: "clinical-read" },
    };
}
