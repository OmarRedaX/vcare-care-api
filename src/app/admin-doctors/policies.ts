import type { UserPolicy } from "../../lib/rbac/types";
import type { AdminDoctorsPolicies } from "./types";

/**
 * Admin only (`x-roles: [admin]`, `x-ownership: none`), token `status=active` (default). A doctor (including the target
 * doctor), a patient and an anonymous caller are denied by `authorize`; the role is named explicitly, there is no wildcard.
 */
export function buildAdminDoctorsPolicies(): AdminDoctorsPolicies {
    const adminAction: UserPolicy = { kind: "user", roles: ["admin"], owner: { kind: "none" }, audit: "admin-action" };
    return { suspend: adminAction, reinstate: adminAction };
}
