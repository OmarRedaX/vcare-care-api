import { buildDoctorsPolicies } from "../../../../src/app/doctors/policies";
import type { DoctorsService } from "../../../../src/app/doctors/service/doctors.service";
import { contractOperationBlock, inlineLists } from "../../../helpers/contract";

const service = { isLocallySuspended: jest.fn().mockResolvedValue(false) } as unknown as Pick<DoctorsService, "isLocallySuspended">;

describe("doctor policies", () => {
    it("should declare roles, self ownership and statuses from each contract operation", () => {
        const policies = buildDoctorsPolicies(service);
        const operations = [
            ["apply", "/api/doctors/apply", "post"], ["getMe", "/api/doctors/me", "get"],
            ["updateMe", "/api/doctors/me", "patch"], ["getApplication", "/api/doctors/me/application", "get"],
        ] as const;
        for (const [name, path, method] of operations) {
            const contract = contractOperationBlock(path, method);
            expect(policies[name].roles).toEqual(inlineLists(contract, "x-roles")[0]);
            expect(policies[name].owner).toEqual({ kind: "self" });
            expect(contract).toContain("x-ownership: self");
            const statuses = contract.match(/x-account-state: 'status in \(([^)]*)\)/)?.[1]?.split(", ").map((value) => value.trim());
            expect(policies[name].accountState?.statuses?.doctor).toEqual(statuses);
        }
    });

    it("should attach the local suspension check only to updateMe", () => {
        const policies = buildDoctorsPolicies(service);
        expect(policies.updateMe.checks?.map((check) => check.name)).toEqual(["doctor_not_suspended"]);
        expect(policies.apply.checks).toBeUndefined();
        expect(policies.getMe.checks).toBeUndefined();
        expect(policies.getApplication.checks).toBeUndefined();
    });
});
