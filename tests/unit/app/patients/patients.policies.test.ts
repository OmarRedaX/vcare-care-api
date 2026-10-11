import { PATIENTS_POLICIES } from "../../../../src/app/patients/policies";
import { contractOperationBlock, contractResponseCodes, inlineLists } from "../../../helpers/contract";

describe("patients policies", () => {
    it.each([["getMe", "get", "clinical-read"], ["updateMe", "patch", "clinical-write"]] as const)(
        "should declare roles, self ownership and %s audit class from the contract", (name, method, audit) => {
            const contract = contractOperationBlock("/api/patients/me", method);
            expect(PATIENTS_POLICIES[name].roles).toEqual(inlineLists(contract, "x-roles")[0]);
            expect(PATIENTS_POLICIES[name].roles).toEqual(["patient"]);
            expect(PATIENTS_POLICIES[name].owner).toEqual({ kind: "self" });
            expect(contract).toContain("x-ownership: self");
            expect(contract).toContain(`x-audit: ${audit}`);
            expect(PATIENTS_POLICIES[name].audit).toBe(audit);
        });

    it("should keep the default active-account rule when no account-state override is declared", () => {
        for (const policy of Object.values(PATIENTS_POLICIES)) {
            expect(policy.accountState).toBeUndefined();
            expect(policy.checks).toBeUndefined();
        }
        expect(contractOperationBlock("/api/patients/me", "get")).not.toContain("x-account-state");
        expect(contractOperationBlock("/api/patients/me", "patch")).not.toContain("x-account-state");
    });

    it("should declare 200 only for PATCH and 404 only for GET in the contract", () => {
        expect(contractResponseCodes("/api/patients/me", "patch").sort()).toEqual(["200", "400", "401", "403", "429", "500"]);
        expect(contractResponseCodes("/api/patients/me", "get").sort()).toEqual(["200", "401", "403", "404", "429", "500"]);
    });
});
