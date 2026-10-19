import type { AccessContext, OwnershipDecision, OwnershipRule } from "../../lib/rbac/types";
import { parsePositiveId } from "../../pkg/utils/id";
import { doctorNotSuspendedCheck } from "../doctors/checks";
import type { DoctorsService } from "../doctors/service/doctors.service";
import type { PatientRelationshipChecker } from "../patients/types";
import { recordReaderRule } from "../records/policies";
import type { RecordLinksService } from "../records/service/record-links.service";
import type { RecordAttachmentsPolicies } from "./types";

/**
 * `x-ownership: record-author` (`record_attachment_writer`): ONLY the record's author passes (RA-D2). A related or stranger doctor, an
 * absent record and a non-numeric id are indistinguishable (`404`), so no id existence leaks. The resolver sees only `auth` and the path
 * params, never the body.
 */
function recordAuthorRule(links: Pick<RecordLinksService, "findAccessRow">): OwnershipRule {
    return {
        kind: "resolver", name: "record_attachment_writer",
        resolve: async ({ auth, params }: AccessContext): Promise<OwnershipDecision> => {
            const id = parsePositiveId(params.id);
            if (id === undefined) return "deny-not-found";
            const row = await links.findAccessRow(id);
            return row !== undefined && row.doctorUserId === auth.userId ? "allow" : "deny-not-found";
        },
    };
}

/**
 * Roles, ownership, account state and audit class of the four attachment routes (mirrors `x-roles`, `x-ownership`, `x-account-state`,
 * `x-audit` of the contract). Admins are absent from every role list: `403` at the role step, before any lookup. The three writes carry
 * the live local-suspension check (`403 Forbidden`); `download-url` reuses the records reader resolver, which folds suspension into
 * ownership (`404`, records R-D5). Patients need `status=active` only.
 */
export function buildRecordAttachmentsPolicies(doctors: Pick<DoctorsService, "isLocallySuspended">, links: Pick<RecordLinksService, "findAccessRow">,
    relationship: PatientRelationshipChecker): RecordAttachmentsPolicies {
    const notSuspended = [doctorNotSuspendedCheck(doctors)];
    return {
        createIntent: { kind: "user", roles: ["doctor"], owner: recordAuthorRule(links), checks: notSuspended },
        complete: { kind: "user", roles: ["doctor"], owner: recordAuthorRule(links), checks: notSuspended, audit: "clinical-write" },
        remove: { kind: "user", roles: ["doctor"], owner: recordAuthorRule(links), checks: notSuspended, audit: "clinical-write" },
        downloadUrl: { kind: "user", roles: ["patient", "doctor"], owner: recordReaderRule(doctors, links, relationship), audit: "clinical-read" },
    };
}
