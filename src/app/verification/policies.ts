import { UploadIntentKind } from "../upload-intents/enums";
import type { UploadIntentsService } from "../upload-intents/service/upload-intents.service";
import { findDocument, findProfileById, isProfileLocallySuspended } from "./repository/verification.repo";
import type { VerificationPolicies } from "./types";
import type { AccessContext } from "../../lib/rbac/types";
import { parsePositiveId } from "../../pkg/utils/id";
import { ValidationFailed } from "../../lib/error/errors";

function pathId(value: string | undefined, field: string): number {
    const id = parsePositiveId(value);
    if (id === undefined) throw ValidationFailed.withDetails([{ field, issue: "must be a positive integer" }]);
    return id;
}

/** The intent lookup is a port: a policy never imports another module's repository (ADR 0022). */
export function buildVerificationPolicies(intents: Pick<UploadIntentsService, "findIntent">): VerificationPolicies {
    const doctorState = { statuses: { doctor: ["pending", "active", "rejected"] as const } };
    const doctorCheck = { name: "doctor_not_suspended", appliesTo: ["doctor"] as const, run: async ({ auth }: AccessContext) => await isProfileLocallySuspended(auth.userId) ? "deny-forbidden" as const : "allow" as const };
    const doctor = { kind: "user" as const, roles: ["doctor"] as const, owner: { kind: "self" as const }, accountState: doctorState, checks: [doctorCheck] };
    const admin = { kind: "user" as const, roles: ["admin"] as const, owner: { kind: "none" as const } };
    const ownedDocument = { kind: "resolver" as const, name: "verification_document_owner", resolve: async ({ auth, params }: AccessContext) => { const document = await findDocument(pathId(params.documentId, "documentId")); const profile = document && await findProfileById(document.doctorProfileId); return profile?.userId === auth.userId ? "allow" as const : "deny-not-found" as const; } };
    const ownedIntent = { kind: "resolver" as const, name: "verification_intent_owner", resolve: async ({ auth, params }: AccessContext) => { const intent = await intents.findIntent(pathId(params.uploadId, "uploadId")); const profile = intent && await findProfileById(intent.target_id); return intent?.kind === UploadIntentKind.VerificationDocument && intent.owner_user_id === auth.userId && profile?.userId === auth.userId ? "allow" as const : "deny-not-found" as const; } };
    const adminDocument = { kind: "resolver" as const, name: "verification_application_document", resolve: async ({ params }: AccessContext) => { const documentId = pathId(params.documentId, "documentId"); const applicationId = pathId(params.id, "id"); const document = await findDocument(documentId); const profile = await findProfileById(applicationId); return document && profile && document.doctorProfileId === profile.id ? "allow" as const : "deny-not-found" as const; } };
    return { createIntent: doctor, complete: { ...doctor, owner: ownedIntent }, myDownload: { ...doctor, owner: ownedDocument }, myDelete: { ...doctor, owner: ownedDocument }, queue: admin, detail: admin, adminDownload: { ...admin, owner: adminDocument }, approve: admin, reject: admin, reopen: admin };
}
