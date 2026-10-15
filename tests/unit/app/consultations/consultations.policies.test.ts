import "reflect-metadata";
import { buildConsultationsPolicies } from "../../../../src/app/consultations/policies";
import { buildPatientByIdPolicy } from "../../../../src/app/patients/policies";
import type { AccessContext, OwnershipRule } from "../../../../src/lib/rbac/types";
import { contractOperationBlock, inlineLists } from "../../../helpers/contract";

const doctors = { isLocallySuspended: () => Promise.resolve(false) };
const policies = buildConsultationsPolicies(doctors);
const ctx = (role: "patient" | "doctor" | "admin", userId: number, params: Record<string, string>): AccessContext => ({ auth: { userId, role, status: "active", emailVerified: true }, params });
const resolve = (owner: OwnershipRule, context: AccessContext) => {
    if (owner.kind !== "resolver") throw new Error("expected a resolver");
    return owner.resolve(context);
};

describe("consultations policies", () => {
    it.each([
        ["book", "post", "/api/consultations"],
        ["list", "get", "/api/consultations"],
        ["get", "get", "/api/consultations/{id}"],
        ["reschedule", "patch", "/api/consultations/{id}/reschedule"],
        ["cancel", "patch", "/api/consultations/{id}/cancel"],
    ] as const)("should declare the %s roles from the contract", (name, method, path) => {
        const contract = contractOperationBlock(path, method);
        expect([...policies[name].roles]).toEqual(inlineLists(contract, "x-roles")[0]);
    });

    it("should require a verified email only for booking and the live suspension check only for cancel", () => {
        expect(policies.book.accountState).toEqual({ emailVerified: true });
        expect(policies.book.owner).toEqual({ kind: "self" });
        expect(policies.cancel.checks?.map((check) => check.name)).toEqual(["doctor_not_suspended"]);
        for (const name of ["book", "list", "get", "reschedule"] as const) expect(policies[name].checks).toBeUndefined();
        expect(policies.get.audit).toBe("clinical-read");
        expect(policies.reschedule.audit).toBe("admin-action");
        expect(policies.cancel.audit).toBe("admin-action");
    });

    it("should hide a non-numeric id from every role with 404 and let an admin through without a query", async () => {
        for (const name of ["get", "reschedule", "cancel"] as const) {
            expect(await resolve(policies[name].owner, ctx("admin", 303, { id: "abc" }))).toBe("deny-not-found");
            expect(await resolve(policies[name].owner, ctx("patient", 101, { id: "0" }))).toBe("deny-not-found");
            expect(await resolve(policies[name].owner, ctx("admin", 303, { id: "999999" }))).toBe("allow");
        }
    });

    it("should never let a doctor reschedule", async () => {
        expect(await resolve(policies.reschedule.owner, ctx("doctor", 202, { id: "1" }))).toBe("deny-not-found");
        expect(policies.reschedule.roles).not.toContain("doctor");
    });
});

describe("patients getById policy", () => {
    const relationship = { hasConsultationRelationship: (doctor: number, patient: number) => Promise.resolve(doctor === 202 && patient === 101) };
    const policy = buildPatientByIdPolicy(relationship, doctors);

    it("should allow only patient and doctor roles, audit as a clinical read and check local suspension", () => {
        expect([...policy.roles]).toEqual(["patient", "doctor"]);
        expect(policy.audit).toBe("clinical-read");
        expect(policy.checks?.map((check) => check.name)).toEqual(["doctor_not_suspended"]);
        expect([...policy.roles]).toEqual(inlineLists(contractOperationBlock("/api/patients/{patientUserId}", "get"), "x-roles")[0]);
    });

    it("should resolve self, related doctor, unrelated doctor, other patient and malformed id", async () => {
        expect(await resolve(policy.owner, ctx("patient", 101, { patientUserId: "101" }))).toBe("allow");
        expect(await resolve(policy.owner, ctx("patient", 102, { patientUserId: "101" }))).toBe("deny-not-found");
        expect(await resolve(policy.owner, ctx("doctor", 202, { patientUserId: "101" }))).toBe("allow");
        expect(await resolve(policy.owner, ctx("doctor", 204, { patientUserId: "101" }))).toBe("deny-not-found");
        expect(await resolve(policy.owner, ctx("doctor", 202, { patientUserId: "abc" }))).toBe("deny-not-found");
        expect(await resolve(policy.owner, ctx("admin", 303, { patientUserId: "101" }))).toBe("deny-forbidden");
    });
});
