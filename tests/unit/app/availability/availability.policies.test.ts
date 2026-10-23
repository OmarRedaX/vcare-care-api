import { AVAILABILITY_POLICIES } from "../../../../src/app/availability/policies";
import { contractOperationBlock, inlineLists } from "../../../helpers/contract";

describe("availability policies", () => {
    it("should allow exactly patient and admin access with no ownership restriction when reading slots", () => {
        const block = contractOperationBlock("/api/doctors/{doctorUserId}/slots", "get");
        expect(Object.keys(AVAILABILITY_POLICIES)).toEqual(["slots"]);
        expect(AVAILABILITY_POLICIES.slots).toEqual({ kind: "user", roles: ["patient", "admin"], owner: { kind: "none" } });
        expect(AVAILABILITY_POLICIES.slots.roles).toEqual(inlineLists(block, "x-roles")[0]);
        expect(block).toContain("x-ownership: none");
    });
});
