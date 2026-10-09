import type { AuditPolicies } from "./types";

/** Admin only, ownership `none`, token `status=active` (default). Reading the audit log writes no audit row, hence no `audit` class. */
export const AUDIT_POLICIES: AuditPolicies = {
    list: { kind: "user", roles: ["admin"], owner: { kind: "none" } },
};
