import { buildSchedulesPolicies } from "../../../../src/app/schedules/policies";
import type { SchedulesRoute } from "../../../../src/app/schedules/types";
import type { DoctorsService } from "../../../../src/app/doctors/service/doctors.service";
import { contractOperationBlock, inlineLists } from "../../../helpers/contract";

const isLocallySuspended = jest.fn<Promise<boolean>, [number]>();
const doctors = { isLocallySuspended } as unknown as Pick<DoctorsService, "isLocallySuspended">;

const OPERATIONS: Array<[SchedulesRoute, string, "get" | "put" | "post" | "delete" | "patch"]> = [
    ["getWorkingHours", "/api/doctors/me/working-hours", "get"],
    ["replaceWorkingHours", "/api/doctors/me/working-hours", "put"],
    ["listExceptions", "/api/doctors/me/exceptions", "get"],
    ["createException", "/api/doctors/me/exceptions", "post"],
    ["deleteException", "/api/doctors/me/exceptions/{id}", "delete"],
    ["listTypes", "/api/doctors/me/consultation-types", "get"],
    ["createType", "/api/doctors/me/consultation-types", "post"],
    ["updateType", "/api/doctors/me/consultation-types/{id}", "patch"],
];

describe("schedules policies", () => {
    const policies = buildSchedulesPolicies(doctors);

    it("should define exactly the eight routes", () => {
        expect(Object.keys(policies).sort()).toEqual(OPERATIONS.map(([name]) => name).sort());
    });

    it.each(OPERATIONS)("should declare doctor-only, self ownership and active status for %s as the contract does", (name, apiPath, method) => {
        const contract = contractOperationBlock(apiPath, method);
        expect(policies[name].kind).toBe("user");
        expect(policies[name].roles).toEqual(inlineLists(contract, "x-roles")[0]);
        expect(policies[name].roles).toEqual(["doctor"]);
        expect(contract).toContain("x-ownership: self");
        expect(policies[name].owner).toEqual({ kind: "self" });
        expect(contract).toContain("x-account-state: 'status active; not locally suspended'");
        expect(policies[name].accountState).toEqual({ statuses: { doctor: ["active"] } });
    });

    it.each(OPERATIONS)("should attach the doctor_not_suspended check to %s", (name) => {
        expect(policies[name].checks?.map((check) => check.name)).toEqual(["doctor_not_suspended"]);
        expect(policies[name].checks?.[0]?.appliesTo).toEqual(["doctor"]);
    });

    it.each(OPERATIONS)("should use the admin-action audit class on %s exactly where the contract declares x-audit", (name, apiPath, method) => {
        const declared = contractOperationBlock(apiPath, method).includes("x-audit: admin-action");
        expect(policies[name].audit === "admin-action").toBe(declared);
        if (!declared) expect(policies[name].audit).toBeUndefined();
    });

    it("should declare admin-action on PUT working hours, POST exceptions and DELETE exception only", () => {
        const audited = OPERATIONS.filter(([name]) => policies[name].audit === "admin-action").map(([name]) => name).sort();
        expect(audited).toEqual(["createException", "deleteException", "replaceWorkingHours"]);
    });

    it("should deny a locally suspended doctor and allow others through the check", async () => {
        const check = policies.getWorkingHours.checks?.[0];
        isLocallySuspended.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        const context = { auth: { userId: 202, role: "doctor", status: "active", emailVerified: true } } as never;
        await expect(check?.run(context)).resolves.toBe("deny-forbidden");
        await expect(check?.run(context)).resolves.toBe("allow");
        expect(isLocallySuspended).toHaveBeenCalledWith(202);
    });
});
