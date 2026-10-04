import { SPECIALTIES_POLICIES } from "../../../../src/app/specialties/policies";
import { authorize } from "../../../../src/lib/rbac/authorize";

describe("SPECIALTIES_POLICIES", () => {
    it("should declare roles and owner none per contract x-roles and x-ownership for each route", () => {
        expect(SPECIALTIES_POLICIES.list.roles).toEqual(["patient", "doctor", "admin"]);
        expect(SPECIALTIES_POLICIES.create.roles).toEqual(["admin"]);
        expect(SPECIALTIES_POLICIES.update.roles).toEqual(["admin"]);
        for (const policy of Object.values(SPECIALTIES_POLICIES)) {
            expect(policy.owner).toEqual({ kind: "none" });
        }
    });

    it("should admit doctor pending, active, and rejected only on list (S4)", () => {
        expect(SPECIALTIES_POLICIES.list.accountState?.statuses).toEqual({ doctor: ["pending", "active", "rejected"] });
        expect(SPECIALTIES_POLICIES.create.accountState).toBeUndefined();
        expect(SPECIALTIES_POLICIES.update.accountState).toBeUndefined();
    });

    it("should classify both writes as admin-action audit", () => {
        expect(SPECIALTIES_POLICIES.create.audit).toBe("admin-action");
        expect(SPECIALTIES_POLICIES.update.audit).toBe("admin-action");
    });

    it("should build without throwing via authorize (valid at boot)", () => {
        for (const policy of Object.values(SPECIALTIES_POLICIES)) {
            expect(() => authorize(policy)).not.toThrow();
        }
    });
});
