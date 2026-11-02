import { HELP_ARTICLES_POLICIES } from "../../../../src/app/help-articles/policies";
import type { HelpArticlesRoute } from "../../../../src/app/help-articles/types";
import { authorize } from "../../../../src/lib/rbac/authorize";
import { contractOperationBlock } from "../../../helpers/contract";

type Method = "get" | "post" | "patch" | "delete";
const ROUTES: Array<[HelpArticlesRoute, string, Method]> = [
    ["list", "/api/help-articles", "get"],
    ["get", "/api/help-articles/{id}", "get"],
    ["create", "/api/help-articles", "post"],
    ["update", "/api/help-articles/{id}", "patch"],
    ["remove", "/api/help-articles/{id}", "delete"],
];

describe("HELP_ARTICLES_POLICIES", () => {
    it.each(ROUTES)("should equal the contract x-roles, x-ownership and x-audit for %s", (route, path, method) => {
        const block = contractOperationBlock(path, method);
        const roles = block.match(/^ {6}x-roles: \[([^\]]+)\]$/m)?.[1]?.split(", ");
        const ownership = block.match(/^ {6}x-ownership: (\S+)$/m)?.[1];
        const audit = block.match(/^ {6}x-audit: (\S+)$/m)?.[1];
        const policy = HELP_ARTICLES_POLICIES[route];
        expect(roles).toBeDefined();
        expect(policy.roles).toEqual(roles);
        expect(ownership).toBe("none");
        expect(policy.owner).toEqual({ kind: ownership });
        expect(policy.audit).toBe(audit);
    });

    it("should admit doctor pending, active and rejected only on the two reads, read from x-account-state (HA-D14, HA-R16)", () => {
        for (const [route, path, method] of ROUTES.filter(([name]) => name === "list" || name === "get")) {
            const accountState = contractOperationBlock(path, method).match(/^ {6}x-account-state: '([^']+)'$/m)?.[1];
            expect(accountState).toContain("patient and admin active");
            const doctorStatuses = accountState?.match(/doctor status in \(([^)]+)\)/)?.[1]?.split(", ");
            expect(doctorStatuses).toEqual(["pending", "active", "rejected"]);
            expect(HELP_ARTICLES_POLICIES[route].accountState?.statuses).toEqual({ doctor: doctorStatuses });
        }
    });

    it("should leave the account state at the active default for the three writes (HA-R16)", () => {
        for (const route of ["create", "update", "remove"] as const) {
            expect(HELP_ARTICLES_POLICIES[route].accountState).toBeUndefined();
        }
    });

    it("should allow only the admin role on the writes and all three roles on the reads (HA-R15)", () => {
        expect(HELP_ARTICLES_POLICIES.list.roles).toEqual(["patient", "doctor", "admin"]);
        expect(HELP_ARTICLES_POLICIES.get.roles).toEqual(["patient", "doctor", "admin"]);
        for (const route of ["create", "update", "remove"] as const) {
            expect(HELP_ARTICLES_POLICIES[route].roles).toEqual(["admin"]);
            expect(HELP_ARTICLES_POLICIES[route].audit).toBe("admin-action");
        }
    });

    it("should build without throwing via authorize (valid at boot)", () => {
        for (const policy of Object.values(HELP_ARTICLES_POLICIES)) {
            expect(() => authorize(policy)).not.toThrow();
        }
    });
});
