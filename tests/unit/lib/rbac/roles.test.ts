import { ACCOUNT_STATUSES, isAccountStatus, isRole, ROLES } from "../../../../src/lib/rbac/roles";
import type { AccountStatus, Role } from "../../../../src/lib/types/types";

/**
 * `Record<Union, true>` literals fail to compile when a member is missing or extra, so these objects ARE the unions;
 * the runtime arrays must list exactly their keys.
 */
const ROLE_UNION: Record<Role, true> = { patient: true, doctor: true, admin: true };
const STATUS_UNION: Record<AccountStatus, true> = { pending: true, active: true, rejected: true, suspended: true };

describe("lib/rbac/roles", () => {
    it("should keep ROLES and ACCOUNT_STATUSES equal to the lib/types unions", () => {
        expect([...ROLES].sort()).toEqual(Object.keys(ROLE_UNION).sort());
        expect([...ACCOUNT_STATUSES].sort()).toEqual(Object.keys(STATUS_UNION).sort());
    });

    it("should accept exactly the listed roles and statuses", () => {
        for (const role of ROLES) {
            expect(isRole(role)).toBe(true);
        }
        for (const status of ACCOUNT_STATUSES) {
            expect(isAccountStatus(status)).toBe(true);
        }
        for (const value of ["Admin", "superuser", "", null, undefined, 1, {}]) {
            expect(isRole(value)).toBe(false);
            expect(isAccountStatus(value)).toBe(false);
        }
    });
});
