import { AVAILABILITY_POLICIES } from "../../../../src/app/availability/policies";
import { contractOperationBlock, inlineLists } from "../../../helpers/contract";

describe("availability policies (AV-R2)", () => {
    const routes = [
        ["slots", "/api/doctors/{doctorUserId}/slots"],
        ["search", "/api/doctors"],
        ["getDoctor", "/api/doctors/{doctorUserId}"],
    ] as const;

    it("should declare exactly the three discovery routes", () => {
        expect(Object.keys(AVAILABILITY_POLICIES)).toEqual(["slots", "search", "getDoctor"]);
    });

    it.each(routes)("should allow exactly patient and admin with no ownership restriction for %s, matching the contract", (route, apiPath) => {
        const block = contractOperationBlock(apiPath, "get");
        expect(AVAILABILITY_POLICIES[route]).toEqual({ kind: "user", roles: ["patient", "admin"], owner: { kind: "none" } });
        expect(AVAILABILITY_POLICIES[route].roles).toEqual(inlineLists(block, "x-roles")[0]);
        expect(block).toContain("x-ownership: none");
    });
});
